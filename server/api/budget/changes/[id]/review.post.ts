import { eq } from 'drizzle-orm'
import { budgetChangeReviewSchema } from '../../../../../shared/schemas'

/** 予算の変更の申請を承認する（①に行を足す）か、理由を付けて却下する（管理者と ZAI の zas） */
export default defineEventHandler(async (event) => {
  const user = await requireApproveBudgetChange(event)
  const id = String(getRouterParam(event, 'id'))
  const change = await useDb().query.budgetChangeRequests.findFirst({ where: eq(schema.budgetChangeRequests.id, id) })
  if (!change) throw createError({ statusCode: 404, message: '変更が見つかりません。' })
  if (change.status !== 'pending') throw createError({ statusCode: 409, message: '承認待ちの変更ではありません。' })
  const { decision, comment } = parseOr400(budgetChangeReviewSchema.safeParse(await readBody(event)))
  if (decision === 'approve') {
    await applyChange(change, user, comment)
    return { ok: true }
  }
  await useDb().update(schema.budgetChangeRequests)
    .set({ status: 'rejected', reviewComment: comment, reviewedAt: new Date(), reviewedBy: user.email })
    .where(eq(schema.budgetChangeRequests.id, id))
  return { ok: true }
})
