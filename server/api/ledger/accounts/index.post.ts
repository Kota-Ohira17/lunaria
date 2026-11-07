import { accountSchema } from '../../../../shared/schemas'

/** 勘定科目を足す（財務局長・管理者） */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageCashbook')
  const input = parseOr400(accountSchema.safeParse(await readBody(event)))
  const [row] = await useDb().insert(schema.accounts).values({ ...input, origin: 'manual', createdAt: new Date() }).onConflictDoNothing().returning()
  if (!row) throw createError({ statusCode: 409, message: `「${input.name}」はもうあります。` })
  setResponseStatus(event, 201)
  return row
})
