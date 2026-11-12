import { and, eq, sql } from 'drizzle-orm'
import { itemsUpdateSchema } from '../../../../shared/schemas'

/**
 * 明細ごとの実際の執行額・数量・取引先を直す（財務局長・財務局長補佐・管理者のみ）。対応済みにする前後どちらでもよい。
 * 申請の金額は、すべての明細に執行額が入っていればその合計にそろえる。
 */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'executeEntries')
  const id = Number(getRouterParam(event, 'id'))
  const { amounts, quantities, vendors } = parseOr400(itemsUpdateSchema.safeParse(await readBody(event)))
  const db = useDb()
  const entry = await db.query.entries.findFirst({ where: eq(schema.entries.id, id) })
  if (!entry) throw createError({ statusCode: 404, message: '申請が見つかりません。' })

  const changes = new Map<number, Partial<typeof schema.entryItems.$inferInsert>>()
  const put = (itemId: string, change: Partial<typeof schema.entryItems.$inferInsert>) =>
    changes.set(Number(itemId), { ...changes.get(Number(itemId)), ...change })
  for (const [itemId, v] of Object.entries(amounts)) put(itemId, { actualAmount: v })
  for (const [itemId, v] of Object.entries(quantities)) put(itemId, { actualQuantity: v || null })
  for (const [itemId, v] of Object.entries(vendors)) put(itemId, { actualVendor: v || null })

  // D1 は対話的なトランザクションを使えないので batch で書く。
  // 全明細に執行額が入っていれば、申請の金額を合計にそろえる（入っていない明細があれば変えない）
  const ei = schema.entryItems
  const itemUpdates = [...changes].map(([itemId, change]) => db.update(ei).set(change).where(and(eq(ei.id, itemId), eq(ei.entryId, id))))
  const results = await db.batch([
    db.select({ id: ei.id }).from(ei).limit(0),
    ...itemUpdates,
    db.update(schema.entries)
      .set({ amount: sql`(select sum(${ei.actualAmount}) from ${ei} where ${ei.entryId} = ${id})` })
      .where(and(
        eq(schema.entries.id, id),
        sql`exists (select 1 from ${ei} where ${ei.entryId} = ${id})`,
        sql`not exists (select 1 from ${ei} where ${ei.entryId} = ${id} and ${ei.actualAmount} is null)`,
      )),
    db.select().from(schema.entries).where(eq(schema.entries.id, id)),
  ] as const)
  const [updated] = results.at(-1) as (typeof schema.entries.$inferSelect)[]
  await syncVoucher('execution', id, user.email)
  const [withItemsEntry] = await withItems([updated!])
  return withItemsEntry
})
