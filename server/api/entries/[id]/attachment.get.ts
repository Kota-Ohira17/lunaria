import { eq } from 'drizzle-orm'

/** 添付ファイル（請求書・証憑）。申請を見られる人（canSeeEntry）のみ */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = Number(getRouterParam(event, 'id'))
  const db = useDb()
  const entry = await db.query.entries.findFirst({ where: eq(schema.entries.id, id) })
  if (!entry?.attachmentId || !canSeeEntry(user, entry)) {
    throw createError({ statusCode: 404 })
  }
  return sendAttachment(event, entry.attachmentId)
})
