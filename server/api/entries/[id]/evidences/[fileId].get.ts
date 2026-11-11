import { and, eq } from 'drizzle-orm'

/** 申請に付けた証憑のファイル。申請を見られる人のみ */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = Number(getRouterParam(event, 'id'))
  const fileId = Number(getRouterParam(event, 'fileId'))
  const db = useDb()
  const entry = await db.query.entries.findFirst({ where: eq(schema.entries.id, id) })
  const ev = await db.query.evidenceFiles.findFirst({
    where: and(eq(schema.evidenceFiles.id, fileId), eq(schema.evidenceFiles.entryId, id)),
  })
  if (!entry || !ev || !canSeeEntry(user, entry)) throw createError({ statusCode: 404 })
  return sendAttachment(event, ev.attachmentId)
})
