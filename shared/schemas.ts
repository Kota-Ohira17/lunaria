import { z } from 'zod'
import type { CashbookKind } from './constants'
import { ACCOUNT_KINDS, BANK_ACCOUNTS, CASH_ACCOUNTS, CASHBOOK_KINDS, EVIDENCE_KINDS, INCOME_FILE_KINDS, INCOME_METHODS, PAPER_RECEIPT, REFUND_TIMINGS, TRANSFER_BANKS } from './constants'

const required = (label: string) => {
  const message = `${label}を入力してください。`
  return z.string({ error: message }).trim().min(1, message)
}
/** 日本語名が「統括」「部長」で終わる担当は、担当名（英語）の1文字目を必ず大文字にする（eco → Eco）。ほかは書いたまま */
export const teamCodeFor = (team: string, nameJa: string) => (/(統括|部長)$/.test(nameJa) ? team.charAt(0).toUpperCase() + team.slice(1) : team)
const date = z.string({ error: '日付を入力してください。' }).regex(/^\d{4}-\d{2}-\d{2}$/, '日付を入力してください。')
/** 日付、または日付＋時刻（執行希望日時） */
const dateTime = z.string({ error: '日時を入力してください。' }).regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, '日時を入力してください。')
/** 局（略称、または略称のない局は予算の局名）。選択肢は取り込んだ予算によって変わるので文字列で受ける */
/** 局・担当は、明細を選ばないときだけ入力する（選んだときはサーバーで明細から決める） */
const optionalBureau = z.string().trim().max(30).default('')
const optionalTeam = z.string().trim().max(200).default('')
const yen = z.coerce.number({ error: '金額を数字で入力してください。' }).int('整数で入力してください。').positive('金額を入力してください。')

export const ITEM_NUMBER_PATTERN = /^out-?\d{2}(-\d{2}){1,2}$/

/**
 * 執行項目。予算明細から選ぶ（budgetLineKeys、複数可）か、予算にない場合は項目番号を手入力する。
 * どちらか一方が必要（checkItems で検証）。
 */
const items = {
  budgetLineKeys: z.array(z.string()).max(200, '選べる明細は200件までです。').default([]),
  /** 明細ごとの実際の執行額（明細の key → 円）。予算額と違うことが多い */
  itemAmounts: z.record(z.string(), z.coerce.number({ error: '執行額は数字で入力してください。' }).int('執行額は整数で入力してください。')).default({}),
  /** 明細ごとの実際の数量・取引先（明細の key → 文字）。予算と違うことがある */
  itemQuantities: z.record(z.string(), z.string().trim().max(100)).default({}),
  itemVendors: z.record(z.string(), z.string().trim().max(100)).default({}),
  itemNumber: z.string().trim().default(''),
  /** 予算にない項目の款・項・目・節（決算の「予算にない項目」に出す） */
  budgetPath: z.object({
    kan: z.string().trim().max(100).default(''),
    kou: z.string().trim().max(100).default(''),
    moku: z.string().trim().max(100).default(''),
    setsu: z.string().trim().max(100).default(''),
  }).default({ kan: '', kou: '', moku: '', setsu: '' }),
}

/**
 * 台帳で明細ごとの執行額・数量・取引先を直す（entry_items の id → 値。null で未入力に戻す）。
 * 送られてきた項目だけ書き換える。
 */
export const itemsUpdateSchema = z.object({
  amounts: z.record(z.string(), z.number().int('執行額は整数で入力してください。').nullable()).default({}),
  quantities: z.record(z.string(), z.string().trim().max(100).nullable()).default({}),
  vendors: z.record(z.string(), z.string().trim().max(100).nullable()).default({}),
})

function checkItems(v: { department: string, inCharge: string, budgetLineKeys: string[], itemNumber: string, budgetPath: { kan: string }, preExecution: boolean, preExecutionReason: string, quantity?: string }, ctx: z.RefinementCtx) {
  // 予算前執行は、本予算の確定を待てない理由を必ず書く
  if (v.preExecution && !v.preExecutionReason) ctx.addIssue({ code: 'custom', message: '予算前執行が必要な理由を入力してください。', path: ['preExecutionReason'] })
  // 予算から選んだときの数量は明細ごとに入力する（予算の表に数量がある明細だけ必須。サーバーで確認する）
  if (v.budgetLineKeys.length) return
  if (!v.department) ctx.addIssue({ code: 'custom', message: '局を選んでください。', path: ['department'] })
  if (!v.inCharge) ctx.addIssue({ code: 'custom', message: '担当名を入力してください。', path: ['inCharge'] })
  if (v.quantity === '') ctx.addIssue({ code: 'custom', message: '数量を入力してください。', path: ['quantity'] })
  // 予算前執行は、まだ予算の項目がないので選ばない（支出項目名だけ書く）
  if (v.preExecution) return
  if (!v.itemNumber) ctx.addIssue({ code: 'custom', message: '執行項目を予算から選んでください。', path: ['budgetLineKeys'] })
  else if (!v.budgetPath.kan) ctx.addIssue({ code: 'custom', message: '予算にない項目の款を入力してください。', path: ['budgetPath'] })
  else if (!ITEM_NUMBER_PATTERN.test(v.itemNumber)) ctx.addIssue({ code: 'custom', message: '項目番号は out01-03-02 の形式で入力してください。', path: ['itemNumber'] })
}

const base = z.object({
  applicantName: required('申請者氏名'),
  department: optionalBureau,
  inCharge: optionalTeam,
  ...items,
  itemName: required('支出項目名'),
  /** 1万円以上の増額のとき、役員会の承認を得たか（予算からの変更そのものはサーバーで金額から決める） */
  budgetCommitteeApproved: z.boolean().default(false),
  /**
   * 明細の金額が予算額と違うとき、予算の変更（②）も申請するか（任意。初めはしない）。
   * 申請するときの理由（書かなければ、執行依頼の番号と金額から作る）
   */
  requestBudgetChange: z.boolean().default(false),
  budgetChangeReason: z.string().trim().max(1000).default(''),
  /** 予算前執行（本予算が確定する前の執行。予算の表から選ばない） */
  preExecution: z.boolean().default(false),
  /** 予算前執行が必要な理由（予算前執行のときは必須） */
  preExecutionReason: z.string().trim().max(1000).default(''),
  remark: z.string().trim().default(''),
})

export const bankAccountSchema = z.object({
  bankName: required('金融機関名'),
  branchName: required('支店名'),
  accountType: required('振込先の口座種別'), // 普通 / 当座 / その他（自由記述）
  accountNumber: z.string().regex(/^\d{1,8}$/, '口座番号は数字で入力してください。'),
  accountName: required('口座名義'),
}, { error: '振込先の口座情報を入力してください。' })

export const executionRequestSchema = z.discriminatedUnion('type', [
  base.extend({
    type: z.literal('振込'),
    deadline: date,
    amount: yen,
    bank: bankAccountSchema,
  }),
  base.extend({
    type: z.literal('発注'),
    site: required('通販サイト'),
    url: required('商品ページのリンク'), // 複数のリンクを改行で書いてよい
    /** 商品の金額（税込・送料を除く）。送料無料の基準に届くかの判断に使う */
    amount: yen,
    quantity: z.string().trim().default(''), // 予算にない項目のときは必須（checkItems）
    deadline: date,
    deliveryPlace: required('配達場所'),
  }),
  base.extend({
    type: z.literal('立替'),
    amount: yen,
    purchase: required('購入先'),
    paperReceipt: z.enum(PAPER_RECEIPT, { error: '紙媒体の領収証の有無を選んでください。' }),
    deadline: date, // 立替予定日
  }),
  base.extend({
    type: z.enum(['現金執行', 'カード決済', 'その他']),
    /** 執行形態で「その他」を選んだときの中身 */
    otherMethod: z.string().trim().default(''),
    amount: yen,
    deadline: dateTime, // 執行希望日時
    details: required('詳細'),
  }),
]).superRefine((v, ctx) => {
  checkItems(v, ctx)
  if (v.type === 'その他' && !v.otherMethod) {
    ctx.addIssue({ code: 'custom', message: '執行形態（その他）の内容を入力してください。', path: ['otherMethod'] })
  }
})
export type ExecutionRequestInput = z.input<typeof executionRequestSchema>

/**
 * 台帳から証憑を付けるときの入力（ファイルは別に送る）。
 * 金額・日付は分かれば入れる。返金時期は立替のときだけ。
 */
/** 収入の項目番号（in01-01-01。予算にない収入を手入力するとき） */
export const INCOME_NUMBER_PATTERN = /^in-?\d{2}(-\d{2}){1,2}$/

/**
 * 収入の記録。収入の予算明細を選ぶ（lines。款などの見出しでまとめて複数選べ、明細ごとに金額を書く）か、
 * 予算にない収入として款（必須）〜節と項目番号（in から始まる）・金額を書く。
 * 明細を複数選んだときは明細ごとに1件ずつ記録し、収入項目名は明細の名前にする。
 */
export const incomeSchema = z.object({
  applicantName: required('記録する人の氏名'),
  department: optionalBureau,
  inCharge: optionalTeam,
  /** 選んだ収入の予算明細と、明細ごとの金額 */
  lines: z.array(z.object({ key: z.string().trim().min(1), amount: yen })).max(200, '選べる明細は200件までです。').default([]),
  itemNumber: z.string().trim().default(''),
  budgetPath: z.object({
    kan: z.string().trim().max(100).default(''),
    kou: z.string().trim().max(100).default(''),
    moku: z.string().trim().max(100).default(''),
    setsu: z.string().trim().max(100).default(''),
  }).default({ kan: '', kou: '', moku: '', setsu: '' }),
  /** 収入項目名（明細を複数選んだときは使わず、明細の名前にする） */
  itemName: z.string().trim().max(200).default(''),
  /** 予算にない収入の金額（明細を選んだときは lines の金額） */
  amount: yen.or(z.literal('')).default(''),
  receivedOn: date,
  payer: z.string().trim().max(200).default(''),
  method: z.enum(INCOME_METHODS, { error: '受け取り方を選んでください。' }),
  /** 振込で受け取った口座（振込のときだけ） */
  account: z.enum(BANK_ACCOUNTS).or(z.literal('')).default(''),
  remark: z.string().trim().max(1000).default(''),
}).superRefine((v, ctx) => {
  if (v.method === '振込' && !v.account) ctx.addIssue({ code: 'custom', message: '振込で受け取った口座を選んでください。', path: ['account'] })
  if (v.lines.length) {
    if (new Set(v.lines.map(l => l.key)).size !== v.lines.length) ctx.addIssue({ code: 'custom', message: '同じ明細が2回選ばれています。', path: ['lines'] })
    if (v.lines.length === 1 && !v.itemName) ctx.addIssue({ code: 'custom', message: '収入項目名を入力してください。', path: ['itemName'] })
    return
  }
  if (!v.itemName) ctx.addIssue({ code: 'custom', message: '収入項目名を入力してください。', path: ['itemName'] })
  if (v.amount === '') ctx.addIssue({ code: 'custom', message: '金額を入力してください。', path: ['amount'] })
  if (!v.department) ctx.addIssue({ code: 'custom', message: '局を選んでください。', path: ['department'] })
  if (!v.inCharge) ctx.addIssue({ code: 'custom', message: '担当名を入力してください。', path: ['inCharge'] })
  if (!v.itemNumber) ctx.addIssue({ code: 'custom', message: '収入の項目を予算から選んでください。', path: ['lines'] })
  else if (!v.budgetPath.kan) ctx.addIssue({ code: 'custom', message: '予算にない収入の款を入力してください。', path: ['budgetPath'] })
  else if (!INCOME_NUMBER_PATTERN.test(v.itemNumber)) ctx.addIssue({ code: 'custom', message: '収入の項目番号は in01-03-02 の形式で入力してください。', path: ['itemNumber'] })
})
export type IncomeInput = z.input<typeof incomeSchema>

/** 収入の証憑を付ける */
export const incomeFileSchema = z.object({
  kind: z.enum(INCOME_FILE_KINDS, { error: '証憑の種類を選んでください。' }),
})

/** 入金を確かめた（done: true）／確認待ちに戻す（false）（財務局長・財務局長補佐・管理者） */
export const incomeConfirmSchema = z.object({ done: z.boolean() })

/**
 * 出納帳に手で書く記録（財務局長・財務局長補佐・管理者）。
 * 期首の残高・残高の照合は口座のその日の残高、口座間の移動は移した額（移動元 → 移動先）、
 * 調整は増えたら正・減ったら負の額（利息・手数料など）。
 */
export const cashbookRecordSchema = z.object({
  kind: z.enum(Object.keys(CASHBOOK_KINDS) as [CashbookKind, ...CashbookKind[]], { error: '記録の種類を選んでください。' }),
  date,
  account: z.enum(CASH_ACCOUNTS, { error: '口座を選んでください。' }),
  toAccount: z.enum(CASH_ACCOUNTS).or(z.literal('')).default(''),
  amount: z.coerce.number({ error: '金額を数字で入力してください。' }).int('整数で入力してください。'),
  memo: z.string().trim().max(500).default(''),
}).superRefine((v, ctx) => {
  if (v.kind === 'transfer') {
    if (!v.toAccount) ctx.addIssue({ code: 'custom', message: '移動先の口座を選んでください。', path: ['toAccount'] })
    else if (v.toAccount === v.account) ctx.addIssue({ code: 'custom', message: '移動元と移動先は別の口座にしてください。', path: ['toAccount'] })
    if (v.amount <= 0) ctx.addIssue({ code: 'custom', message: '移した金額を入力してください。', path: ['amount'] })
  }
  if (v.kind === 'adjust') {
    if (v.amount === 0) ctx.addIssue({ code: 'custom', message: '調整の金額を入力してください（減ったときは負の数）。', path: ['amount'] })
    if (!v.memo) ctx.addIssue({ code: 'custom', message: '調整の理由を書いてください（利息・手数料など）。', path: ['memo'] })
  }
  if ((v.kind === 'opening' || v.kind === 'check') && v.amount < 0) ctx.addIssue({ code: 'custom', message: '残高は0円以上で入力してください。', path: ['amount'] })
})
export type CashbookRecordInput = z.input<typeof cashbookRecordSchema>

/** 手で入れる仕訳の1行（借方か貸方のどちらかに金額） */
const journalLine = z.object({
  account: required('勘定科目').pipe(z.string().max(100)),
  kind: z.enum(ACCOUNT_KINDS, { error: '科目の区分を選んでください。' }),
  debit: z.coerce.number({ error: '借方の金額を数字で入力してください。' }).int('整数で入力してください。').min(0).default(0),
  credit: z.coerce.number({ error: '貸方の金額を数字で入力してください。' }).int('整数で入力してください。').min(0).default(0),
})

/** 手で入れる仕訳（財務局長・財務局長補佐・管理者）。借方の合計と貸方の合計が同じで、0円でないこと */
export const manualJournalSchema = z.object({
  date,
  memo: required('摘要').pipe(z.string().max(500)),
  lines: z.array(journalLine).min(2, '借方と貸方の行を入れてください。').max(50),
}).superRefine((v, ctx) => {
  const debit = v.lines.reduce((s, l) => s + l.debit, 0)
  const credit = v.lines.reduce((s, l) => s + l.credit, 0)
  if (v.lines.some(l => (l.debit > 0) === (l.credit > 0))) ctx.addIssue({ code: 'custom', message: 'それぞれの行には、借方か貸方のどちらか一方だけに金額を入れてください。', path: ['lines'] })
  else if (debit !== credit) ctx.addIssue({ code: 'custom', message: `借方の合計（${debit.toLocaleString('ja-JP')}円）と貸方の合計（${credit.toLocaleString('ja-JP')}円）が合っていません。`, path: ['lines'] })
  const kinds = new Map<string, string>()
  for (const l of v.lines) {
    if (kinds.has(l.account) && kinds.get(l.account) !== l.kind) ctx.addIssue({ code: 'custom', message: `「${l.account}」の区分が行によって違います。`, path: ['lines'] })
    kinds.set(l.account, l.kind)
  }
})
export type ManualJournalInput = z.input<typeof manualJournalSchema>

export const evidenceUploadSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS, { error: '証憑の種類を選んでください。' }),
  amount: z.union([z.literal(''), yen]).default(''),
  date: z.union([z.literal(''), date]).default(''),
  refundTiming: z.union([z.literal(''), z.enum(REFUND_TIMINGS)]).default(''),
})
export type EvidenceUploadInput = z.input<typeof evidenceUploadSchema>

/** 証憑の確認（財務局長・財務局長補佐・管理者）。差し戻しは理由が必須 */
export const evidenceCheckSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm') }),
  z.object({ action: z.literal('undo') }),
  z.object({ action: z.literal('return'), comment: required('差し戻しの理由').pipe(z.string().max(500)) }),
])

export const executeSchema = z.object({
  done: z.boolean(),
  /** 振込のときに使った口座 */
  bank: z.enum(TRANSFER_BANKS).optional(),
  /** 振込のときにかかった振込手数料（かからなければ 0） */
  transferFee: z.coerce.number({ error: '振込手数料を数字で入力してください。' }).int('振込手数料は整数で入力してください。').min(0, '振込手数料は0円以上で入力してください。').optional(),
  /** 発注のとき確定した金額・数量 */
  amount: yen.optional(),
  quantity: z.string().trim().optional(),
})

/** 自分の通知設定（Slack の DM） */
export const notificationSettingsSchema = z.object({
  dmOnCreated: z.boolean(),
  dmOnExecuted: z.boolean(),
  /** Slack に登録しているメール（ECC のメールでも入力してもらう。DM を受け取るなら必須） */
  slackEmail: z.union([z.literal(''), z.string().trim().toLowerCase().pipe(z.email('Slack のメールアドレスの形式で入力してください。'))]).default(''),
}).superRefine((v, ctx) => {
  if ((v.dmOnCreated || v.dmOnExecuted) && !v.slackEmail) {
    ctx.addIssue({ code: 'custom', message: 'Slack に登録しているメールアドレスを入力してください。', path: ['slackEmail'] })
  }
})
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>

/** 予算の集約を始める（財務管理部）。期は第100期で固定 */
export const budgetRoundStartSchema = z.object({
  kind: z.enum(['本予算', '補正予算'], { error: '本予算か補正予算かを選んでください。' }),
})

/** 予算の明細（担当が入力する）。金額は負の数も入れられる（企画納入など） */
export const budgetItemSchema = z.object({
  /** 収入か支出か（足すときだけ使う。直すときは項目番号の頭で決まっていて変えられない） */
  flow: z.enum(['income', 'expense']).default('expense'),
  kan: required('款').pipe(z.string().max(100)),
  kou: z.string().trim().max(100).default(''),
  moku: z.string().trim().max(100).default(''),
  setsu: z.string().trim().max(100).default(''),
  quantity: z.string().trim().max(100).default(''),
  unitPrice: z.union([z.literal(''), z.null(), z.coerce.number({ error: '単価は数字で入力してください。' }).int('単価は整数で入力してください。')]).default(null)
    .transform(v => (v === '' ? null : v)),
  amount: z.coerce.number({ error: '金額を数字で入力してください。' }).int('金額は整数で入力してください。'),
  vendor: z.string().trim().max(100).default(''),
  spec: z.string().trim().max(500).default(''),
  link: z.string().trim().max(1000).default(''),
  plannedTiming: z.string().trim().max(100).default(''),
  remark: z.string().trim().max(1000).default(''),
  isNew: z.boolean().default(false),
  preExecution: z.boolean().default(false),
}).superRefine((v, ctx) => {
  if (!v.kou && !v.moku && !v.setsu) ctx.addIssue({ code: 'custom', message: '項・目・節のどれかに名前を入れてください。', path: ['kou'] })
})
export type BudgetItemInput = z.input<typeof budgetItemSchema>

/** 昨年の予算の明細をコピーする（本予算の集約） */
export const budgetCopySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(5000),
})

/** ②予算の変更（集約とは別に、今の予算の項目を直す・足す・消す）。修正・追加は values、修正・削除は itemNumber が要る */
export const budgetChangeSchema = z.object({
  kind: z.enum(['edit', 'add', 'delete']),
  teamId: z.number().int(),
  itemNumber: z.string().trim().max(50).nullish(),
  values: budgetItemSchema.nullish(),
  reason: z.string().trim().max(1000).default(''),
}).superRefine((v, ctx) => {
  if (v.kind !== 'add' && !v.itemNumber) ctx.addIssue({ code: 'custom', message: '変える項目を選んでください。', path: ['itemNumber'] })
  if (v.kind !== 'delete' && !v.values) ctx.addIssue({ code: 'custom', message: '明細の内容を入力してください。', path: ['values'] })
})
export type BudgetChangeInput = z.input<typeof budgetChangeSchema>

/** 予算の変更の承認・却下（財務管理部）。却下は理由を書く */
export const budgetChangeReviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(1000).default(''),
}).superRefine((v, ctx) => {
  if (v.decision === 'reject' && !v.comment) ctx.addIssue({ code: 'custom', message: '却下の理由を書いてください。', path: ['comment'] })
})

/** 査定待ちの明細をまとめて承認する（査定の「まとめて承認」）。ids は画面に出した行の id */
export const budgetApproveSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(5000),
})

/** 査定（財務管理部）：承認か、要修正（理由を書く） */
export const budgetReviewSchema = z.object({
  decision: z.enum(['approve', 'return']),
  comment: z.string().trim().max(1000).default(''),
}).superRefine((v, ctx) => {
  if (v.decision === 'return' && !v.comment) ctx.addIssue({ code: 'custom', message: '要修正の理由を書いてください。', path: ['comment'] })
})

/** 要修正への担当の返事（⑤に残す） */
export const budgetReplySchema = z.object({
  comment: required('返事').pipe(z.string().max(1000)),
})

/** 局を足す・直す（財務管理部）。局の番号は項目番号の頭になる */
export const budgetBureauSchema = z.object({
  bureauNo: required('局の番号（例：out01）').pipe(z.string().max(20)),
  name: required('局').pipe(z.string().max(30)),
})

const budgetTeamFields = z.object({
  team: required('担当（英語）').pipe(z.string().max(50)),
  nameJa: z.string().trim().max(50).default(''),
})
/** 「統括」「部長」の担当は、英語の略称の1文字目を大文字にする */
const withTeamCode = <T extends { team: string, nameJa: string }>(v: T) => ({ ...v, team: teamCodeFor(v.team, v.nameJa) })

/** 担当の名前（英語の略称）と日本語名を直す（財務管理部） */
export const budgetTeamSchema = budgetTeamFields.transform(withTeamCode)

/** 局の中に担当を足す（財務管理部）。部に入れるなら departmentId */
export const budgetTeamCreateSchema = budgetTeamFields.extend({
  bureauId: z.number().int().positive(),
  departmentId: z.number().int().positive().nullish(),
}).transform(withTeamCode)

/** 担当を部に入れる・部から出す（局の直属にする）（財務管理部） */
export const budgetTeamMoveSchema = z.object({
  departmentId: z.number().int().positive().nullable(),
})

/** 部を足す・直す（財務管理部）。英語名（例: mng）と日本語名（例: 屋外運用部） */
export const budgetDepartmentSchema = z.object({
  code: required('部（英語）').pipe(z.string().max(50)),
  nameJa: z.string().trim().max(50).default(''),
})

/** 担当に割り当てる人（メールアドレスの一覧） */
export const budgetMembersSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase()).max(50).default([]),
})
