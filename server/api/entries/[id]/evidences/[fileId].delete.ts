import { and, eq } from 'drizzle-orm'

/** 間違えて付けた証憑を外す（付けた本人か、財務局長・財務局長補佐・管理者）。証憑が変わるので、確認済みは外して確認待ちに戻す */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = Number(getRouterParam(event, 'id'))
  const fileId = Number(getRouterParam(event, 'fileId'))
  const db = useDb()
  const ev = await db.query.evidenceFiles.findFirst({
    where: and(eq(schema.evidenceFiles.id, fileId), eq(schema.evidenceFiles.entryId, id)),
  })
  if (!ev) throw createError({ statusCode: 404, message: '証憑が見つかりません。' })
  if (!canDeleteEvidence(user, ev)) throw createError({ statusCode: 403, message: '証憑を外せるのは付けた本人と財務局長・財務局長補佐・管理者です。' })

  await db.batch([
    db.delete(schema.evidenceFiles).where(eq(schema.evidenceFiles.id, fileId)),
    db.update(schema.entries).set({ evidenceCheckedAt: null, evidenceCheckedBy: null }).where(eq(schema.entries.id, id)),
  ])
  await deleteAttachments([ev.attachmentId])
  return (await evidencesOf([id])).get(id) ?? []
})
