import { formatItemNumbers } from '../../shared/itemNumbers'
import { flowOf } from '../../shared/budgetCompile'
import { asc, inArray, sql } from 'drizzle-orm'
import type { BudgetLine, Entry, EntryItem } from '../db/schema'

/**
 * 選ばれた予算明細を引く。手入力（予算にない項目）のときは空配列と入力された項目番号を返す。
 * 複数の項目番号にまたがる場合は「out-03-02-06, out-03-07-01」のようにまとめ、連続する番号は「out01-04-01~03」と短くする。
 */
export async function resolveBudgetLines(keys: string[], manualItemNumber: string) {
  if (!keys.length) return { itemNumber: manualItemNumber, lines: [] as BudgetLine[] }
  const unique = [...new Set(keys)]
  const found = await useDb().select().from(schema.budgetLines).where(inArray(schema.budgetLines.key, unique))
  if (found.length !== unique.length) {
    throw createError({ statusCode: 400, message: '選んだ予算明細が見つかりません。予算が取り込み直された可能性があるので、ページを再読み込みして選び直してください。' })
  }
  if (found.some(l => flowOf(l.itemNumber) === 'income')) throw createError({ statusCode: 400, message: '収入の明細は執行依頼では選べません。' })
  const lines = found.sort((a, b) => a.sortOrder - b.sortOrder)
  return { itemNumber: formatItemNumbers(lines.map(l => l.itemNumber)), lines }
}

/** 予算の表に数量がある明細は、申請でも数量が必要（数量のない明細は空でよい） */
export function requireItemQuantities(lines: BudgetLine[], itemQuantities: Record<string, string> = {}) {
  const missing = lines.filter(l => l.quantity && !itemQuantities[l.key]?.trim())
  if (missing.length) {
    throw createError({ statusCode: 400, message: `数量を入力してください（${missing.map(l => l.label.split(' / ').at(-1)).join('、')}）。` })
  }
}

/** 申請時に入力された、明細ごとの実際の値（明細の key → 値） */
export interface ItemInputs {
  itemAmounts?: Record<string, number>
  itemQuantities?: Record<string, string>
  itemVendors?: Record<string, string>
}

/**
 * 申請と、選ばれた予算明細のコピー（明細ごとの執行額・数量・取引先つき）を1トランザクションで保存する。
 * 金額欄のない申請（発注など）で執行額が入っていれば、その合計を申請の金額にする。
 */
export async function insertEntry(
  values: typeof schema.entries.$inferInsert,
  lines: BudgetLine[],
  { itemAmounts = {}, itemQuantities = {}, itemVendors = {} }: ItemInputs = {},
) {
  const actuals = lines.map(l => itemAmounts[l.key] ?? null)
  if (values.amount == null && lines.length && actuals.every(a => a != null)) {
    values = { ...values, amount: actuals.reduce((s, a) => s! + a!, 0) }
  }
  return useDb().transaction(async (tx) => {
    const [entry] = await tx.insert(schema.entries).values(values).returning()
    const items = lines.length
      ? await tx.insert(schema.entryItems).values(lines.map((l, i) => ({
          entryId: entry!.id,
          lineKey: l.key,
          itemId: l.itemId,
          itemNumber: l.itemNumber,
          label: l.label,
          quantity: l.quantity,
          vendor: l.vendor,
          budgetAmount: l.budgetAmount,
          actualQuantity: itemQuantities[l.key] ?? null,
          actualVendor: itemVendors[l.key] ?? null,
          actualAmount: actuals[i],
        }))).returning()
      : []
    return { ...entry!, items }
  })
}

/**
 * 明細ごとの実際の執行額。入力があればそれ、なければ
 * 明細が1件だけの申請なら申請の金額をそのまま使う（複数明細で未入力なら不明＝null）。
 */
export function actualAmountOf(item: EntryItem, entry: Entry & { items: EntryItem[] }) {
  if (item.actualAmount != null) return item.actualAmount
  return entry.items.length === 1 ? entry.amount : null
}

/** 一覧に予算明細を付ける */
export async function withItems<T extends Entry>(rows: T[]): Promise<(T & { items: EntryItem[] })[]> {
  if (!rows.length) return []
  const items = await useDb()
    .select()
    .from(schema.entryItems)
    .where(inArray(schema.entryItems.entryId, rows.map(r => r.id)))
    .orderBy(asc(schema.entryItems.id))
  const byEntry = Map.groupBy(items, i => i.entryId)
  return rows.map(r => ({ ...r, items: byEntry.get(r.id) ?? [] }))
}

/** 数の通し番号を原子的に払い出す（手入力の仕訳の番号など） */
export async function nextNumber(name: string) {
  const [row] = await useDb()
    .insert(schema.counters)
    .values({ name, value: 1 })
    .onConflictDoUpdate({ target: schema.counters.name, set: { value: sql`${schema.counters.value} + 1` } })
    .returning({ value: schema.counters.value })
  return row!.value
}

/** 通し番号を原子的に払い出す（旧GASの ScriptProperties カウンタの置き換え） */
export async function nextSeq(kind: 'execution' | 'income') {
  const [row] = await useDb()
    .insert(schema.counters)
    .values({ name: kind, value: 1 })
    .onConflictDoUpdate({ target: schema.counters.name, set: { value: sql`${schema.counters.value} + 1` } })
    .returning({ value: schema.counters.value })
  const prefix = kind === 'execution' ? 'E' : 'I'
  return `${prefix}-${String(row!.value).padStart(3, '0')}`
}

function withoutBank(details: Record<string, unknown>) {
  const { bank: _bank, ...rest } = details
  return rest
}

/** 口座情報を見る権限がない人には返さない */
export function toPublicEntry<T extends Entry>(entry: T, showBank: boolean): T {
  return showBank ? entry : { ...entry, details: withoutBank(entry.details) }
}

/** n8n/Slack に渡す内容。口座情報は常に除外する */
export function toNotification(entry: Entry & { items?: EntryItem[] }) {
  const { applicantEmail: _email, attachmentId, executedBy: _by, evidenceCheckedBy: _checkedBy, items, ...rest } = entry
  return {
    ...rest,
    details: withoutBank(entry.details),
    hasAttachment: Boolean(attachmentId),
    items: items?.map(i => ({
      itemNumber: i.itemNumber,
      label: i.label,
      budgetAmount: i.budgetAmount,
      actualAmount: i.actualAmount,
      quantity: i.actualQuantity ?? i.quantity,
      vendor: i.actualVendor ?? i.vendor,
    })) ?? [],
  }
}
