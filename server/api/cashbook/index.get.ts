/** 出納帳（財務局長・財務局長補佐・管理者）。口座ごとの残高・出入り・残高の照合・口座の決まらない記録 */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageCashbook')
  return buildCashbook()
})
