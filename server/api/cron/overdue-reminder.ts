import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import { shortenItemNumbers } from '../../../shared/itemNumbers'

/**
 * 期限を過ぎても未対応の執行依頼を Slack（n8n 経由）でリマインドする。
 * 1日1回、n8n のスケジュールか Vercel の Cron から呼ぶ（README 参照）。
 * - 認証: 合言葉（NUXT_CRON_SECRET、または Vercel の CRON_SECRET）を
 *   「Authorization: Bearer 合言葉」か「X-Cron-Secret: 合言葉」で送る。合言葉が未設定なら使えない（404）
 * - 期限切れ: 期限の日付が今日（日本時間）より前
 * - ?dryRun=1 なら Slack には送らず、送る予定の内容だけ返す
 */
export default defineEventHandler(async (event) => {
  const secret = serverConfig().cronSecret || process.env.CRON_SECRET || ''
  if (!secret) throw createError({ statusCode: 404 })
  const auth = getHeader(event, 'authorization') ?? ''
  if (auth !== `Bearer ${secret}` && getHeader(event, 'x-cron-secret') !== secret) {
    throw createError({ statusCode: 401, message: '合言葉が違います。' })
  }

  const today = todayInJapan()
  const e = schema.entries
  const rows = await useDb()
    .select()
    .from(e)
    .where(and(
      eq(e.status, 'pending'),
      eq(e.kind, 'execution'),
      isNotNull(e.deadline),
      // 期限は「2026-10-20」か「2026-10-20T10:00」。日付の部分で比べる
      sql`substr(${e.deadline}, 1, 10) < ${today}`,
    ))
    .orderBy(asc(e.deadline), asc(e.createdAt))

  const overdue = rows.map(r => ({
    seq: r.seq,
    type: r.type,
    itemNumber: shortenItemNumbers(r.itemNumber),
    itemName: r.itemName,
    amount: r.amount,
    deadline: r.deadline!.slice(0, 10),
    daysOverdue: daysBetween(r.deadline!.slice(0, 10), today),
    applicantName: r.applicantName,
    department: r.department,
    inCharge: r.inCharge,
    site: r.type === '発注' ? String((r.details as { site?: string }).site ?? '') : '',
  }))

  const url = `${getRequestURL(event).origin}/entries?view=pending`
  const text = overdue.length ? reminderText(overdue, url) : ''
  const dryRun = getQuery(event).dryRun === '1'
  const sent = overdue.length && !dryRun ? await postToN8n({ event: 'overdue', overdue, text, url }) : false
  return { today, count: overdue.length, sent, text, overdue }
})

type Overdue = { seq: string, type: string, itemName: string, deadline: string, daysOverdue: number, applicantName: string, department: string, inCharge: string, site: string }

/** Slack に投稿する本文 */
function reminderText(list: Overdue[], url: string) {
  return [
    `期限を過ぎた未対応の申請が${list.length}件あります。`,
    ...list.map(o => `・${o.seq} ${o.itemName}（${o.site ? `発注・${o.site}` : o.type}／期限 ${o.deadline}・${o.daysOverdue}日超過／${o.applicantName} ${o.department}/${o.inCharge}）`),
    `台帳（未対応）: ${url}`,
  ].join('\n')
}

/** 「2026-10-15」から「2026-10-17」までの日数（2） */
function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)
}
