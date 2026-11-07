/** 手で入れた仕訳を取り消す（財務局長・管理者）。締めた期の仕訳は取り消せない */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'manageCashbook')
  const id = Number(getRouterParam(event, 'id'))
  await cancelManualJournal(id, user.email)
  return { ok: true }
})
