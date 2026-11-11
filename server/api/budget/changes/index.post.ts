import { eq } from 'drizzle-orm'
import { BUDGET_TERM } from '../../../../shared/constants'
import { budgetChangeSchema } from '../../../../shared/schemas'

/** 予算の変更（新規・変更・削除。支出だけ）。その担当の人は②に申請（承認待ち）、承認する人（管理者と ZAI の zas）はそのまま①に反映する */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = parseOr400(budgetChangeSchema.safeParse(await readBody(event)))
  const { teams, rows } = await currentBudget()
  const team = teams.find(t => t.id === body.teamId)
    ?? (() => {
      // 確定した集約にない担当（id は負の数で渡る）は、今の予算の項目から探す
      const r = body.itemNumber ? rows.find(x => x.itemNumber === body.itemNumber) : null
      return r ? { bureau: r.bureau, team: r.team } : null
    })()
  if (!team) throw createError({ statusCode: 404, message: '担当が見つかりません。' })
  if (!(await canRequestChange(user, team))) throw createError({ statusCode: 403, message: 'この担当の予算は変更を申請できません。' })
  const draft = { kind: body.kind, bureau: team.bureau, team: team.team, itemNumber: body.kind === 'add' ? '' : body.itemNumber!, after: body.values ?? null }
  const { row } = await checkChange(draft)
  await assertNoPending(row?.itemId ?? '')

  const direct = await canApproveBudgetChange(user)
  const [change] = await useDb().insert(schema.budgetChangeRequests).values({
    id: newId(),
    term: BUDGET_TERM,
    ...draft,
    itemId: row?.itemId ?? '',
    after: body.kind === 'delete' ? null : body.values!,
    before: row ? itemValues(row) : null,
    reason: body.reason,
    sortOrder: row?.sortOrder ?? 0,
    direct,
    createdAt: new Date(),
    createdBy: user.email,
  }).returning()
  if (direct) {
    try {
      await applyChange(change!, user)
    }
    catch (error) {
      // 反映できなかった直接の変更は、記録にも残さない
      await useDb().delete(schema.budgetChangeRequests).where(eq(schema.budgetChangeRequests.id, change!.id))
      throw error
    }
  }
  return { id: change!.id, applied: direct }
})
