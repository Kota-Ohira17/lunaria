import { eq, isNotNull } from 'drizzle-orm'

/** 一度に移す件数（サーバーレスの時間切れにならないように少しずつ。画面がなくなるまで繰り返し呼ぶ） */
const BATCH = 10

/**
 * DB に中身がある添付ファイルを Google ドライブに移す（管理者のみ）。
 * ドライブに上げてリンクを持たせてから、DB の中身を消す。残りの件数を返す。
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  if (user.role !== 'admin') throw createError({ statusCode: 403 })
  if (!driveEnabled()) throw createError({ statusCode: 400, message: 'Google ドライブの設定がありません（NUXT_GOOGLE_DRIVE_*）。' })
  const db = useDb()
  const files = await db.select().from(schema.attachments).where(isNotNull(schema.attachments.data)).limit(BATCH)
  for (const f of files) {
    const uploaded = await uploadToDrive(f.fileName, f.contentType, f.data!)
    await db.update(schema.attachments).set({ ...uploaded, data: null }).where(eq(schema.attachments.id, f.id))
  }
  const rest = await db.select({ id: schema.attachments.id }).from(schema.attachments).where(isNotNull(schema.attachments.data))
  return { moved: files.length, remaining: rest.length }
})
