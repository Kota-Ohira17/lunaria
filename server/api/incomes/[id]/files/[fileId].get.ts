import { and, eq } from 'drizzle-orm'

/** 収入の証憑のファイル（だれでも見られる） */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  const id = Number(getRouterParam(event, 'id'))
  const fileId = Number(getRouterParam(event, 'fileId'))
  const db = useDb()
  const f = await db.query.incomeFiles.findFirst({ where: and(eq(schema.incomeFiles.id, fileId), eq(schema.incomeFiles.incomeId, id)) })
  if (!f) throw createError({ statusCode: 404 })
  return sendAttachment(event, f.attachmentId)
})
