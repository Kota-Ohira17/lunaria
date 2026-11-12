import { eq } from 'drizzle-orm'

/**
 * ユーザーを削除する（財務局長・財務局長補佐・管理者のみ）。削除された人はログアウトされ、次にログインすると一般として登録し直される。
 * 申請はメールアドレスで持っているので、削除しても過去の申請は残る。
 */
export default defineEventHandler(async (event) => {
  const me = await requirePermission(event, 'manageUsers')
  const email = decodeURIComponent(getRouterParam(event, 'email') ?? '').toLowerCase()
  if (email === me.email) throw createError({ statusCode: 400, message: '自分自身は削除できません。' })

  const target = await findUserOr404(email)
  await assertCanRemoveManager(target)

  await useDb().delete(schema.users).where(eq(schema.users.email, email))
  return { ok: true }
})
