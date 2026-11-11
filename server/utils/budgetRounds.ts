import { and, asc, desc, eq, inArray, like, ne, or, sql } from 'drizzle-orm'
import { BUDGET_TERM, bureauNameOf } from '../../shared/constants'
import { confirmSheetRows } from '../../shared/budgetCompile'
import { bureauNoForFlow, flowOf } from '../../shared/budgetCompile'
import type { BudgetFlow, BudgetItemStatus } from '../../shared/budgetCompile'
import { can } from '../../shared/roles'
import { formatItemNumbers } from '../../shared/itemNumbers'
import type { BudgetItemRow, BudgetLine, BudgetRound, BudgetTeam, IssuedItemNumber } from '../db/schema'
import type { BudgetKind, ParsedBudgetLine, ParsedSheetRow } from './budget'
import type { SessionUser } from './auth'

/**
 * 予算の集約（本予算・補正予算）と、①予算項目DB・⑤査定DB・⑦補正予算項目DB・⑪⑫収入の予算項目DB の読み書き。
 * 収入の行は⑪（本予算）⑫（補正予算）に入れる。読むときは支出と合わせて扱うので、下の説明の①⑦は⑪⑫も含む。
 *
 * - ①⑦の行は書き換えず、直すたびに1行足す。項目番号ごとにいちばん新しい行が今の値（削除も行で表す）。
 * - 本予算の集約：①に案の行を足していく → 査定・折衝（⑤）→ 確定すると、その集約の行が承認済みになり、ほかの項目は削除の行で消す。
 * - 補正予算の集約：①の今の値を⑦に写す → ⑦に行を足していく → 査定・折衝（⑤）→ 確定すると、変わった行を①に写す。
 * - 項目の査定の状態は、⑤のその集約での最新の行（⑤に行がない写しただけの項目は承認済み）。
 * - 執行依頼で選ぶ予算（budget_lines）は、①の承認済みの最新の行から作り直す。
 */

const CHUNK = 100

/** ランダムな id（①②⑤⑦⑪⑫の行） */
export const newId = () => crypto.randomUUID().replaceAll('-', '')

/** 行を書く表。本予算は①（収入は⑪）、補正予算は⑦（収入は⑫）。収入か支出かは項目番号で決まる */
export const mainTableOf = (itemNumber: string) => (flowOf(itemNumber) === 'income' ? schema.mainIncomeItems : schema.mainBudgetItems)
export const revisedTableOf = (itemNumber: string) => (flowOf(itemNumber) === 'income' ? schema.revisedIncomeItems : schema.revisedBudgetItems)
export const tableOf = (round: Pick<BudgetRound, 'kind'>, itemNumber: string) => (round.kind === '補正予算' ? revisedTableOf(itemNumber) : mainTableOf(itemNumber))
type ItemTable = ReturnType<typeof mainTableOf> | ReturnType<typeof revisedTableOf>
/** 読むときは、支出と収入の両方の表を見る */
export const mainTables = (): ItemTable[] => [schema.mainBudgetItems, schema.mainIncomeItems]
export const revisedTables = (): ItemTable[] => [schema.revisedBudgetItems, schema.revisedIncomeItems]
export const tablesOf = (round: Pick<BudgetRound, 'kind'>) => (round.kind === '補正予算' ? revisedTables() : mainTables())

type ItemInsert = typeof schema.mainBudgetItems.$inferInsert
/** 行を収入と支出の表に分けて、足す文を作る */
export function insertsOf(rows: ItemInsert[], tableFor: (itemNumber: string) => ItemTable) {
  return [...Map.groupBy(rows, r => tableFor(r.itemNumber))].flatMap(([table, list]) =>
    Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => useDb().insert(table).values(list.slice(i * CHUNK, (i + 1) * CHUNK))))
}
/** 行を収入と支出の表に分けて、承認済みにする文を作る */
function approvalsOf(rows: BudgetItemRow[], tableFor: (itemNumber: string) => ItemTable) {
  return [...Map.groupBy(rows, r => tableFor(r.itemNumber))].flatMap(([table, list]) =>
    Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) =>
      useDb().update(table).set({ status: 'approved' }).where(inArray(table.id, list.slice(i * CHUNK, (i + 1) * CHUNK).map(r => r.id)))))
}

/** ①⑦の行のうち、明細の中身の項目（直す・写す・比べるときに使う） */
export const ITEM_FIELDS = ['kan', 'kou', 'moku', 'setsu', 'quantity', 'unitPrice', 'amount', 'vendor', 'spec', 'link', 'plannedTiming', 'remark', 'isNew', 'preExecution'] as const
export type ItemValues = Pick<BudgetItemRow, typeof ITEM_FIELDS[number]>
export const itemValues = (r: ItemValues): ItemValues => Object.fromEntries(ITEM_FIELDS.map(k => [k, r[k] ?? null])) as unknown as ItemValues
const sameItem = (a: BudgetItemRow, b: BudgetItemRow) =>
  a.itemNumber === b.itemNumber && a.deleted === b.deleted && a.bureau === b.bureau && a.team === b.team && ITEM_FIELDS.every(k => (a[k] ?? null) === (b[k] ?? null))

/** 行を書いた順に読む（同じ時刻なら足した順。同じ項目の行は必ず同じ表にある） */
async function rowsOf(tables: ItemTable[], where: (table: ItemTable) => ReturnType<typeof and>) {
  const lists = await Promise.all(tables.map(t => useDb().select().from(t).where(where(t)).orderBy(asc(t.createdAt), sql`rowid`)))
  const rows = lists.flat().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  // 内部 ID が空の行（移行のあとに古いコードが足した行）は、項目番号を内部 ID とみなす（移行で入れる値と同じ）
  return rows.map(r => (r.itemId ? r : { ...r, itemId: r.itemNumber }))
}
/** 項目（内部 ID）ごとの最新の行 */
export function latestByItem(rows: BudgetItemRow[]) {
  const latest = new Map<string, BudgetItemRow>()
  for (const r of rows) latest.set(r.itemId, r)
  return latest
}

/** 今の予算：①の承認済みの最新の行（削除を除く）。執行依頼で選ぶ予算・予算の変更のもと */
export async function currentRows(term = BUDGET_TERM) {
  const rows = await rowsOf(mainTables(), t => and(eq(t.term, term), eq(t.status, 'approved')))
  return [...latestByItem(rows).values()].filter(r => !r.deleted)
}

/** 予算明細と「支出」シートの行を入れ替える */
export async function replaceBudgetLines(lines: (ParsedBudgetLine & { itemId: string })[], sheetRows: ParsedSheetRow[], budgetKind: BudgetKind) {
  const db = useDb()
  const importedAt = new Date()
  await db.batch([
    db.delete(schema.budgetLines),
    db.delete(schema.budgetSheetRows),
    ...Array.from({ length: Math.ceil(lines.length / CHUNK) }, (_, i) =>
      db.insert(schema.budgetLines).values(lines.slice(i * CHUNK, (i + 1) * CHUNK).map(l => ({ ...l, importedAt, budgetKind }))),
    ),
    ...Array.from({ length: Math.ceil(sheetRows.length / CHUNK) }, (_, i) =>
      db.insert(schema.budgetSheetRows).values(sheetRows.slice(i * CHUNK, (i + 1) * CHUNK)),
    ),
  ] as const)
}

/** 確定していない集約（集約中・集約終了・査定中。なければ null）。一度に進められるのは1つだけ */
export async function openRound() {
  return (await useDb().query.budgetRounds.findFirst({ where: ne(schema.budgetRounds.status, 'confirmed') })) ?? null
}

/** 最新の確定した予算（なければ null） */
export async function latestConfirmedRound() {
  return (await useDb().query.budgetRounds.findFirst({
    where: eq(schema.budgetRounds.status, 'confirmed'),
    orderBy: [desc(schema.budgetRounds.confirmedAt), desc(schema.budgetRounds.id)],
  })) ?? null
}

/** 集約の段階を確かめる（違えば 409 と、その段階でできることの案内） */
export function assertPhase(round: Pick<BudgetRound, 'status'>, phase: BudgetRound['status']) {
  if (round.status === phase) return
  const messages: Record<BudgetRound['status'], string> = {
    collecting: '集約中ではありません。',
    closed: '集約終了の段階ではありません。',
    reviewing: '査定中ではありません。「集約終了」のあと「査定開始」で査定できます。',
    confirmed: 'この予算はまだ確定していません。',
  }
  throw createError({ statusCode: 409, message: messages[phase] })
}

/** 確定していない集約を id で読む（なければ 404） */
export async function openRoundOr404(id: number) {
  const round = await useDb().query.budgetRounds.findFirst({ where: eq(schema.budgetRounds.id, id) })
  if (!round || round.status === 'confirmed') throw createError({ statusCode: 404, message: '確定していない集約が見つかりません。' })
  return round
}

/**
 * 集約の局・部・担当を、予算の表の順で読む。
 * 並びは 局の並び → 局の直属の担当 → 部の並び → 部の中の担当の並び。
 */
export async function teamsOf(roundId: number) {
  const db = useDb()
  const [bureaus, departments, teams] = await Promise.all([
    db.select().from(schema.budgetBureaus).where(eq(schema.budgetBureaus.roundId, roundId)).orderBy(asc(schema.budgetBureaus.sortOrder)),
    db.select().from(schema.budgetDepartments).where(eq(schema.budgetDepartments.roundId, roundId)).orderBy(asc(schema.budgetDepartments.sortOrder)),
    db.select().from(schema.budgetTeams).where(eq(schema.budgetTeams.roundId, roundId)),
  ])
  const bureauOrder = new Map(bureaus.map((b, i) => [b.id, i]))
  const deptOrder = new Map(departments.map((d, i) => [d.id, i + 1]))
  teams.sort((a, b) => (bureauOrder.get(a.bureauId ?? -1) ?? 1e9) - (bureauOrder.get(b.bureauId ?? -1) ?? 1e9)
    || (deptOrder.get(a.departmentId ?? -1) ?? 0) - (deptOrder.get(b.departmentId ?? -1) ?? 0)
    || a.sortOrder - b.sortOrder)
  return { bureaus, departments, teams }
}

/** 項目番号から局の番号（out01-04-12 → out01、out-03-02-06 → out-03） */
const bureauNoOf = (itemNumber: string) => itemNumber.match(/^[a-z]+-?\d+/i)?.[0] ?? ''
const pad2 = (n: number) => String(n).padStart(2, '0')
/** 項目番号の最後の数（out01-04-12 → 12）と、款の番号（out01-04） */
const lastSeq = (no: string) => Number(no.split('-').at(-1)) || 0
const parentOf = (no: string) => no.split('-').slice(0, -1).join('-')

/**
 * 予算明細を作り直したら、執行依頼と収入の記録を内部 ID で今の明細に付け直す（key と項目番号が変わっていれば直す）。
 * 名前を直しても、番号を振り直しても、決算などのつながりが切れない。今の予算にない項目はそのまま。
 */
async function repointLineKeys(lines: Pick<BudgetLine, 'key' | 'itemNumber' | 'itemId'>[]) {
  const db = useDb()
  const byItem = new Map(lines.filter(l => l.itemId).map(l => [l.itemId, l]))
  const stale = (r: { itemId: string, lineKey: string | null, itemNumber: string }) => {
    const line = byItem.get(r.itemId || r.itemNumber)
    return line && (line.key !== r.lineKey || line.itemNumber !== r.itemNumber) ? line : null
  }
  const items = await db.select({ id: schema.entryItems.id, entryId: schema.entryItems.entryId, itemId: schema.entryItems.itemId, lineKey: schema.entryItems.lineKey, itemNumber: schema.entryItems.itemNumber }).from(schema.entryItems)
  const renumbered = new Set<number>()
  for (const i of items) {
    const line = stale(i)
    if (!line) continue
    await db.update(schema.entryItems).set({ lineKey: line.key, itemNumber: line.itemNumber }).where(eq(schema.entryItems.id, i.id))
    if (line.itemNumber !== i.itemNumber) renumbered.add(i.entryId)
  }
  // 番号が変わった依頼は、申請の項目番号（複数ならまとめた形）も直す
  for (const entryId of renumbered) {
    const numbers = await db.select({ itemNumber: schema.entryItems.itemNumber }).from(schema.entryItems).where(eq(schema.entryItems.entryId, entryId))
    await db.update(schema.entries).set({ itemNumber: formatItemNumbers(numbers.map(n => n.itemNumber)) }).where(eq(schema.entries.id, entryId))
  }
  const incomes = await db.select({ id: schema.incomeRecords.id, itemId: schema.incomeRecords.itemId, lineKey: schema.incomeRecords.lineKey, itemNumber: schema.incomeRecords.itemNumber }).from(schema.incomeRecords)
  for (const i of incomes) {
    const line = i.lineKey ? stale(i) : null
    if (line) await db.update(schema.incomeRecords).set({ lineKey: line.key, itemNumber: line.itemNumber }).where(eq(schema.incomeRecords.id, i.id))
  }
}

/**
 * 新しい項目の番号（局-款-項目）。同じ担当に同じ款があればその款の続き、なければその局の次の款の 01。
 * used は、その期で使っている番号と、その番号の行（款・担当を見るため）。reserved は、ほかに避ける番号（款の判定には使わない）。
 * 款を変えた明細は番号が前の款のままなので、ほかの款の明細が混ざっていない款の番号だけを「その款の番号」とする。
 * 収入（flow=income）は局の番号の頭を in にして、収入の番号の中で数える（in01-01-01）。
 */
export function nextItemNumber(used: Map<string, Pick<BudgetItemRow, 'bureau' | 'team' | 'kan'>>, team: Pick<BudgetTeam, 'bureauNo' | 'bureau' | 'team'>, kan: string, flow: BudgetFlow = 'expense', reserved: Iterable<string> = []) {
  const bureauNo = bureauNoForFlow(team.bureauNo, flow)
  const usedInBureau = [...used.keys()].filter(no => bureauNoOf(no) === bureauNo)
  const inBureau = [...usedInBureau, ...[...reserved].filter(no => bureauNoOf(no) === bureauNo)]
  const isThisKan = (no: string) => {
    const r = used.get(no)!
    return r.bureau === team.bureau && r.team === team.team && r.kan === kan
  }
  const sameKan = usedInBureau.find(no => isThisKan(no) && usedInBureau.filter(x => parentOf(x) === parentOf(no)).every(isThisKan))
  const kanNo = sameKan ? parentOf(sameKan) : `${bureauNo}-${pad2(Math.max(0, ...inBureau.map(no => lastSeq(parentOf(no)))) + 1)}`
  const seq = Math.max(0, ...inBureau.filter(no => parentOf(no) === kanNo).map(lastSeq)) + 1
  return `${kanNo}-${pad2(seq)}`
}

/**
 * 番号を振るときに見るもの。used：予算の番号に、予算にない執行依頼・収入の番号を足したもの（同じ担当・同じ款なら続きの番号にする）。
 * reserved：昨年の参考の番号と、これまでに払い出した番号（中止した集約の分も）。どちらも新しい番号には使わない。
 */
export async function numbersInUse(round: Pick<BudgetRound, 'id' | 'kind' | 'term'> | null, teams: Pick<BudgetTeam, 'bureau' | 'team' | 'nameJa'>[]) {
  const db = useDb()
  const term = round?.term ?? BUDGET_TERM
  const [budgeted, entries, incomes, references, issued] = await Promise.all([
    usedNumbers(round, term),
    db.select({ itemNumber: schema.entries.itemNumber, department: schema.entries.department, inCharge: schema.entries.inCharge, details: schema.entries.details })
      .from(schema.entries).where(or(like(schema.entries.itemNumber, 'out%'), like(schema.entries.itemNumber, 'in%'))),
    db.select({ itemNumber: schema.incomeRecords.itemNumber, department: schema.incomeRecords.department, inCharge: schema.incomeRecords.inCharge, details: schema.incomeRecords.details })
      .from(schema.incomeRecords),
    db.select({ itemNumber: schema.budgetReferences.itemNumber }).from(schema.budgetReferences),
    db.select({ itemNumber: schema.issuedItemNumbers.itemNumber }).from(schema.issuedItemNumbers).where(eq(schema.issuedItemNumbers.term, term)),
  ])
  const used: Map<string, Pick<BudgetItemRow, 'bureau' | 'team' | 'kan'>> = new Map(budgeted)
  for (const e of [...entries, ...incomes]) {
    if (used.has(e.itemNumber)) continue
    const bureau = bureauNameOf(e.department)
    const name = e.inCharge.trim().toLowerCase()
    const team = teams.find(t => t.bureau === bureau && teamNamesOf(t).some(n => n.toLowerCase() === name))
    used.set(e.itemNumber, { bureau, team: team?.team ?? e.inCharge, kan: (e.details as { budgetPath?: { kan?: string } }).budgetPath?.kan ?? '' })
  }
  return { used, reserved: new Set([...references, ...issued].map(r => r.itemNumber)) }
}

/**
 * 新しい項目番号を払い出す。控えの表に登録できた番号だけを使うので、同時に足しても重ならない（取られていたら次を試す）。
 * referenceNumber は、昨年の参考をコピーしたのに参考の番号が使えなかったときの、もとの番号。
 */
export async function allocateItemNumber(round: BudgetRound | null, team: Pick<BudgetTeam, 'bureauNo' | 'bureau' | 'team'>, kan: string, flow: BudgetFlow, referenceNumber = '') {
  const db = useDb()
  const owner = round ?? await latestConfirmedRound()
  const teams = owner ? (await teamsOf(owner.id)).teams : []
  const { used, reserved } = await numbersInUse(round, teams)
  for (let i = 0; i < 50; i++) {
    const itemNumber = nextItemNumber(used, team, kan, flow, reserved)
    const [taken] = await db.insert(schema.issuedItemNumbers)
      .values({ term: round?.term ?? BUDGET_TERM, itemNumber, source: 'allocated', referenceNumber, createdAt: new Date() })
      .onConflictDoNothing().returning()
    if (taken) return itemNumber
    reserved.add(itemNumber)
  }
  throw createError({ statusCode: 503, message: '項目番号を振れませんでした。もう一度試してください。' })
}

/**
 * 款を変えたときの項目番号。番号と款がそろうよう、新しい款の番号に振り直す。
 * 執行依頼・収入の記録で使った項目は、控えた番号と合わなくならないよう変えない。昨年の参考とのつながりは引き継ぐ。
 */
export async function numberForKan(round: BudgetRound | null, row: BudgetItemRow, team: Pick<BudgetTeam, 'bureauNo' | 'bureau' | 'team'>, kan: string) {
  if (kan === row.kan || await isExecuted(row)) return row.itemNumber
  const issued = await issuedNumbers(row.term)
  return allocateItemNumber(round, { ...team, bureauNo: team.bureauNo || bureauNoOf(row.itemNumber) }, kan, flowOf(row.itemNumber), referenceNumberOf(row.itemNumber, issued))
}

/** 昨年の参考の番号をそのまま使うと記録する */
export async function claimCopiedNumber(term: string, itemNumber: string) {
  await useDb().insert(schema.issuedItemNumbers).values({ term, itemNumber, source: 'copy', createdAt: new Date() }).onConflictDoNothing()
}

/** 払い出した番号の控え（項目番号 → 行） */
export async function issuedNumbers(term: string) {
  const rows = await useDb().select().from(schema.issuedItemNumbers).where(eq(schema.issuedItemNumbers.term, term))
  return new Map(rows.map(r => [r.itemNumber, r]))
}

/**
 * その項目のもとになった昨年の参考の番号。新しく振った番号は昨年の明細とは別物なので、参考の番号と同じでも結ばない。
 * 控えのない番号（前からある行）と、参考の番号をそのまま使った番号は、その番号のまま。
 */
export function referenceNumberOf(itemNumber: string, issued: Map<string, Pick<IssuedItemNumber, 'source' | 'referenceNumber'>>) {
  const row = issued.get(itemNumber)
  return row?.source === 'allocated' ? row.referenceNumber : itemNumber
}

/** その期で使っている番号（①のすべての行と、補正予算の集約なら⑦の行） */
export async function usedNumbers(round: Pick<BudgetRound, 'id' | 'kind' | 'term'> | null, term = BUDGET_TERM) {
  const db = useDb()
  const read = (t: ItemTable, where: ReturnType<typeof and>) =>
    db.select({ itemId: t.itemId, itemNumber: t.itemNumber, bureau: t.bureau, team: t.team, kan: t.kan }).from(t).where(where).orderBy(asc(t.createdAt), sql`rowid`)
  const main = await Promise.all(mainTables().map(t => read(t, eq(t.term, term))))
  const revised = round?.kind === '補正予算' ? await Promise.all(revisedTables().map(t => read(t, eq(t.roundId, round.id)))) : []
  return new Map([...main, ...revised].flat().map(r => [r.itemNumber, r]))
}

/** ⑤に行を足すときの値 */
export function reviewRow(roundId: number, item: Pick<BudgetItemRow, 'itemId' | 'itemNumber'>, action: typeof schema.budgetReviews.$inferInsert['action'], status: BudgetItemStatus, user: SessionUser, extra: { comment?: string, rowId?: string | null, bulk?: string | null, at?: Date } = {}) {
  return {
    id: newId(), roundId, itemId: item.itemId, itemNumber: item.itemNumber, action, status,
    comment: extra.comment ?? '', rowId: extra.rowId ?? null, bulk: extra.bulk ?? null,
    createdAt: extra.at ?? new Date(), createdBy: user.email,
  }
}

/** 集約の中身：局・担当、項目ごとの最新の行と⑤の状態、もとの予算の金額 */
export async function roundState(round: BudgetRound) {
  const db = useDb()
  const [{ bureaus, departments, teams }, rows, reviews, before] = await Promise.all([
    teamsOf(round.id),
    // 確定した集約は、今の予算（①の承認済みの行。予算の変更も入る）を出す
    round.status === 'confirmed'
      ? rowsOf(mainTables(), t => and(eq(t.term, round.term), eq(t.status, 'approved')))
      : rowsOf(tablesOf(round), t => and(eq(t.roundId, round.id))),
    db.select().from(schema.budgetReviews).where(eq(schema.budgetReviews.roundId, round.id)).orderBy(asc(schema.budgetReviews.createdAt), sql`rowid`),
    // もとの予算：集約を始める前の、①の承認済みの最新の行
    rowsOf(mainTables(), t => and(eq(t.term, round.term), eq(t.status, 'approved'), sql`${t.createdAt} < ${round.createdAt.getTime()}`)),
  ])
  const latest = latestByItem(rows)
  const base = new Map([...latestByItem(before)].filter(([, r]) => !r.deleted))
  const state = new Map<string, { status: BudgetItemStatus, comment: string, count: number }>()
  for (const r of reviews) {
    const itemId = r.itemId || r.itemNumber
    const s = state.get(itemId) ?? { status: 'approved' as BudgetItemStatus, comment: '', count: 0 }
    s.status = r.status
    if (r.action === 'return') s.comment = r.comment
    if (r.action !== 'create' && r.action !== 'edit' && r.action !== 'reflect') s.count++
    state.set(itemId, s)
  }
  // ⑤に行がない項目（補正予算で写しただけのもの）は承認済み
  const statusOf = (itemId: string): BudgetItemStatus => state.get(itemId)?.status ?? 'approved'
  return { bureaus, departments, teams, latest, base, state, statusOf }
}

/** 担当（局・担当の名前）に合う局・担当の行 */
const teamFor = (teams: BudgetTeam[], r: Pick<BudgetItemRow, 'bureau' | 'team'>) => teams.find(t => t.bureau === r.bureau && t.team === r.team)

/** 画面に渡す集約の中身（局・担当、項目、自分が入力できる担当） */
export async function roundView(round: BudgetRound, user: SessionUser) {
  const db = useDb()
  const [{ bureaus, departments, teams, latest, base, state, statusOf }, me, members, referenced, issued] = await Promise.all([
    roundState(round),
    db.query.users.findFirst({ where: eq(schema.users.email, user.email) }),
    db.select({ email: schema.users.email, name: schema.users.name, bureau: schema.users.budgetBureau, team: schema.users.budgetTeam })
      .from(schema.users).where(ne(schema.users.budgetTeam, '')),
    db.select({ bureau: schema.budgetReferences.bureau, team: schema.budgetReferences.team, kind: schema.budgetReferences.kind, itemNumber: schema.budgetReferences.itemNumber, amount: schema.budgetReferences.amount })
      .from(schema.budgetReferences),
    issuedNumbers(round.term),
  ])
  // 本予算の「昨年から」は、取り込んだ昨年の本予算（支出・収入）の同じ項目番号の金額（同じ番号が複数あれば合計）と比べる
  const lastYear = new Map<string, number>()
  for (const r of referenced) if (r.kind === 'budget' || r.kind === 'incomeBudget') lastYear.set(r.itemNumber, (lastYear.get(r.itemNumber) ?? 0) + r.amount)
  // 集約・査定に出す担当：昨年の本予算・決算（取り込んだ参考）に明細がある担当と、この集約に項目がある担当。
  // 参考をまだ取り込んでいなければ、すべての担当を出す
  const [preExecutions, lockedIds] = await Promise.all([pendingPreExecutions(round, teams, latest), lockedPreExecutionItemIds()])
  const preTeamIds = new Set(preExecutions.map(p => p.teamId))
  const refKeys = new Set(referenced.map(r => `${r.bureau}|${r.team}`))
  const withItems = new Set([...latest.values()].filter(r => !r.deleted).map(r => `${r.bureau}|${r.team}`))
  const listed = (t: BudgetTeam) => !refKeys.size || withItems.has(`${t.bureau}|${t.team}`) || preTeamIds.has(t.id)
    || teamNamesOf(t).some(n => refKeys.has(`${t.bureau}|${n}`))
  const teamOrder = new Map(teams.map((t, i) => [t.id, i]))
  const items = [...latest.values()].flatMap((r) => {
    const b = base.get(r.itemId)
    // 削除の行が最新の項目は、補正予算で写したもの（もとの予算にあるもの）だけ「削除」として出す
    if (r.deleted && (round.kind === '本予算' || !b)) return []
    const team = teamFor(teams, r)
    if (!team) return []
    const s = state.get(r.itemId)
    const status = statusOf(r.itemId)
    return [{
      id: r.id,
      teamId: team.id,
      trackId: r.itemId,
      itemNumber: r.itemNumber,
      number: r.itemNumber,
      flow: flowOf(r.itemNumber),
      ...itemValues(r),
      deleted: r.deleted,
      sortOrder: r.sortOrder,
      status,
      reviewComment: status === 'approved' ? '' : (s?.comment ?? ''),
      reviewCount: s?.count ?? 0,
      baseAmount: round.kind === '本予算' ? (lastYear.get(referenceNumberOf(r.itemNumber, issued)) ?? null) : b ? b.amount : null,
      baseItemId: b ? b.id : null,
      /** 予算前執行と結んだ明細（修正・削除できない） */
      locked: lockedIds.has(r.itemId),
      updatedAt: r.createdAt,
    }]
  }).sort((a, b) => (teamOrder.get(a.teamId)! - teamOrder.get(b.teamId)!) || a.sortOrder - b.sortOrder)
  // 明細の入力・提出はだれでもできる。「あなたの担当」には、割り当てられた担当を出す
  const editable = teams.map(t => t.id)
  const mine = teams.filter(t => me?.budgetBureau === t.bureau && me?.budgetTeam === t.team).map(t => t.id)
  return {
    round,
    bureaus,
    departments,
    teams: teams.map(t => ({ ...t, listed: listed(t), department: departments.find(d => d.id === t.departmentId) ?? null, members: members.filter(m => m.bureau === t.bureau && m.team === t.team).map(m => ({ email: m.email, name: m.name })) })),
    items,
    preExecutions,
    editableTeamIds: editable,
    myTeamIds: mine,
  }
}

/** その担当の集約の明細を入力・提出できるか。ログインしていればだれでもできる */
export async function canEditTeam(_user: SessionUser, _team: Pick<BudgetTeam, 'bureau' | 'team'>) {
  return true
}

/** その担当の予算の変更を申請できるか（その担当に割り当てられた人と、財務管理部・財務局長・財務局長補佐・管理者） */
export async function canRequestChange(user: SessionUser, team: Pick<BudgetTeam, 'bureau' | 'team'>) {
  if (can(user.role, 'reviewBudget')) return true
  const me = await useDb().query.users.findFirst({ where: eq(schema.users.email, user.email) })
  return !!me && me.budgetBureau === team.bureau && me.budgetTeam === team.team
}

/** 確定していない集約の担当を読む（なければ 404、確定済みなら 409） */
export async function openTeamOr404(teamId: number) {
  const team = await useDb().query.budgetTeams.findFirst({ where: eq(schema.budgetTeams.id, teamId) })
  if (!team) throw createError({ statusCode: 404, message: '担当が見つかりません。' })
  const round = await useDb().query.budgetRounds.findFirst({ where: eq(schema.budgetRounds.id, team.roundId) })
  if (!round || round.status === 'confirmed') throw createError({ statusCode: 409, message: 'この予算は確定しているので、直せません。' })
  return { team, round }
}

/**
 * 確定していない集約の項目を、画面に出した行の id で読む（なければ 404）。
 * 渡された行がもう最新でなければ（ほかの人が直したあと）、読み直してもらう。
 */
export async function openItemOr404(rowId: string) {
  const db = useDb()
  const found = await Promise.all([...mainTables(), ...revisedTables()].map(t => db.select().from(t).where(eq(t.id, rowId)).limit(1)))
  const row = found.flat()[0]
  if (!row || row.roundId == null) throw createError({ statusCode: 404, message: '明細が見つかりません。' })
  const round = await db.query.budgetRounds.findFirst({ where: eq(schema.budgetRounds.id, row.roundId) })
  if (!round || round.status === 'confirmed') throw createError({ statusCode: 409, message: 'この予算は確定しているので、直せません。' })
  const st = await roundState(round)
  const latest = st.latest.get(row.itemId)
  if (latest?.id !== row.id) throw createError({ statusCode: 409, message: 'この明細はほかの人が直しました。画面を読み込み直してください。' })
  const team = teamFor(st.teams, row)
  if (!team) throw createError({ statusCode: 404, message: '担当が見つかりません。' })
  return { row, round, team, status: st.statusOf(row.itemId), base: st.base.get(row.itemId) ?? null }
}

/**
 * 担当が明細を直してよいか。財務管理部は確定までいつでも直せる。担当の人は
 * - 集約中：査定待ち以外の明細
 * - 査定中：要修正の明細（直して未提出に戻ったものも）だけ
 * - 集約終了：直せない
 */
export async function assertCanChangeItem(user: SessionUser, status: BudgetItemStatus, team: Pick<BudgetTeam, 'bureau' | 'team'>, round: Pick<BudgetRound, 'status'>) {
  if (!(await canEditTeam(user, team))) throw createError({ statusCode: 403, message: 'この担当の明細は直せません。' })
  if (can(user.role, 'reviewBudget')) return
  if (round.status === 'collecting' && status !== 'submitted') return
  if (round.status === 'reviewing' && (status === 'returned' || status === 'draft')) return
  const message = round.status === 'collecting'
    ? '提出した明細は直せません。財務管理部の査定を待ってください。'
    : round.status === 'closed'
      ? '集約は終了しました。査定が始まると、要修正になった明細だけ直せます。'
      : '査定中は、要修正になった明細だけ直せます。'
  throw createError({ statusCode: 409, message })
}

/** 担当の人が明細を足してよいか（集約中だけ。財務管理部は確定までいつでも） */
export function assertCanAddItem(user: SessionUser, round: Pick<BudgetRound, 'status'>) {
  if (can(user.role, 'reviewBudget') || round.status === 'collecting') return
  throw createError({ statusCode: 409, message: '集約は終了したので、明細は足せません。' })
}

/**
 * 項目を直す（①⑦に行を足し、⑤にも残す）。
 * 直すと未提出に戻る。ただし査定中に財務管理部が直すのは「折衝の反映」で、査定の状態は変えない。
 */
export async function writeItem(
  round: BudgetRound, prev: BudgetItemRow | null, values: ItemValues & Partial<Pick<BudgetItemRow, 'deleted' | 'itemId' | 'itemNumber' | 'bureau' | 'team' | 'sortOrder'>>,
  user: SessionUser, status: BudgetItemStatus,
) {
  const db = useDb()
  // 査定中に財務管理部が直すのは「折衝の反映」（査定の状態は変えない）。それ以外の修正は未提出に戻る
  const reviewer = can(user.role, 'reviewBudget') && round.status === 'reviewing'
  const now = new Date()
  const row = {
    id: newId(),
    term: round.term,
    roundId: round.id,
    itemId: prev?.itemId ?? values.itemId ?? newId(),
    itemNumber: values.itemNumber ?? prev!.itemNumber,
    bureau: values.bureau ?? prev!.bureau,
    team: values.team ?? prev!.team,
    ...itemValues(values),
    deleted: values.deleted ?? false,
    status: 'draft' as const,
    sortOrder: values.sortOrder ?? prev!.sortOrder,
    createdAt: now,
    createdBy: user.email,
  }
  const action = !prev ? 'create' : reviewer ? 'reflect' : 'edit'
  const next: BudgetItemStatus = !prev ? (reviewer && status === 'approved' ? 'approved' : 'draft') : reviewer ? status : 'draft'
  await db.batch([
    db.insert(tableOf(round, row.itemNumber)).values(row),
    db.insert(schema.budgetReviews).values(reviewRow(round.id, row, action, next, user, { rowId: row.id, at: now })),
  ])
  return row
}

/** 担当のいちばん後ろ（同じ款があればその款の後ろ）の並び順 */
export function sortOrderFor(rows: BudgetItemRow[], team: Pick<BudgetTeam, 'bureau' | 'team'>, kan: string) {
  const mine = rows.filter(r => r.bureau === team.bureau && r.team === team.team)
  const sameKan = mine.filter(r => r.kan === kan)
  const after = Math.max(-1, ...(sameKan.length ? sameKan : mine).map(r => r.sortOrder))
  const next = mine.filter(r => r.sortOrder > after).map(r => r.sortOrder)
  return next.length ? (after + Math.min(...next)) / 2 : after + 1
}

/** 項目の状態をまとめて変える（提出・承認など）。⑤に1項目1行ずつ足す */
export async function setStatuses(round: BudgetRound, items: Pick<BudgetItemRow, 'itemId' | 'itemNumber'>[], action: 'submit' | 'approve', user: SessionUser, bulk: string | null) {
  if (!items.length) return 0
  const status: BudgetItemStatus = action === 'submit' ? 'submitted' : 'approved'
  const now = new Date()
  const rows = items.map(item => reviewRow(round.id, item, action, status, user, { bulk, at: now }))
  const db = useDb()
  for (let i = 0; i < rows.length; i += CHUNK) await db.insert(schema.budgetReviews).values(rows.slice(i, i + CHUNK))
  return rows.length
}

/** 画面に出す項目（roundView の items）のうち、条件に合う項目 */
export async function itemsWhere(round: BudgetRound, test: (status: BudgetItemStatus, teamId: number) => boolean) {
  const { teams, latest, base, statusOf } = await roundState(round)
  return [...latest.values()]
    .filter(r => !(r.deleted && (round.kind === '本予算' || !base.get(r.itemId))))
    .filter((r) => {
      const team = teamFor(teams, r)
      return team && test(statusOf(r.itemId), team.id)
    })
}

/**
 * 集約を始める（財務管理部）。期は第100期で固定。最新の確定した予算の局・担当を写す。
 * 本予算は明細を空から作る（取り込んだ昨年の本予算・決算を参考にコピーできる）。
 * 補正予算は①の今の値を⑦に写す（写しただけの項目は承認済み。直した・足した・消した項目だけが査定に回る）。
 */
export async function startRound(kind: BudgetKind, user: SessionUser) {
  const db = useDb()
  if (await openRound()) throw createError({ statusCode: 409, message: '確定していない集約があります。確定するか中止してから始めてください。' })
  const [base, current] = await Promise.all([latestConfirmedRound(), currentRows()])
  if (!base && !current.length) throw createError({ statusCode: 400, message: 'もとにする予算がありません。最初の予算を取り込んでください。' })

  const now = new Date()
  const [round] = await db.insert(schema.budgetRounds).values({ term: BUDGET_TERM, kind, status: 'collecting', baseRoundId: base?.id ?? null, createdAt: now, createdBy: user.email }).returning()
  // 局・担当：前の集約のもの（局ごとに担当をまとめて）。今の予算にしかない局・担当も足す
  const prev = base ? await teamsOf(base.id) : { bureaus: [], departments: [], teams: [] }
  const bureauRows = prev.bureaus.map(b => ({ oldId: b.id as number | null, bureauNo: b.bureauNo, name: b.name, sortOrder: b.sortOrder }))
  const teamRows = prev.teams.map(t => ({ ...t, bureauName: prev.bureaus.find(b => b.id === t.bureauId)?.name ?? t.bureau }))
  for (const r of current) {
    if (!bureauRows.some(b => b.name === r.bureau)) bureauRows.push({ oldId: null, bureauNo: bureauNoOf(r.itemNumber), name: r.bureau, sortOrder: bureauRows.length + 1e6 })
    if (!teamRows.some(t => t.bureauName === r.bureau && t.team === r.team)) {
      teamRows.push({ id: 0, roundId: 0, bureauId: null, departmentId: null, bureauNo: bureauNoOf(r.itemNumber), bureau: r.bureau, team: r.team, nameJa: '', person: '', sortOrder: teamRows.length + 1e6, bureauName: r.bureau })
    }
  }
  const newBureaus = bureauRows.length
    ? await db.insert(schema.budgetBureaus).values(bureauRows.map(b => ({ roundId: round!.id, bureauNo: b.bureauNo, name: b.name, sortOrder: b.sortOrder }))).returning()
    : []
  // 部：前の集約の部を、写した局の中に写す
  const deptRows = prev.departments.flatMap((d) => {
    const name = prev.bureaus.find(b => b.id === d.bureauId)?.name
    const b = newBureaus.find(x => x.name === name)
    return b ? [{ oldId: d.id, roundId: round!.id, bureauId: b.id, code: d.code, nameJa: d.nameJa, sortOrder: d.sortOrder }] : []
  })
  const newDepts = deptRows.length ? await db.insert(schema.budgetDepartments).values(deptRows.map(({ oldId: _, ...d }) => d)).returning() : []
  const deptIdOf = (oldId: number | null) => {
    const i = deptRows.findIndex(d => d.oldId === oldId)
    return i >= 0 ? newDepts[i]!.id : null
  }
  if (teamRows.length) {
    await db.insert(schema.budgetTeams).values(teamRows.map((t) => {
      const b = newBureaus.find(x => x.name === t.bureauName)!
      return { roundId: round!.id, bureauId: b.id, departmentId: deptIdOf(t.departmentId), bureauNo: b.bureauNo, bureau: b.name, team: t.team, nameJa: t.nameJa, person: '', sortOrder: t.sortOrder }
    }))
  }
  if (kind === '本予算') return round!

  const copies = current.map(r => ({ ...r, id: newId(), roundId: round!.id, status: 'draft' as const, createdAt: now, createdBy: user.email }))
  for (const insert of insertsOf(copies, revisedTableOf)) await insert
  return round!
}

/**
 * 確定する（予算提出・承認）。すべて承認済みのときだけ。
 * - 本予算：この集約の各項目の最新の行を承認済みにする（その後に予算の変更で行が足されていれば、写して足す）。この集約にない項目は削除の行で消す。
 * - 補正予算：⑦の最新の行を承認済みにし、①の今の値と違う項目だけ①に写す。
 * そのあと、執行依頼で選ぶ予算を作り直し、予算前執行の枠を本予算の項目に付け替える。
 */
export async function confirmRound(round: BudgetRound, user: SessionUser) {
  const db = useDb()
  const { latest, base, statusOf } = await roundState(round)
  const live = [...latest.values()].filter(r => !(r.deleted && (round.kind === '本予算' || !base.get(r.itemId))))
  const waiting = live.filter(r => statusOf(r.itemId) !== 'approved')
  if (waiting.length) throw createError({ statusCode: 400, message: `承認していない明細が${waiting.length}件あります。すべて承認してから確定してください。` })
  if (!live.some(r => !r.deleted)) throw createError({ statusCode: 400, message: '明細がありません。' })

  const now = new Date()
  const current = await rowsOf(mainTables(), t => and(eq(t.term, round.term)))
  const mainLatest = latestByItem(current)
  const approvedLatest = latestByItem(current.filter(r => r.status === 'approved'))
  const marks: BudgetItemRow[] = []
  const appends: ItemInsert[] = []
  const copy = (r: BudgetItemRow) => ({ ...r, id: newId(), status: 'approved' as const, createdAt: now, createdBy: user.email })

  if (round.kind === '本予算') {
    for (const r of latest.values()) {
      if (mainLatest.get(r.itemId)?.id === r.id) marks.push(r)
      else appends.push(copy(r))
    }
    // この集約にない項目（今の予算に残っているもの）は削除の行で消す
    for (const r of approvedLatest.values()) {
      if (!r.deleted && !latest.has(r.itemId)) appends.push({ ...copy(r), deleted: true, roundId: round.id })
    }
  }
  else {
    for (const r of latest.values()) {
      const now1 = approvedLatest.get(r.itemId)
      if (now1 ? !sameItem(now1, r) : !r.deleted) appends.push({ ...copy(r), roundId: round.id })
    }
  }
  await db.batch([
    db.update(schema.budgetRounds).set({ status: 'confirmed', confirmedAt: now }).where(eq(schema.budgetRounds.id, round.id)),
    ...approvalsOf(marks, mainTableOf),
    ...insertsOf(appends, mainTableOf),
    // 補正予算：⑦の最新の行も承認済みにしておく
    ...(round.kind === '補正予算' ? approvalsOf([...latest.values()], revisedTableOf) : []),
  ] as const)
  const { lines } = await rebuildCurrentBudget({ settlePreExecutions: round.kind === '本予算' })
  return { count: lines.length, total: lines.reduce((s, l) => s + l.budgetAmount, 0) }
}

/** 集約を中止する（その集約で書いた案の行・⑤・局・担当を消す。①の承認済みの行と、確定した予算は変わらない） */
export async function cancelRound(round: BudgetRound) {
  const db = useDb()
  await db.batch([
    db.delete(schema.budgetReviews).where(eq(schema.budgetReviews.roundId, round.id)),
    ...mainTables().map(t => db.delete(t).where(and(eq(t.roundId, round.id), eq(t.status, 'draft')))),
    ...revisedTables().map(t => db.delete(t).where(eq(t.roundId, round.id))),
    db.delete(schema.budgetTeams).where(eq(schema.budgetTeams.roundId, round.id)),
    db.delete(schema.budgetDepartments).where(eq(schema.budgetDepartments.roundId, round.id)),
    db.delete(schema.budgetBureaus).where(eq(schema.budgetBureaus.roundId, round.id)),
    db.delete(schema.budgetRounds).where(eq(schema.budgetRounds.id, round.id)),
  ])
  // 消した明細と結んでいた予算前執行を、未追加に戻す
  await unlinkPreExecutions()
}

/**
 * 執行依頼で選ぶ予算（budget_lines）と「支出」シートの行を、①の承認済みの最新の行から作り直す（予算提出・承認の出力）。
 * settlePreExecutions なら（本予算の確定のとき）、予算前執行の執行依頼を本予算の項目に付け替える。
 */
export async function rebuildCurrentBudget(options: { settlePreExecutions?: boolean } = {}) {
  const db = useDb()
  const [rows, confirmed] = await Promise.all([currentRows(), latestConfirmedRound()])
  const roundTeams = confirmed ? (await teamsOf(confirmed.id)).teams : []
  // 局・担当の並び：確定した集約の順（局の並び → 担当の並び）。そこにない担当は、項目の並びで後ろに足す
  const teams = roundTeams.map((t, i) => ({ id: t.id, bureauNo: t.bureauNo, bureau: t.bureau, team: t.team, person: '', sortOrder: i }))
  for (const r of [...rows].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!teams.some(t => t.bureau === r.bureau && t.team === r.team)) {
      teams.push({ id: -teams.length - 1, bureauNo: bureauNoOf(r.itemNumber), bureau: r.bureau, team: r.team, person: '', sortOrder: 1e6 + teams.length })
    }
  }
  const items = rows.map(r => ({ ...r, teamId: teams.find(t => t.bureau === r.bureau && t.team === r.team)!.id }))
  const numbers = new Map(items.map(i => [i.id, i.itemNumber]))
  const parsed = parseBudgetRows(confirmSheetRows(teams, items, numbers))
  const itemIdOf = new Map(rows.map(r => [r.itemNumber, r.itemId]))
  const lines = parsed.lines.map(l => ({ ...l, itemId: itemIdOf.get(l.itemNumber) ?? '' }))
  await replaceBudgetLines(lines, parsed.sheetRows, confirmed?.kind ?? '本予算')
  await repointLineKeys(lines)
  if (options.settlePreExecutions) await settlePreExecutions(lines)
  return { lines }
}
