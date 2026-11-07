import { and, eq, sql } from 'drizzle-orm'
import { bureauNameOf } from '../../shared/constants'
import type { BudgetItemRow, BudgetRound, BudgetTeam } from '../db/schema'
import type { ParsedBudgetLine } from './budget'

/**
 * 予算前執行。本予算が確定する前に、新しい年度の分を執行した記録。専用の表は持たず、執行依頼（③）の details に持つ。
 * - preExecution：予算前執行の印 / preExecutionReason：必要な理由
 * - preExecutionItemId：「明細に追加」で結んだ明細の内部 ID（item_id）
 * - preExecutionSettled：本予算の確定で付け替え済み
 * 本予算の集約では、担当の画面にその担当の予算前執行を出し、「明細に追加」で今年の明細にする。
 * 本予算が確定したら、結んだ明細（なければ同じ局・担当で同じ名前の予算明細）に、その執行依頼を付け替える。
 */

const e = schema.entries
/** 本予算への付け替えがまだの予算前執行 */
const waiting = () => and(
  sql`json_extract(${e.details}, '$.preExecution') = 1`,
  sql`json_extract(${e.details}, '$.preExecutionSettled') is null`,
)
const itemIdOf = (entry: { details: unknown }) => String((entry.details as { preExecutionItemId?: unknown }).preExecutionItemId ?? '')

/** 依頼に書いた担当名に合う担当（同じ局で、英語名か日本語名が同じもの。完全に同じものを先に探し、なければ大文字・小文字を区別しない） */
function teamOfPreExecution<T extends Pick<BudgetTeam, 'bureau' | 'team' | 'nameJa'>>(teams: T[], p: { bureau: string, team: string }) {
  const name = p.team.trim()
  const same = teams.filter(t => t.bureau === p.bureau)
  return same.find(t => t.team === name || t.nameJa === name)
    ?? same.find(t => [t.team, t.nameJa].some(n => n.toLowerCase() === name.toLowerCase()))
    ?? null
}

/**
 * 本予算の集約の画面に出す、まだ本予算に付け替えていない予算前執行。id は執行依頼の id。
 * teamId は依頼に書いた担当名に合う担当（合わなければ null。同じ局の担当の画面で明細にできる）。
 * itemNumber は結んだ明細の項目番号（明細を消していたら空＝未追加に戻る）。
 */
export async function pendingPreExecutions(round: BudgetRound, teams: BudgetTeam[], latest: Map<string, BudgetItemRow>) {
  if (round.kind !== '本予算') return []
  const list = await useDb().select().from(e).where(waiting())
  return list
    .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())
    .map((entry) => {
      const bureau = bureauNameOf(entry.department)
      const itemId = itemIdOf(entry)
      const linked = itemId ? latest.get(itemId) : undefined
      return {
        id: entry.id,
        teamId: teamOfPreExecution(teams, { bureau, team: entry.inCharge })?.id ?? null,
        bureau,
        team: entry.inCharge,
        seq: entry.seq,
        itemName: entry.itemName,
        amount: entry.amount ?? 0,
        reason: String((entry.details as { preExecutionReason?: unknown }).preExecutionReason ?? ''),
        itemNumber: linked && !linked.deleted ? linked.itemNumber : '',
      }
    })
}

/** 予算前執行を明細にしてよいかを確かめる（同じ局の、その担当か担当の分からないもの。支出だけ。もう明細になっていないもの） */
export async function preExecutionToLink(round: BudgetRound, team: BudgetTeam, id: number, flow: string) {
  if (flow !== 'expense') throw createError({ statusCode: 400, message: '予算前執行は支出の明細にしてください。' })
  const { teams, latest } = await roundState(round)
  const found = (await pendingPreExecutions(round, teams, latest)).find(p => p.id === id)
  if (!found) throw createError({ statusCode: 404, message: '予算前執行が見つかりません。ページを再読み込みしてください。' })
  if (found.bureau !== team.bureau || (found.teamId != null && found.teamId !== team.id)) throw createError({ statusCode: 400, message: 'この予算前執行は、別の担当のものです。' })
  if (found.itemNumber) throw createError({ statusCode: 409, message: `この予算前執行は、もう明細（${found.itemNumber}）になっています。` })
}

/** 予算前執行と、足した明細を結ぶ */
export const linkPreExecution = (id: number, itemId: string) =>
  useDb().update(e).set({ details: sql`json_set(${e.details}, '$.preExecutionItemId', ${itemId})` }).where(eq(e.id, id))

/** 集約を中止したとき：消した明細と結んでいた予算前執行を、未追加に戻す */
export const unlinkPreExecutions = () =>
  useDb().update(e).set({ details: sql`json_remove(${e.details}, '$.preExecutionItemId')` }).where(waiting())

/** 支出項目名が、予算明細の名前に合うか（名前そのもの、または項・目・節のどれか） */
const matches = (line: ParsedBudgetLine, name: string) => {
  const n = name.trim()
  return !!n && (line.label === n || [line.kan, line.kou, line.moku, line.setsu].includes(n))
}

/**
 * 本予算が確定したとき：まだ付け替えていない予算前執行を、確定した予算明細に付け替える。
 * 「明細に追加」で結んだ明細を先に使い、なければ同じ局・担当で名前の合う明細を探す。
 * 執行依頼に、その明細との対応（entry_items）を足し、項目番号もその明細の番号にする。合う明細がなければ付け替え済みの印だけ付ける（項目番号は「予算前執行」のまま）。
 */
export async function settlePreExecutions(lines: (ParsedBudgetLine & { itemId: string })[]) {
  const db = useDb()
  const list = await db.select().from(e).where(waiting())
  for (const entry of list) {
    const bureau = bureauNameOf(entry.department)
    const itemId = itemIdOf(entry)
    const candidates = lines.filter(l => l.bureau === bureau && l.team === entry.inCharge)
    const line = (itemId ? lines.find(l => l.itemId === itemId) : undefined) ?? candidates.find(l => matches(l, entry.itemName)) ?? null
    await db.batch([
      db.update(e).set({
        details: sql`json_set(${e.details}, '$.preExecutionSettled', json('true'))`,
        ...(line ? { itemNumber: line.itemNumber } : {}),
      }).where(eq(e.id, entry.id)),
      ...(line
        ? [db.insert(schema.entryItems).values({
            entryId: entry.id, lineKey: line.key, itemId: line.itemId, itemNumber: line.itemNumber, label: line.label,
            quantity: line.quantity, vendor: line.vendor, budgetAmount: line.budgetAmount, actualAmount: entry.amount,
          })]
        : []),
    ])
    await syncVoucher('execution', entry.id, undefined, { skipClosed: true })
  }
}
