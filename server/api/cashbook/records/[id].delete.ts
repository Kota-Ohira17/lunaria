import { eq } from 'drizzle-orm'

/** 出納帳に手で書いた記録を取り消す（財務局長・財務局長補佐・管理者） */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'manageCashbook')
  const id = Number(getRouterParam(event, 'id'))
  const [deleted] = await useDb().delete(schema.cashbookRecords).where(eq(schema.cashbookRecords.id, id)).returning()
  if (!deleted) throw createError({ statusCode: 404, message: '記録が見つかりません。' })
  await syncVoucher('cashbook', id, user.email)
  return { ok: true }
})
