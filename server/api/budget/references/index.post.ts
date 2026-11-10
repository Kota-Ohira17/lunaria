import { BUDGET_REFERENCE_KINDS } from '../../../db/schema'
import type { ReferenceKind } from '../../../utils/budgetReference'

/**
 * 昨年の本予算・決算を CSV で取り込む（財務局長・財務局長補佐・管理者）。kind=budget は「支出」シート、settlement は「支出詳細」シート、
 * incomeBudget は「収入」シート、incomeSettlement は「収入詳細」シート。
 * 同じ種類を取り込み直すと入れ替える。本予算の集約で、担当の画面に参考として出す。
 */
export default defineEventHandler(async (event) => {
  const user = await requireArrangeBudget(event)
  const parts = (await readMultipartFormData(event)) ?? []
  const file = parts.find(p => p.name === 'file' && p.data.length > 0)
  if (!file) throw createError({ statusCode: 400, message: 'CSV ファイルを選んでください。' })
  const kind = parts.find(p => p.name === 'kind')?.data.toString()
  if (!(BUDGET_REFERENCE_KINDS as readonly string[]).includes(kind ?? '')) throw createError({ statusCode: 400, message: '本予算か決算か（支出・収入）を選んでください。' })
  return await importReference(kind as ReferenceKind, file.filename ?? '', file.data, user)
})
