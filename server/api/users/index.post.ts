/**
 * 委員を先に登録して権限を付ける（財務局長・財務局長補佐・管理者のみ）。まだログインしていない人にも権限を用意しておける。
 * 本人が初めてログインしたとき、ここで付けた権限がそのまま使われる。
 */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageUsers')
  const body = parseOr400(newUserSchema.safeParse(await readBody(event)))
  if (!isAllowedEmail(body.email)) {
    throw createError({ statusCode: 400, message: `@${serverConfig().allowedEmailDomain} のアドレスを入力してください。` })
  }

  const [created] = await useDb()
    .insert(schema.users)
    .values({
      email: body.email,
      name: body.name || body.email.split('@')[0]!,
      role: body.role,
      createdAt: new Date(),
      lastLoginAt: null,
    })
    .onConflictDoNothing()
    .returning()
  if (!created) throw createError({ statusCode: 409, message: 'このメールアドレスはすでに登録されています。' })

  setResponseStatus(event, 201)
  return toUserView(created)
})
