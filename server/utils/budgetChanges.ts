import { and, eq, or } from 'drizzle-orm'
import { BUDGET_TERM } from '../../shared/constants'
import { flowOf } from '../../shared/budgetCompile'
import type { BudgetItemInput } from '../../shared/schemas'
import type { BudgetChangeRequest, BudgetItemRow, BudgetLine, BudgetTeam } from '../db/schema'
import type { SessionUser } from './auth'

/**
 * ②予算変更申請DB。集約とは別に、今の予算（①の承認済みの最新の行）の項目を直す・足す・消す。
 * 支出の項目だけ（収入の予算は②を通さず、集約で変える）。申請 → 管理者か ZAI の zas が承認すると①に行を足す（作成者は承認した人）。補正予算の集約中は⑦にも行を足す。
 * 承認する人は直接変更できる（申請と承認を同時に行った扱い）。足したら、執行依頼で選ぶ予算を作り直す。
 */

/** 今の予算の局・担当（最新の確定した集約の局・担当）と、今の予算の項目 */
export async function currentBudget() {
  const db = useDb()
  const [rows, round] = await Promise.all([currentRows(), latestConfirmedRound()])
  const teams = round ? (await teamsOf(round.id)).teams : []
  return { round, teams, rows }
}

/** 執行依頼・収入の記録で使われている項目か（使われていると、削除も番号の振り直しもしない） */
export async function isExecuted(row: Pick<BudgetItemRow, 'itemId' | 'itemNumber'>) {
  const db = useDb()
  const [item] = await db.select({ id: schema.entryItems.id }).from(schema.entryItems).where(or(eq(schema.entryItems.itemId, row.itemId), eq(schema.entryItems.itemNumber, row.itemNumber))).limit(1)
  if (item) return true
  const [entry] = await db.select({ id: schema.entries.id }).from(schema.entries).where(eq(schema.entries.itemNumber, row.itemNumber)).limit(1)
  if (entry) return true
  const [income] = await db.select({ id: schema.incomeRecords.id }).from(schema.incomeRecords).where(or(eq(schema.incomeRecords.itemId, row.itemId), eq(schema.incomeRecords.itemNumber, row.itemNumber))).limit(1)
  return !!income
}

const INCOME_NOT_CHANGEABLE = '収入の予算は、予算の変更では変えられません。本予算・補正予算の集約で変えてください。'

/** 変更を確かめる（担当と項目があるか、執行依頼で使われていないか）。申請するときと反映するときに使う */
export async function checkChange(change: { kind: BudgetChangeRequest['kind'], bureau: string, team: string, itemNumber: string, itemId?: string, after: unknown }) {
  const { teams, rows } = await currentBudget()
  const team = teams.find(t => t.bureau === change.bureau && t.team === change.team)
    ?? (rows.some(r => r.bureau === change.bureau && r.team === change.team) ? { bureauNo: '', bureau: change.bureau, team: change.team } as BudgetTeam : null)
  if (!team) throw createError({ statusCode: 404, message: '担当が見つかりません。' })
  if (change.kind === 'add') {
    if ((change.after as { flow?: unknown } | null)?.flow === 'income') throw createError({ statusCode: 400, message: INCOME_NOT_CHANGEABLE })
    return { team, row: null, rows }
  }
  const row = rows.find(r => (change.itemId ? r.itemId === change.itemId : r.itemNumber === change.itemNumber) && r.bureau === change.bureau && r.team === change.team)
  if (!row) throw createError({ statusCode: 404, message: '変える項目が予算に見つかりません（ほかの変更で消えた可能性があります）。' })
  if (flowOf(row.itemNumber) === 'income') throw createError({ statusCode: 400, message: INCOME_NOT_CHANGEABLE })
  if (change.kind === 'delete' && await isExecuted(row)) {
    throw createError({ statusCode: 409, message: 'この項目は執行依頼で使われているので、削除できません。' })
  }
  return { team, row, rows }
}

/** 承認待ちの変更がすでにある項目なら 409（同じ項目に申請が重ならないように） */
export async function assertNoPending(itemId: string) {
  if (!itemId) return
  const found = await useDb().query.budgetChangeRequests.findFirst({
    where: and(eq(schema.budgetChangeRequests.itemId, itemId), eq(schema.budgetChangeRequests.status, 'pending')),
  })
  if (found) throw createError({ statusCode: 409, message: 'この項目には承認待ちの変更があります。承認か却下を待つか、取り下げてから申請してください。' })
}

/** 変更を承認して①に行を足す（補正予算の集約中は⑦にも）。執行依頼で選ぶ予算を作り直す */
export async function applyChange(change: BudgetChangeRequest, user: SessionUser, comment = '') {
  const db = useDb()
  const { team, row, rows } = await checkChange(change)
  const now = new Date()
  const after = change.after as BudgetItemInput | null
  const open = await openRound()
  const revising = open?.kind === '補正予算' ? open : null

  let itemNumber = change.itemNumber
  let itemId = change.itemId
  let values: typeof schema.mainBudgetItems.$inferInsert
  if (change.kind === 'add') {
    const bureauNo = team.bureauNo || rows.find(r => r.bureau === team.bureau)?.itemNumber.match(/^[a-z]+-?\d+/i)?.[0] || ''
    itemNumber = await allocateItemNumber(revising, { bureauNo, bureau: team.bureau, team: team.team }, after!.kan as string, after!.flow === 'income' ? 'income' : 'expense')
    itemId = newId()
    values = {
      id: newId(), itemId, term: BUDGET_TERM, roundId: null, itemNumber, bureau: team.bureau, team: team.team,
      ...itemValues(after as unknown as ItemValues), deleted: false, status: 'approved',
      sortOrder: sortOrderFor(rows, team, after!.kan as string), createdAt: now, createdBy: user.email,
    }
  }
  else {
    // 款を変えたら、番号を新しい款の番号に振り直す（執行で使った項目は変えない）
    if (change.kind === 'edit') itemNumber = await numberForKan(revising, row!, team, after!.kan as string)
    values = {
      ...row!, itemNumber, id: newId(), roundId: null, ...(change.kind === 'edit' ? itemValues(after as unknown as ItemValues) : {}),
      // 款を変えたら、並びを新しい款のいちばん後ろに移す（款が2か所に分かれないように）
      ...(change.kind === 'edit' && after!.kan !== row!.kan ? { sortOrder: sortOrderFor(rows.filter(r => r.itemNumber !== row!.itemNumber), team, after!.kan as string) } : {}),
      deleted: change.kind === 'delete', status: 'approved', createdAt: now, createdBy: user.email,
    }
  }
  await db.batch([
    db.insert(mainTableOf(values.itemNumber)).values(values),
    // 補正予算の集約中は⑦にも足す（査定の状態は変えない）
    ...(revising ? [db.insert(revisedTableOf(values.itemNumber)).values({ ...values, id: newId(), roundId: revising.id, status: 'draft' })] : []),
    db.update(schema.budgetChangeRequests).set({ status: 'approved', itemId, itemNumber, reviewComment: comment, reviewedAt: now, reviewedBy: user.email })
      .where(eq(schema.budgetChangeRequests.id, change.id)),
  ] as const)
  await rebuildCurrentBudget()
}

/** 画面に出す変更の一覧（新しい順。だれが変えたかは出さず、自分の申請かどうかだけ） */
export async function changeList(user: SessionUser) {
  const changes = await useDb().select().from(schema.budgetChangeRequests)
  return changes.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(({ createdBy, reviewedBy: _r, ...c }) => ({ ...c, mine: createdBy === user.email }))
}

/** 承認待ちの変更がある項目の番号（明細の一覧で「承認待ちあり」を出すため） */
export async function pendingItemNumbers() {
  const rows = await useDb().select({ itemNumber: schema.budgetChangeRequests.itemNumber }).from(schema.budgetChangeRequests)
    .where(and(eq(schema.budgetChangeRequests.status, 'pending'), or(eq(schema.budgetChangeRequests.kind, 'edit'), eq(schema.budgetChangeRequests.kind, 'delete'))))
  return rows.map(r => r.itemNumber).filter(Boolean)
}

/**
 * 執行依頼で明細の金額が予算額と違ったときに、その金額へ直す予算の変更を②に申請する（承認待ち。財務管理部でもすぐには反映しない）。
 * 執行依頼そのものは失敗させないので、申請できなかった明細は理由をつけて返す。
 * だれが出した執行依頼でも申請できる（承認するのは財務管理部なので、担当の割り当ては問わない）。
 */
export async function requestChangesFromEntry(
  entry: { seq: string },
  changed: { line: BudgetLine, actual: number }[],
  user: SessionUser,
  reason: string,
) {
  const created: string[] = []
  const skipped: { itemNumber: string, reason: string }[] = []
  const { rows } = await currentBudget()
  for (const { line, actual } of changed) {
    const row = rows.find(r => r.itemId === line.itemId)
    if (!row) {
      skipped.push({ itemNumber: line.itemNumber, reason: '今の予算に項目が見つかりませんでした。' })
      continue
    }
    try {
      await assertNoPending(row.itemId)
    }
    catch {
      skipped.push({ itemNumber: row.itemNumber, reason: 'この項目にはもう承認待ちの変更があります。' })
      continue
    }
    const before = itemValues(row)
    // 金額だけを執行額にする。単価があって合わなくなるなら単価は空にする
    const qty = Number(row.quantity)
    const unitPrice = row.unitPrice != null && Number.isFinite(qty) && qty * row.unitPrice === actual ? row.unitPrice : null
    const auto = `執行依頼 ${entry.seq} で、執行額が予算額と違うため（予算額 ¥${row.amount.toLocaleString('ja-JP')} → 執行額 ¥${actual.toLocaleString('ja-JP')}）。`
    await useDb().insert(schema.budgetChangeRequests).values({
      id: newId(),
      term: BUDGET_TERM,
      kind: 'edit',
      itemId: row.itemId,
      bureau: row.bureau,
      team: row.team,
      itemNumber: row.itemNumber,
      after: { ...before, amount: actual, unitPrice },
      before,
      reason: reason ? `${reason}\n${auto}` : auto,
      sortOrder: row.sortOrder,
      direct: false,
      createdAt: new Date(),
      createdBy: user.email,
    })
    created.push(row.itemNumber)
  }
  return { created, skipped }
}
