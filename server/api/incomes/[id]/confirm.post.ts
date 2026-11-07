import { eq } from 'drizzle-orm'
import { incomeConfirmSchema } from '../../../../shared/schemas'

/** 入金を確かめた（確認済み）／確認待ちに戻す（財務局長・管理者） */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'executeEntries')
  const id = Number(getRouterParam(event, 'id'))
  const { done } = parseOr400(incomeConfirmSchema.safeParse(await readBody(event)))
  const [updated] = await useDb().update(schema.incomeRecords)
    .set(done
      ? { status: 'done', confirmedAt: new Date(), confirmedBy: user.email }
      : { status: 'pending', confirmedAt: null, confirmedBy: null })
    .where(eq(schema.incomeRecords.id, id))
    .returning()
  if (!updated) throw createError({ statusCode: 404, message: '収入の記録が見つかりません。' })
  await syncVoucher('income', id, user.email)
  const [view] = await withIncomeFiles([updated])
  return view
})
