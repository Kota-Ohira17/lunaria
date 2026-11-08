import { asc, eq } from 'drizzle-orm'
import type { CashAccount, CashbookKind } from '../../shared/constants'
import { CASH_ACCOUNTS } from '../../shared/constants'
import { accountOfIncome, accountOfPayment, transferFeeOf } from '../../shared/cashbook'

/** 出納帳の1行（お金の出入り）。入金は in、出金は out（どちらも正の額） */
export interface CashbookRow {
  /** 並べ替え・画面の key 用（e12 / i3 / r5） */
  key: string
  date: string
  source: 'execution' | 'income' | CashbookKind
  /** 執行・収入の通し番号（E-001・I-001）。手で書いた記録は null */
  seq: string | null
  /** 手で書いた記録の id（取り消しに使う） */
  recordId: number | null
  label: string
  account: CashAccount
  in: number
  out: number
  /** この行のあとの、その口座の残高 */
  balance: number
}

/** 口座の決まらない・金額の分からない執行と収入（出納帳の計算に入れていないもの） */
export interface CashbookUnknown {
  seq: string
  date: string
  label: string
  amount: number | null
  method: string
  reason: string
}

export interface CashbookCheck {
  id: number
  date: string
  account: CashAccount
  /** 数えた残高 */
  actual: number
  /** その日の終わりの帳簿の残高 */
  book: number
  memo: string
}

/** 同じ日の中の並び（期首の残高 → 収入 → 移動・調整 → 執行） */
const ORDER: Record<CashbookRow['source'], number> = { opening: 0, income: 1, transfer: 2, adjust: 2, execution: 3, check: 4 }

/** 執行の金額。申請の金額、なければ明細ごとの執行額の合計（1つでも分からなければ null） */
export function executedAmount(entry: Awaited<ReturnType<typeof withItems>>[number]) {
  if (entry.amount != null) return entry.amount
  const amounts = entry.items.map(i => actualAmountOf(i, entry))
  return amounts.length && amounts.every(a => a != null) ? amounts.reduce((s, a) => s + a!, 0) : null
}

/**
 * 出納帳を組み立てる。執行済みの申請（出金）・確認済みの収入（入金）・手で書いた記録から、
 * 口座ごとの出入りと残高、残高の照合（帳簿との差）を出す。
 */
export async function buildCashbook() {
  const db = useDb()
  const [done, incomes, records] = await Promise.all([
    db.select().from(schema.entries).where(eq(schema.entries.status, 'done')).then(withItems),
    db.select().from(schema.incomeRecords).where(eq(schema.incomeRecords.status, 'done')),
    db.select().from(schema.cashbookRecords).orderBy(asc(schema.cashbookRecords.date), asc(schema.cashbookRecords.id)),
  ])

  type Flow = Omit<CashbookRow, 'balance'>
  const flows: Flow[] = []
  const unknown: CashbookUnknown[] = []

  for (const e of done) {
    const date = e.executedAt ? dateInJapan(e.executedAt) : ''
    const amount = executedAmount(e)
    const account = accountOfPayment(e.paymentMethod)
    const label = `${e.itemName}（${e.department}/${e.inCharge}）`
    if (!account || amount == null || !date) {
      unknown.push({ seq: e.seq, date, label, amount, method: e.paymentMethod ?? e.type, reason: !account ? 'どの口座から出たか決まらない執行形態です。' : '執行額が分かりません。' })
      continue
    }
    flows.push({ key: `e${e.id}`, date, source: 'execution', seq: e.seq, recordId: null, label, account, in: 0, out: amount })
    // 振込手数料は、振込と同じ口座から別の行で出す
    const fee = transferFeeOf(e.details)
    if (fee) flows.push({ key: `e${e.id}-fee`, date, source: 'execution', seq: e.seq, recordId: null, label: `振込手数料（${label}）`, account, in: 0, out: fee })
  }

  for (const i of incomes) {
    const account = accountOfIncome(i.method, i.account)
    const label = `${i.itemName}${i.payer ? `（${i.payer}）` : ''}`
    if (!account) {
      unknown.push({ seq: i.seq, date: i.receivedOn, label, amount: i.amount, method: i.method, reason: i.method === '振込' ? '受け取った口座が記録されていません。' : 'どの口座に入ったか決まらない受け取り方です。' })
      continue
    }
    flows.push({ key: `i${i.id}`, date: i.receivedOn, source: 'income', seq: i.seq, recordId: null, label, account, in: i.amount, out: 0 })
  }

  for (const r of records) {
    const base = { date: r.date, source: r.kind, seq: null, recordId: r.id }
    if (r.kind === 'opening') flows.push({ ...base, key: `r${r.id}`, label: r.memo || '期首の残高', account: r.account, in: r.amount, out: 0 })
    if (r.kind === 'adjust') flows.push({ ...base, key: `r${r.id}`, label: r.memo, account: r.account, in: Math.max(r.amount, 0), out: Math.max(-r.amount, 0) })
    if (r.kind === 'transfer' && r.toAccount) {
      const label = `${r.account} → ${r.toAccount}${r.memo ? `（${r.memo}）` : ''}`
      flows.push({ ...base, key: `r${r.id}-out`, label, account: r.account, in: 0, out: r.amount })
      flows.push({ ...base, key: `r${r.id}-in`, label, account: r.toAccount, in: r.amount, out: 0 })
    }
  }

  flows.sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.source] - ORDER[b.source] || a.key.localeCompare(b.key, undefined, { numeric: true }))
  const balances = Object.fromEntries(CASH_ACCOUNTS.map(a => [a, 0])) as Record<CashAccount, number>
  const rows: CashbookRow[] = flows.map((f) => {
    balances[f.account] += f.in - f.out
    return { ...f, balance: balances[f.account] }
  })

  /** その日の終わりの帳簿の残高 */
  const bookOn = (account: CashAccount, date: string) =>
    rows.filter(r => r.account === account && r.date <= date).reduce((s, r) => s + r.in - r.out, 0)
  const checks: CashbookCheck[] = records.filter(r => r.kind === 'check')
    .map(r => ({ id: r.id, date: r.date, account: r.account, actual: r.amount, book: bookOn(r.account, r.date), memo: r.memo }))

  const accounts = CASH_ACCOUNTS.map(account => ({
    account,
    balance: balances[account],
    hasOpening: records.some(r => r.kind === 'opening' && r.account === account),
    lastCheck: checks.filter(c => c.account === account).at(-1) ?? null,
  }))

  /** まだ執行していない執行依頼・立替の返金の金額（これから出ていく予定のお金。口座ごとには分けない） */
  const pending = await db.select().from(schema.entries).where(eq(schema.entries.status, 'pending')).then(withItems)
  const pendingOut = { count: pending.length, total: pending.reduce((s, e) => s + (executedAmount(e) ?? 0), 0) }

  return { accounts, rows, checks, unknown, pendingOut }
}
