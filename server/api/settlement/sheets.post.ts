import { z } from 'zod'

const bodySchema = z.object({
  spreadsheetUrl: z.string().trim().min(1, '出力先のスプレッドシートの URL を入力してください。'),
  /** true のときは Google に送らず、書き出す予定の内容の概要だけ返す（設定の確認用） */
  dryRun: z.boolean().default(false),
})

/**
 * 決算シートを Google スプレッドシートに書き出す（財務局長・財務局長補佐・管理者のみ）。
 * 「決算」「執行一覧」シートを書き直す（なければ追加する）。ほかのシートには触らない。
 */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'exportSettlement')
  const { spreadsheetUrl, dryRun } = parseOr400(bodySchema.safeParse(await readBody(event)))
  const spreadsheetId = spreadsheetIdOf(spreadsheetUrl)
  if (!spreadsheetId) throw createError({ statusCode: 400, message: 'スプレッドシートの URL を確認してください（https://docs.google.com/spreadsheets/d/… の形）。' })

  const tables = await buildSettlementTables(getRequestURL(event).origin)
  return writeTablesToSpreadsheet(spreadsheetId, tables, { token: await sheetsAccessToken(event), dryRun })
})
