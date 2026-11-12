import { asc } from 'drizzle-orm'

/** ユーザー一覧（財務局長・財務局長補佐・管理者のみ） */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageUsers')
  const users = await useDb().select().from(schema.users).orderBy(asc(schema.users.email))
  return users.map(toUserView)
})
