/**
 * 出納帳で、執行・収入のお金がどの口座（現金を含む）から出たか・入ったかを決める。
 * 画面（台帳の支出・収入）とサーバー（出納帳の計算）の両方で使う。
 */
import type { CashAccount } from './constants'
import { CASH_ACCOUNTS, bureauCodeOf } from './constants'

const isAccount = (v: unknown): v is CashAccount => (CASH_ACCOUNTS as readonly unknown[]).includes(v)

/**
 * 執行で確定した執行形態（entries.payment_method）→ お金が出た口座。
 * 振込は選んだ口座、発注の口座引落は SMBC、デビットは MUFG、現金執行と立替（委員への返金）は現金。
 * その他は口座が決まらない（null）。
 */
export function accountOfPayment(paymentMethod: string | null | undefined): CashAccount | null {
  if (!paymentMethod) return null
  const transfer = /^振込（(.+)）$/.exec(paymentMethod)
  if (transfer) return isAccount(transfer[1]) ? transfer[1] : null
  switch (paymentMethod) {
    case '口座引落': return 'SMBC'
    case 'デビット（MUFG）': return 'MUFG'
    case '現金執行':
    case '立替': return '現金'
    default: return null
  }
}

/** 振込の執行で入れた振込手数料（entries.details.transferFee。なければ 0） */
export function transferFeeOf(details: unknown): number {
  const fee = (details as { transferFee?: unknown } | null)?.transferFee
  return typeof fee === 'number' && fee > 0 ? fee : 0
}

/**
 * 振込手数料を入れる予算明細。振込手数料は必ず財務局（ZAI）の「振込手数料」の明細に入れる。
 * 財務局の支出の明細のうち、名前に「振込手数料」を含むもの（並び順で最初のもの）。なければ undefined。
 */
export function findTransferFeeLine<T extends { bureau: string, label: string, itemNumber: string, sortOrder: number }>(lines: T[]): T | undefined {
  return lines
    .filter(l => bureauCodeOf(l.bureau) === 'ZAI' && l.itemNumber.startsWith('out') && l.label.includes('振込手数料'))
    .sort((a, b) => a.sortOrder - b.sortOrder)[0]
}

/** 振込手数料を当てた予算明細の key（entries.details.transferFeeLineKey。なければ空） */
export function transferFeeLineKeyOf(details: unknown): string {
  const key = (details as { transferFeeLineKey?: unknown } | null)?.transferFeeLineKey
  return typeof key === 'string' ? key : ''
}

/** 収入の受け取り方 → お金が入った口座。振込は記録で選んだ口座、現金は現金、その他は決まらない（null） */
export function accountOfIncome(method: string, account: string | null | undefined): CashAccount | null {
  if (method === '現金') return '現金'
  if (method === '振込') return isAccount(account) ? account : null
  return null
}
