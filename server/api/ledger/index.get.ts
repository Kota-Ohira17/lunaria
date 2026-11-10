/** 帳簿（財務局長・財務局長補佐・管理者）。仕訳帳・総勘定元帳・試算表 */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageCashbook')
  return buildLedger()
})
