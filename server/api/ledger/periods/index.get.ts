import { asc } from 'drizzle-orm'

/** 会計期間の一覧（財務局長・管理者）。締めた人は返さない */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageCashbook')
  const rows = await useDb().select().from(schema.accountingPeriods).orderBy(asc(schema.accountingPeriods.startDate))
  return rows.map(({ closedBy: _by, createdBy: _created, ...r }) => r)
})
