import { budgetItemSchema } from '../../../../shared/schemas'

/**
 * 明細を直す（その担当の人・財務管理部）。予算前執行と結んだ明細は直せない。①⑦に行を足す。担当の人が直すと未提出に戻り、提出し直して査定を受ける。
 * 款を変えたら、項目番号を新しい款の番号に振り直し（執行で使った項目は変えない）、並びを新しい款のいちばん後ろに移す
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { row, team, round, status } = await openItemOr404(String(getRouterParam(event, 'id')))
  await assertCanChangeItem(user, status, team, round)
  await assertNotPreExecutionItem(row.itemId)
  const body = parseOr400(budgetItemSchema.safeParse(await readBody(event)))
  const moved = body.kan === row.kan
    ? {}
    : {
        itemNumber: await numberForKan(round, row, team, body.kan),
        sortOrder: sortOrderFor([...(await roundState(round)).latest.values()].filter(r => r.itemId !== row.itemId), team, body.kan),
      }
  return writeItem(round, row, { ...(body as ItemValues), ...moved }, user, status)
})
