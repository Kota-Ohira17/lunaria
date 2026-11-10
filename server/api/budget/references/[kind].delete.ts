import { eq } from 'drizzle-orm'
import { BUDGET_REFERENCE_KINDS } from '../../../db/schema'

/** 取り込んだ昨年の本予算・決算（支出・収入）を消す（管理者と、ZAI の zas に割り当てられた人だけ）。コピー済みの明細はそのまま残る */
export default defineEventHandler(async (event) => {
  await requireImportReferences(event)
  const param = getRouterParam(event, 'kind') ?? ''
  const kind = BUDGET_REFERENCE_KINDS.find(k => k === param)
  if (!kind) throw createError({ statusCode: 404, message: '見つかりません。' })
  const db = useDb()
  await db.batch([
    db.delete(schema.budgetReferences).where(eq(schema.budgetReferences.kind, kind)),
    db.delete(schema.budgetReferenceFiles).where(eq(schema.budgetReferenceFiles.kind, kind)),
  ])
  return { ok: true }
})
