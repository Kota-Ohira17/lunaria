import { eq } from 'drizzle-orm'
import { can } from '../../../shared/roles'

/** ユーザーの権限を変える（財務局長・財務局長補佐・管理者のみ） */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageUsers')
  const email = decodeURIComponent(getRouterParam(event, 'email') ?? '').toLowerCase()
  const body = parseOr400(roleAssignmentSchema.safeParse(await readBody(event)))

  const target = await findUserOr404(email)
  // 環境変数で固定された管理者は変えられず、財務局長・財務局長補佐・管理者が0人になる変更もできない
  if (body.role !== target.role && (isBootstrapAdmin(email) || !can(body.role, 'manageUsers'))) {
    await assertCanRemoveManager(target)
  }

  const [updated] = await useDb()
    .update(schema.users)
    .set({ role: body.role })
    .where(eq(schema.users.email, email))
    .returning()
  return toUserView(updated!)
})
