import { isNotNull, sql } from 'drizzle-orm'

/** 添付ファイルの置き場所（管理者のみ）。ドライブの設定があるかと、まだ DB にある添付の件数 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  if (user.role !== 'admin') throw createError({ statusCode: 403 })
  const [row] = await useDb().select({ n: sql<number>`count(*)` }).from(schema.attachments).where(isNotNull(schema.attachments.data))
  return { driveEnabled: driveEnabled(), inDb: row?.n ?? 0 }
})
