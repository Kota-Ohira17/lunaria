import { eq } from 'drizzle-orm'
import { z } from 'zod'

/** 期を締める（done: true）／締めを解除する（false）（財務局長・管理者）。締める前に帳簿をそろえる */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'manageCashbook')
  const id = Number(getRouterParam(event, 'id'))
  const { done } = parseOr400(z.object({ done: z.boolean() }).safeParse(await readBody(event)))
  const db = useDb()
  const period = await db.query.accountingPeriods.findFirst({ where: eq(schema.accountingPeriods.id, id) })
  if (!period) throw createError({ statusCode: 404, message: '期が見つかりません。' })
  // 締める前に、まだ⑬に入っていない記録を入れておく（締めたあとの帳簿がそのまま残るように）
  if (done) await buildJournals()
  const [row] = await db.update(schema.accountingPeriods)
    .set(done ? { closedAt: new Date(), closedBy: user.email } : { closedAt: null, closedBy: null })
    .where(eq(schema.accountingPeriods.id, id)).returning()
  const { closedBy: _by, createdBy: _created, ...view } = row!
  return view
})
