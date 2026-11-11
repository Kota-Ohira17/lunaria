import { eq } from 'drizzle-orm'
import { can } from '../../../shared/roles'

/** 収入の記録を取り消す（確認待ちの間は記録した本人、いつでも財務局長・財務局長補佐・管理者）。証憑も消す */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = Number(getRouterParam(event, 'id'))
  const db = useDb()
  const income = await db.query.incomeRecords.findFirst({ where: eq(schema.incomeRecords.id, id) })
  if (!income) throw createError({ statusCode: 404, message: '収入の記録が見つかりません。' })
  const staff = can(user.role, 'executeEntries')
  if (!staff && (income.applicantEmail !== user.email || income.status !== 'pending')) {
    throw createError({ statusCode: 403, message: '取り消せるのは、確認待ちの間の記録した本人と、財務局長・財務局長補佐・管理者です。' })
  }
  const files = await db.select().from(schema.incomeFiles).where(eq(schema.incomeFiles.incomeId, id))
  await db.batch([
    db.delete(schema.incomeFiles).where(eq(schema.incomeFiles.incomeId, id)),
    db.delete(schema.incomeRecords).where(eq(schema.incomeRecords.id, id)),
  ])
  await deleteAttachments(files.map(f => f.attachmentId))
  await syncVoucher('income', id, user.email)
  return { ok: true }
})
