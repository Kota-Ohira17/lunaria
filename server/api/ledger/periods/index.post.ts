import { periodSchema } from '../../../../shared/schemas'

/** 会計期間を足す（財務局長・管理者）。ほかの期と日付が重なってはいけない */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'manageCashbook')
  const input = parseOr400(periodSchema.safeParse(await readBody(event)))
  await assertNoOverlap(input.startDate, input.endDate)
  const [row] = await useDb().insert(schema.accountingPeriods).values({ ...input, createdBy: user.email, createdAt: new Date() }).returning()
  setResponseStatus(event, 201)
  return row
})
