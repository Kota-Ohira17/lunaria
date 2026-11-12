/**
 * 明細を消す（その担当の人・財務管理部）。予算前執行と結んだ明細は消せない。削除の行を足す。
 * 補正予算で写してきた明細は「削除」の印が付いて残り（取り消せる）、査定で承認されると確定したときに予算から消える。
 * それ以外（本予算・今回足した明細）は一覧から消える。
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { row, team, round, status, base } = await openItemOr404(String(getRouterParam(event, 'id')))
  await assertCanChangeItem(user, status, team, round)
  await assertNotPreExecutionItem(row.itemId)
  await writeItem(round, row, { ...itemValues(row), deleted: true }, user, status)
  return { removed: round.kind === '本予算' || !base }
})
