import { eq } from 'drizzle-orm'

/** 締めていない期を消す（財務局長・管理者） */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageCashbook')
  const id = Number(getRouterParam(event, 'id'))
  const db = useDb()
  const period = await db.query.accountingPeriods.findFirst({ where: eq(schema.accountingPeriods.id, id) })
  if (!period) throw createError({ statusCode: 404, message: '期が見つかりません。' })
  if (period.closedAt) throw createError({ statusCode: 409, message: '締めた期は消せません。先に締めを解除してください。' })
  await db.delete(schema.accountingPeriods).where(eq(schema.accountingPeriods.id, id))
  return { ok: true }
})
