import { eq } from 'drizzle-orm'
import { accountUpdateSchema } from '../../../../shared/schemas'

/** 勘定科目の番号・使うかどうか・区分を直す（財務局長・管理者）。区分は仕訳で使う前だけ。名前は変えない（仕訳が名前で指すため） */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageCashbook')
  const name = getRouterParam(event, 'name', { decode: true }) ?? ''
  const input = parseOr400(accountUpdateSchema.safeParse(await readBody(event)))
  const db = useDb()
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.name, name) })
  if (!account) throw createError({ statusCode: 404, message: '勘定科目が見つかりません。' })
  if (input.kind && input.kind !== account.kind) {
    const [used] = await db.select({ id: schema.glEntries.id }).from(schema.glEntries).where(eq(schema.glEntries.account, name)).limit(1)
    if (used) throw createError({ statusCode: 409, message: '仕訳で使った科目の区分は変えられません。' })
  }
  const [row] = await db.update(schema.accounts).set(input).where(eq(schema.accounts.name, name)).returning()
  return row
})
