import { and, asc, eq, inArray } from 'drizzle-orm'
import type { AccountKind } from '../../shared/constants'
import { CASH_ACCOUNT_TITLES } from '../../shared/constants'
import { accountOfIncome, accountOfPayment } from '../../shared/cashbook'
import type { GlEntry } from '../db/schema'

/**
 * 複式簿記の帳簿（現金主義：お金が動いたときに仕訳する）。仕訳は⑬総勘定元帳DBに確定して持つ（ERPNext の GL Entry にならう）。
 * 執行済みの申請・確認済みの収入・出納帳の記録（期首の残高・移動・調整）から行を作り、手で入れた仕訳は⑬に直接書く。
 * 収入・支出の科目は予算の款。口座は「普通預金（SMBC）」などの資産の科目。
 * 口座や金額が決まらない執行・収入は仕訳に入れない（出納帳の「出納帳に入っていない記録」と同じ）。
 */

export interface JournalLine {
  account: string
  kind: AccountKind
  debit: number
  credit: number
}

export interface Journal {
  /** 並べ替え・画面の key（e12 / i3 / r5 / m2） */
  key: string
  date: string
  source: 'execution' | 'income' | 'opening' | 'transfer' | 'adjust' | 'manual'
  /** 執行・収入の番号（E-001・I-001） */
  seq: string | null
  /** 手で入れた仕訳の id（取り消しに使う） */
  manualId: number | null
  memo: string
  lines: JournalLine[]
}

/** 予算にない支出・収入で款が分からないときの科目 */
const UNKNOWN_EXPENSE = '予算にない支出'
const UNKNOWN_INCOME = '予算にない収入'
/** 出納帳の調整（利息・手数料など）の科目 */
const ADJUST_GAIN = '雑収入'
const ADJUST_LOSS = '雑費'
/** 期首の残高の相手の科目 */
const OPENING = '前期繰越'

/** 同じ日の中の並び（期首の残高 → 収入 → 移動・調整 → 執行 → 手で入れた仕訳） */
const ORDER: Record<Journal['source'], number> = { opening: 0, income: 1, transfer: 2, adjust: 2, execution: 3, manual: 4 }

/** 借方か貸方の1行 */
const debit = (account: string, kind: AccountKind, amount: number): JournalLine => ({ account, kind, debit: amount, credit: 0 })
const credit = (account: string, kind: AccountKind, amount: number): JournalLine => ({ account, kind, debit: 0, credit: amount })

/** 同じ科目の行をまとめる（借方・貸方それぞれ） */
function merge(lines: JournalLine[]) {
  const map = new Map<string, JournalLine>()
  for (const l of lines) {
    const key = `${l.debit ? 'd' : 'c'}|${l.account}`
    const m = map.get(key)
    if (m) {
      m.debit += l.debit
      m.credit += l.credit
    }
    else map.set(key, { ...l })
  }
  return [...map.values()]
}

const pathKan = (details: unknown) => (details as { budgetPath?: { kan?: string } } | null)?.budgetPath?.kan?.trim() || ''

type KanOf = Map<string, string>
type VoucherType = GlEntry['voucherType']
/** 1つの記録から作る仕訳 */
interface Posting {
  type: VoucherType
  id: number
  no: string
  subtype: string
  date: string
  memo: string
  bureau: string
  team: string
  lines: JournalLine[]
}

const KEY_PREFIX: Record<VoucherType, string> = { execution: 'e', income: 'i', cashbook: 'r', manual: 'm' }
const SYSTEM_USER = 'system'

async function kanOfLines(): Promise<KanOf> {
  const rows = await useDb().select({ key: schema.budgetLines.key, kan: schema.budgetLines.kan }).from(schema.budgetLines)
  return new Map(rows.map(l => [l.key, l.kan]))
}

/** 執行済みの申請の仕訳。口座や金額が決まらないものは作らない */
function postingOfEntry(e: Awaited<ReturnType<typeof withItems>>[number], kanOf: KanOf): Posting | null {
  if (e.status !== 'done') return null
  const amount = executedAmount(e)
  const account = accountOfPayment(e.paymentMethod)
  if (!e.executedAt || amount == null || !account) return null
  // 支出の科目は明細の款。明細ごとの執行額がすべて分かれば款ごとに分け、分からなければ最初の明細の款にまとめる
  const fallback = e.items.length ? (kanOf.get(e.items[0]!.lineKey) || UNKNOWN_EXPENSE) : (pathKan(e.details) || (e.itemNumber === '予算前執行' ? '予算前執行' : UNKNOWN_EXPENSE))
  const actuals = e.items.map(i => actualAmountOf(i, e))
  const byItems = e.items.length > 0 && actuals.every(a => a != null) && actuals.reduce((s, a) => s + a!, 0) === amount
  const expense = byItems
    ? e.items.map((i, n) => debit(kanOf.get(i.lineKey) || fallback, '支出', actuals[n]!))
    : [debit(fallback, '支出', amount)]
  return {
    type: 'execution', id: e.id, no: e.seq, subtype: '', date: dateInJapan(e.executedAt),
    memo: `${e.itemName}（${e.department}/${e.inCharge}）`, bureau: e.department, team: e.inCharge,
    lines: merge([...expense, credit(CASH_ACCOUNT_TITLES[account], '資産', amount)]),
  }
}

/** 確認済みの収入の仕訳 */
function postingOfIncome(i: typeof schema.incomeRecords.$inferSelect, kanOf: KanOf): Posting | null {
  if (i.status !== 'done') return null
  const account = accountOfIncome(i.method, i.account)
  if (!account) return null
  const kan = (i.lineKey && kanOf.get(i.lineKey)) || pathKan(i.details) || UNKNOWN_INCOME
  return {
    type: 'income', id: i.id, no: i.seq, subtype: '', date: i.receivedOn,
    memo: `${i.itemName}${i.payer ? `（${i.payer}）` : ''}`, bureau: i.department, team: i.inCharge,
    lines: [debit(CASH_ACCOUNT_TITLES[account], '資産', i.amount), credit(kan, '収入', i.amount)],
  }
}

/** 出納帳の記録の仕訳（期首の残高・移動・調整。残高の照合は仕訳にしない） */
function postingOfRecord(r: typeof schema.cashbookRecords.$inferSelect): Posting | null {
  const base = { type: 'cashbook' as const, id: r.id, no: '', subtype: r.kind, date: r.date, bureau: '', team: '' }
  const cash = CASH_ACCOUNT_TITLES[r.account]
  if (r.kind === 'opening' && r.amount > 0) {
    return { ...base, memo: r.memo || '期首の残高', lines: [debit(cash, '資産', r.amount), credit(OPENING, '純資産', r.amount)] }
  }
  if (r.kind === 'transfer' && r.toAccount) {
    return { ...base, memo: `${r.account} → ${r.toAccount}${r.memo ? `（${r.memo}）` : ''}`, lines: [debit(CASH_ACCOUNT_TITLES[r.toAccount], '資産', r.amount), credit(cash, '資産', r.amount)] }
  }
  if (r.kind === 'adjust') {
    return {
      ...base, memo: r.memo,
      lines: r.amount > 0
        ? [debit(cash, '資産', r.amount), credit(ADJUST_GAIN, '収入', r.amount)]
        : [debit(ADJUST_LOSS, '支出', -r.amount), credit(cash, '資産', -r.amount)],
    }
  }
  return null
}

/** もとの記録がある種類（手入力の仕訳は⑬に直接書くので、もとの記録がない） */
type SourceType = Exclude<VoucherType, 'manual'>

/** 1つの記録の今の仕訳（仕訳にならないか、記録がなければ null） */
async function postingOf(type: SourceType, id: number): Promise<Posting | null> {
  const db = useDb()
  if (type === 'execution') {
    const [e] = await db.select().from(schema.entries).where(eq(schema.entries.id, id)).then(withItems)
    return e ? postingOfEntry(e, await kanOfLines()) : null
  }
  if (type === 'income') {
    const [i] = await db.select().from(schema.incomeRecords).where(eq(schema.incomeRecords.id, id))
    return i ? postingOfIncome(i, await kanOfLines()) : null
  }
  const [r] = await db.select().from(schema.cashbookRecords).where(eq(schema.cashbookRecords.id, id))
  return r ? postingOfRecord(r) : null
}

/** 仕訳を⑬の行にする */
const glRows = (p: Posting, createdBy: string, createdAt: Date) => p.lines.map((l, n) => ({
  postingDate: p.date, account: l.account, accountKind: l.kind, debit: l.debit, credit: l.credit,
  voucherType: p.type, voucherId: p.id, voucherNo: p.no, voucherSubtype: p.subtype, lineNo: n,
  remarks: p.memo, bureau: p.bureau, team: p.team, createdBy, createdAt,
}))

/** ⑬の有効な行と、今の仕訳が同じか */
const signature = (rows: { postingDate: string, account: string, debit: number, credit: number, remarks: string, voucherNo: string }[]) =>
  JSON.stringify(rows.map(r => [r.postingDate, r.account, r.debit, r.credit, r.remarks, r.voucherNo]))

/**
 * 記録を変えたあとに呼ぶ。今の仕訳が⑬の有効な行と違えば、もとの行を取り消して（貸借を入れ替えた行を足して）新しい行を足す。
 * 同じなら何もしない。款の名前が変わっただけでは呼ばないので、確定した仕訳の科目はあとから変わらない。
 */
export async function syncVoucher(type: SourceType, id: number, createdBy = SYSTEM_USER) {
  const db = useDb()
  const g = schema.glEntries
  const where = and(eq(g.voucherType, type), eq(g.voucherId, id), eq(g.isCancelled, false))
  const [posting, active] = await Promise.all([
    postingOf(type, id),
    db.select().from(g).where(where).orderBy(asc(g.lineNo)),
  ])
  const now = new Date()
  const next = posting ? glRows(posting, createdBy, now) : []
  if (signature(active) === signature(next)) return
  const statements = [
    ...(active.length ? [db.update(g).set({ isCancelled: true }).where(where)] : []),
    ...(active.length
      ? [db.insert(g).values(active.map(({ id: _id, ...r }) => ({ ...r, debit: r.credit, credit: r.debit, isCancelled: true, createdBy, createdAt: now })))]
      : []),
    ...(next.length ? [db.insert(g).values(next).onConflictDoNothing()] : []),
  ]
  await db.batch(statements as [typeof statements[number], ...typeof statements])
}

/**
 * 仕訳を手で入れる（⑬に直接書く）。番号は counters の journal から払い出す。
 * ⑬ですでに使っている科目は、同じ区分でしか使えない（科目名の揺れや区分の食い違いを防ぐ）。
 */
export async function postManualJournal(input: { date: string, memo: string, lines: JournalLine[] }, createdBy: string) {
  const g = schema.glEntries
  const names = [...new Set(input.lines.map(l => l.account))]
  const used = await useDb().selectDistinct({ account: g.account, kind: g.accountKind }).from(g).where(inArray(g.account, names))
  const conflicts = input.lines.filter(l => used.some(u => u.account === l.account && u.kind !== l.kind))
  if (conflicts.length) {
    const list = [...new Set(conflicts.map(l => `「${l.account}」は${used.find(u => u.account === l.account)!.kind}`))]
    throw createError({ statusCode: 400, message: `すでに使っている科目と区分が違います：${list.join('、')}の科目です。` })
  }
  const id = await nextNumber('journal')
  const posting: Posting = { type: 'manual', id, no: '', subtype: '', date: input.date, memo: input.memo, bureau: '', team: '', lines: input.lines }
  await useDb().insert(schema.glEntries).values(glRows(posting, createdBy, new Date()))
  return { id, date: posting.date, memo: posting.memo, lines: posting.lines }
}

/** 手で入れた仕訳を取り消す（もとの行に取り消しの印を付け、貸借を入れ替えた行を足す） */
export async function cancelManualJournal(id: number, createdBy: string) {
  const db = useDb()
  const g = schema.glEntries
  const where = and(eq(g.voucherType, 'manual'), eq(g.voucherId, id), eq(g.isCancelled, false))
  const active = await db.select().from(g).where(where).orderBy(asc(g.lineNo))
  if (!active.length) throw createError({ statusCode: 404, message: '仕訳が見つかりません。' })
  const now = new Date()
  await db.batch([
    db.update(g).set({ isCancelled: true }).where(where),
    db.insert(g).values(active.map(({ id: _id, ...r }) => ({ ...r, debit: r.credit, credit: r.debit, isCancelled: true, createdBy, createdAt: now }))),
  ])
}

/**
 * 帳簿を読む前に、⑬と記録の抜けをそろえる。
 * 仕訳があるのに⑬に行がない記録（この表を作る前の記録や、途中で失敗したもの）は足し、記録がなくなったのに⑬に残っている行は取り消す。
 * 行がすでにある記録は変えない。
 */
async function reconcileLedger() {
  const db = useDb()
  const g = schema.glEntries
  const [done, incomes, records, kanOf, active] = await Promise.all([
    db.select().from(schema.entries).where(eq(schema.entries.status, 'done')).then(withItems),
    db.select().from(schema.incomeRecords).where(eq(schema.incomeRecords.status, 'done')),
    db.select().from(schema.cashbookRecords),
    kanOfLines(),
    db.selectDistinct({ type: g.voucherType, id: g.voucherId }).from(g).where(eq(g.isCancelled, false)),
  ])
  const postings = [
    ...done.map(e => postingOfEntry(e, kanOf)),
    ...incomes.map(i => postingOfIncome(i, kanOf)),
    ...records.map(postingOfRecord),
  ].filter((p): p is Posting => p != null)
  const keyOf = (type: VoucherType, id: number) => `${type}:${id}`
  const posted = new Set(active.map(a => keyOf(a.type, a.id)))
  const wanted = new Set(postings.map(p => keyOf(p.type, p.id)))
  const now = new Date()
  const missing = postings.filter(p => !posted.has(keyOf(p.type, p.id))).flatMap(p => glRows(p, SYSTEM_USER, now))
  for (let i = 0; i < missing.length; i += 100) await db.insert(g).values(missing.slice(i, i + 100)).onConflictDoNothing()
  // 手入力の仕訳は⑬そのものが記録なので、そろえる相手がない
  for (const a of active) {
    if (a.type !== 'manual' && !wanted.has(keyOf(a.type, a.id))) await syncVoucher(a.type, a.id)
  }
}

export async function buildJournals() {
  await reconcileLedger()
  const g = schema.glEntries
  const rows = await useDb().select().from(g).where(eq(g.isCancelled, false)).orderBy(asc(g.voucherType), asc(g.voucherId), asc(g.lineNo))
  const groups = Map.groupBy(rows, r => `${KEY_PREFIX[r.voucherType]}${r.voucherId}`)
  const journals: Journal[] = [...groups].map(([key, list]) => {
    const r = list[0]!
    return {
      key,
      date: r.postingDate,
      source: (r.voucherType === 'cashbook' ? r.voucherSubtype : r.voucherType) as Journal['source'],
      seq: r.voucherNo || null,
      manualId: r.voucherType === 'manual' ? r.voucherId : null,
      memo: r.remarks,
      lines: list.map(l => ({ account: l.account, kind: l.accountKind, debit: l.debit, credit: l.credit })),
    }
  })
  journals.sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.source] - ORDER[b.source] || a.key.localeCompare(b.key, undefined, { numeric: true }))
  return journals
}

/** 借方に残高が出る区分か（資産・支出） */
export const isDebitKind = (kind: AccountKind) => kind === '資産' || kind === '支出'

/**
 * 仕訳帳・総勘定元帳・試算表を出す。
 * 元帳は科目ごとの行と残高（資産・支出は借方−貸方、負債・純資産・収入は貸方−借方）、試算表は科目ごとの借方・貸方の合計と残高。
 */
export async function buildLedger() {
  const journals = await buildJournals()
  const accounts = new Map<string, { account: string, kind: AccountKind, debit: number, credit: number, rows: { key: string, date: string, memo: string, seq: string | null, debit: number, credit: number, balance: number }[] }>()
  for (const j of journals) {
    for (const l of j.lines) {
      const a = accounts.get(l.account) ?? { account: l.account, kind: l.kind, debit: 0, credit: 0, rows: [] }
      a.debit += l.debit
      a.credit += l.credit
      const balance = isDebitKind(a.kind) ? a.debit - a.credit : a.credit - a.debit
      a.rows.push({ key: j.key, date: j.date, memo: j.memo, seq: j.seq, debit: l.debit, credit: l.credit, balance })
      accounts.set(l.account, a)
    }
  }
  const order = ['資産', '負債', '純資産', '収入', '支出']
  const ledger = [...accounts.values()]
    .map(a => ({ ...a, balance: isDebitKind(a.kind) ? a.debit - a.credit : a.credit - a.debit }))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.account.localeCompare(b.account, 'ja'))
  const totals = { debit: ledger.reduce((s, a) => s + a.debit, 0), credit: ledger.reduce((s, a) => s + a.credit, 0) }
  return { journals, ledger, totals }
}
