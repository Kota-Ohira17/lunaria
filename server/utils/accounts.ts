import { and, eq, gte, isNotNull, lte } from 'drizzle-orm'
import type { AccountKind } from '../../shared/constants'
import { CASH_ACCOUNT_TITLES } from '../../shared/constants'
import type { Account, AccountingPeriod, GlEntry } from '../db/schema'

/**
 * ⑭勘定科目DB と ⑮会計期間DB。
 * 科目は ERPNext の Account、期は Accounting Period にならう。
 */

const CASH_TITLES = new Set<string>(Object.values(CASH_ACCOUNT_TITLES))
/** 仕訳を作る処理が使う決まった科目 */
export const SYSTEM_ACCOUNTS: Record<string, AccountKind> = {
  前期繰越: '純資産',
  雑収入: '収入',
  雑費: '支出',
  予算にない支出: '支出',
  予算にない収入: '収入',
  予算前執行: '支出',
}

/** 科目の出どころ（自動で足すときに付ける） */
function originOf(name: string, voucherType: GlEntry['voucherType']): Account['origin'] {
  if (CASH_TITLES.has(name)) return 'cash'
  if (name in SYSTEM_ACCOUNTS) return 'system'
  return voucherType === 'manual' ? 'manual' : 'budget'
}

/** 仕訳で使う科目がなければ足す（すでにあれば変えない） */
export async function ensureAccounts(lines: { account: string, kind: AccountKind }[], voucherType: GlEntry['voucherType']) {
  const seen = new Map<string, AccountKind>()
  for (const l of lines) if (!seen.has(l.account)) seen.set(l.account, l.kind)
  if (!seen.size) return
  const now = new Date()
  const rows = [...seen].map(([name, kind]) => ({ name, kind, origin: originOf(name, voucherType), createdAt: now }))
  for (let i = 0; i < rows.length; i += 100) await useDb().insert(schema.accounts).values(rows.slice(i, i + 100)).onConflictDoNothing()
}

/** 締めた期（日付の古い順） */
export async function closedPeriods() {
  return useDb().select().from(schema.accountingPeriods).where(isNotNull(schema.accountingPeriods.closedAt))
}

/** その日付が入る締めた期（なければ undefined） */
export const closedPeriodOf = (date: string, periods: AccountingPeriod[]) =>
  periods.find(p => p.closedAt && p.startDate <= date && date <= p.endDate)

/** 締めた期に入る日付があれば 409 */
export async function assertPeriodsOpen(dates: string[], periods?: AccountingPeriod[]) {
  const list = periods ?? await closedPeriods()
  for (const d of dates) {
    const p = closedPeriodOf(d, list)
    if (p) throw createError({ statusCode: 409, message: `${d} は締めた期「${p.name}」に入るので、仕訳を足すことも取り消すこともできません。期の締めを解除してから行ってください。` })
  }
}

/** もとの記録の、今ある仕訳の日付 */
export async function postedDates(type: GlEntry['voucherType'], id: number) {
  const g = schema.glEntries
  const rows = await useDb().selectDistinct({ date: g.postingDate }).from(g).where(and(eq(g.voucherType, type), eq(g.voucherId, id), eq(g.isCancelled, false)))
  return rows.map(r => r.date)
}

/** 記録を変える前に：今ある仕訳と、これから足す仕訳の日付が締めた期に入らないか */
export async function assertVoucherOpen(type: GlEntry['voucherType'], id: number, nextDates: string[] = []) {
  await assertPeriodsOpen([...await postedDates(type, id), ...nextDates])
}

/** 期が重なっていないか（同じ日を2つの期に入れない） */
export async function assertNoOverlap(startDate: string, endDate: string, exceptId?: number) {
  const p = schema.accountingPeriods
  const overlap = await useDb().select().from(p).where(and(lte(p.startDate, endDate), gte(p.endDate, startDate)))
  const other = overlap.find(o => o.id !== exceptId)
  if (other) throw createError({ statusCode: 409, message: `期「${other.name}」（${other.startDate}〜${other.endDate}）と日付が重なっています。` })
}
