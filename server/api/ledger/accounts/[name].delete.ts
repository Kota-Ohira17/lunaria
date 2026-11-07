import { eq } from 'drizzle-orm'

/** 手で足した、仕訳で使っていない勘定科目を消す（財務局長・管理者） */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageCashbook')
  const name = getRouterParam(event, 'name', { decode: true }) ?? ''
  const db = useDb()
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.name, name) })
  if (!account) throw createError({ statusCode: 404, message: '勘定科目が見つかりません。' })
  if (account.origin !== 'manual') throw createError({ statusCode: 409, message: '自動で足した科目は消せません。使わないなら「使わない」にしてください。' })
  const [used] = await db.select({ id: schema.glEntries.id }).from(schema.glEntries).where(eq(schema.glEntries.account, name)).limit(1)
  if (used) throw createError({ statusCode: 409, message: '仕訳で使った科目は消せません。使わないなら「使わない」にしてください。' })
  await db.delete(schema.accounts).where(eq(schema.accounts.name, name))
  return { ok: true }
})
