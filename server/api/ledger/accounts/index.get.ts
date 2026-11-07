import { sql } from 'drizzle-orm'

/** 勘定科目の一覧（財務局長・管理者）。仕訳で使ったことがあるか（used）も返す */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'manageCashbook')
  const db = useDb()
  const g = schema.glEntries
  const [list, used] = await Promise.all([
    db.select().from(schema.accounts),
    db.select({ account: g.account, n: sql<number>`count(*)` }).from(g).groupBy(g.account),
  ])
  const usedSet = new Set(used.map(u => u.account))
  const order = ['資産', '負債', '純資産', '収入', '支出']
  return list
    .map(a => ({ ...a, used: usedSet.has(a.name) }))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)
      || (a.number ? 0 : 1) - (b.number ? 0 : 1) || a.number.localeCompare(b.number, undefined, { numeric: true })
      || a.name.localeCompare(b.name, 'ja'))
})
