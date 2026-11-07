import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { PAYMENT_TYPES, VIEWS, type ViewKey } from '../../../shared/constants'
import { can } from '../../../shared/roles'

/**
 * 一覧。旧スプレッドシートの各シートを view で切り替える。
 * 全員がすべての申請を見られる（口座情報は財務局長・管理者のみ。roles.ts の viewAllEntries / viewBankAccount）。
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const raw = String(getQuery(event).view ?? 'deadline')
  const view: ViewKey = raw in VIEWS ? (raw as ViewKey) : 'deadline'
  const e = schema.entries

  const conds: SQL[] = []
  if (!can(user.role, 'viewAllEntries')) conds.push(eq(e.applicantEmail, user.email))

  // 期限が近い順（期限なしは最後）
  const byDeadline = [sql`${e.deadline} is null`, asc(e.deadline), asc(e.createdAt)]
  let orderBy: SQL[]

  if (view === 'number' || view === 'deadline') {
    // 立替も執行依頼の時点で台帳に載せる（証憑は台帳から付ける）
    orderBy = view === 'number' ? [asc(e.itemNumber), asc(e.createdAt)] : byDeadline
  }
  else if (view === 'noEvidence') {
    // 証憑がまだ付いていない執行依頼
    conds.push(sql`not exists (select 1 from ${schema.evidenceFiles} where ${schema.evidenceFiles.entryId} = ${e.id})`)
    orderBy = byDeadline
  }
  else if (view === 'evidenceCheck') {
    // 対応済みで証憑が付いていて、まだ確認も差し戻しもしていない申請
    conds.push(eq(e.status, 'done'))
    conds.push(sql`${e.evidenceCheckedAt} is null and ${e.evidenceReturnComment} = ''`)
    conds.push(sql`exists (select 1 from ${schema.evidenceFiles} where ${schema.evidenceFiles.entryId} = ${e.id})`)
    orderBy = byDeadline
  }
  else if (view === 'pending') {
    conds.push(eq(e.status, 'pending'))
    orderBy = byDeadline
  }
  else {
    conds.push(eq(e.type, view as (typeof PAYMENT_TYPES)[number]))
    orderBy = byDeadline
  }

  const rows = await useDb()
    .select()
    .from(e)
    .where(and(...conds))
    .orderBy(...orderBy)

  const views = await withEvidences(await withItems(rows))
  // 明細に書いてある商品のリンクを、今の予算から付ける
  const keys = [...new Set(views.flatMap(r => r.items.map(i => i.lineKey)))]
  const lines = keys.length
    ? await useDb().select({ key: schema.budgetLines.key, link: schema.budgetLines.link }).from(schema.budgetLines).where(inArray(schema.budgetLines.key, keys))
    : []
  const linkOf = new Map(lines.map(l => [l.key, l.link]))
  return views.map(r => toPublicEntry({ ...r, items: r.items.map(i => ({ ...i, link: linkOf.get(i.lineKey) ?? '' })) }, can(user.role, 'viewBankAccount')))
})
