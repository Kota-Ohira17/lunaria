import { and, eq } from 'drizzle-orm'
import { itemsUpdateSchema } from '../../../../shared/schemas'

/**
 * 明細ごとの実際の執行額・数量・取引先を直す（財務局長・管理者のみ）。対応済みにする前後どちらでもよい。
 * 申請の金額は、すべての明細に執行額が入っていればその合計にそろえる。
 */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'executeEntries')
  const id = Number(getRouterParam(event, 'id'))
  const { amounts, quantities, vendors } = parseOr400(itemsUpdateSchema.safeParse(await readBody(event)))
  const db = useDb()
  await assertVoucherOpen('execution', id)
  const entry = await db.query.entries.findFirst({ where: eq(schema.entries.id, id) })
  if (!entry) throw createError({ statusCode: 404, message: '申請が見つかりません。' })

  const changes = new Map<number, Partial<typeof schema.entryItems.$inferInsert>>()
  const put = (itemId: string, change: Partial<typeof schema.entryItems.$inferInsert>) =>
    changes.set(Number(itemId), { ...changes.get(Number(itemId)), ...change })
  for (const [itemId, v] of Object.entries(amounts)) put(itemId, { actualAmount: v })
  for (const [itemId, v] of Object.entries(quantities)) put(itemId, { actualQuantity: v || null })
  for (const [itemId, v] of Object.entries(vendors)) put(itemId, { actualVendor: v || null })

  const [updated] = await db.transaction(async (tx) => {
    for (const [itemId, change] of changes) {
      await tx.update(schema.entryItems)
        .set(change)
        .where(and(eq(schema.entryItems.id, itemId), eq(schema.entryItems.entryId, id)))
    }
    const items = await tx.select().from(schema.entryItems).where(eq(schema.entryItems.entryId, id))
    if (items.length && items.every(i => i.actualAmount != null)) {
      await tx.update(schema.entries)
        .set({ amount: items.reduce((s, i) => s + i.actualAmount!, 0) })
        .where(eq(schema.entries.id, id))
    }
    return tx.select().from(schema.entries).where(eq(schema.entries.id, id))
  })
  await syncVoucher('execution', id, user.email)
  const [withItemsEntry] = await withItems([updated!])
  return withItemsEntry
})
