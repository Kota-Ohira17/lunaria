import { sql } from 'drizzle-orm'
import { blob, integer, primaryKey, real, sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AccountKind } from '../../shared/constants'
import { CASH_ACCOUNTS, PAYMENT_TYPES } from '../../shared/constants'
import { ROLES } from '../../shared/roles'

/**
 * 添付ファイル（請求書・証憑）。サーバーレス環境（Vercel）ではディスクに保存できないので DB に持つ。
 * 旧GASの folderTable（Drive フォルダIDのハードコード）は不要になり、項目番号で検索できる。
 */
export const attachments = sqliteTable('attachments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  data: blob('data', { mode: 'buffer' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * 執行依頼と証憑提出をまとめて1テーブルで持つ。
 * 旧GASでは「形態別シート・番号順・申請順」に同じ行をコピーしていたが、
 * ここでは1行だけ保存し、一覧はクエリ（ビュー）で切り替える。
 */
export const entries = sqliteTable('entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 表示用の通し番号（執行依頼: E-001 / 証憑: R-001） */
  seq: text('seq').notNull().unique(),
  kind: text('kind', { enum: ['execution', 'evidence'] }).notNull(),
  type: text('type', { enum: PAYMENT_TYPES }).notNull(),
  status: text('status', { enum: ['pending', 'done'] }).notNull().default('pending'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  applicantEmail: text('applicant_email').notNull(),
  applicantName: text('applicant_name').notNull(),
  department: text('department').notNull(),
  inCharge: text('in_charge').notNull(),
  itemNumber: text('item_number').notNull(),
  itemName: text('item_name').notNull(),
  amount: integer('amount'),
  quantity: text('quantity'),
  /** 振込期限・必要日・立替予定日・執行希望日・(証憑)立替日 */
  deadline: text('deadline'),
  remark: text('remark').notNull().default(''),
  /** 形態ごとの追加項目。口座情報は details.bank に入り、財務局長・管理者以外には返さない。予算前執行は preExecution・preExecutionReason・preExecutionItemId（結んだ明細）・preExecutionSettled（本予算の確定で付け替え済み） */
  details: text('details', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  attachmentId: integer('attachment_id').references(() => attachments.id),
  /** 執行時に確定する執行形態（振込（SMBC）/ 口座引落 / 立替 など） */
  paymentMethod: text('payment_method'),
  executedAt: integer('executed_at', { mode: 'timestamp_ms' }),
  executedBy: text('executed_by'),
  /** 証憑を確認した時刻と人（財務局長・管理者）。証憑を付け直す・外すと空に戻る（確認待ち） */
  evidenceCheckedAt: integer('evidence_checked_at', { mode: 'timestamp_ms' }),
  evidenceCheckedBy: text('evidence_checked_by'),
  /** 証憑を差し戻したときの理由。証憑を付け直すと空に戻る */
  evidenceReturnComment: text('evidence_return_comment').notNull().default(''),
})

export const counters = sqliteTable('counters', {
  name: text('name').primaryKey(),
  value: integer('value').notNull(),
})

export type Entry = typeof entries.$inferSelect

/**
 * 本予算または補正予算の「支出」シートの明細（金額のある行）。財務局長・管理者が CSV を取り込むたびに全件入れ替える。
 * key は「項目番号|名前|数量」で、取り込み直しても同じ明細なら同じ key になる。
 */
export const budgetLines = sqliteTable('budget_lines', {
  key: text('key').primaryKey(),
  sortOrder: integer('sort_order').notNull(),
  itemNumber: text('item_number').notNull(),
  /** 項目の内部 ID（①の item_id） */
  itemId: text('item_id').notNull().default(''),
  bureauNo: text('bureau_no').notNull().default(''),
  bureau: text('bureau').notNull().default(''),
  team: text('team').notNull().default(''),
  // スプレッドシートと同じ表を組み立てるための階層。level はこの明細の行がどの階層の名前を持っていたか
  kanNo: text('kan_no').notNull().default(''),
  kan: text('kan').notNull().default(''),
  kouNo: text('kou_no').notNull().default(''),
  kou: text('kou').notNull().default(''),
  moku: text('moku').notNull().default(''),
  setsu: text('setsu').notNull().default(''),
  level: text('level', { enum: ['kan', 'kou', 'moku', 'setsu', 'none'] }).notNull().default('none'),
  /** 款 / 項 / 目 / 節 を「 / 」でつないだ表示名 */
  label: text('label').notNull(),
  quantity: text('quantity').notNull().default(''),
  vendor: text('vendor').notNull().default(''),
  budgetAmount: integer('budget_amount').notNull(),
  link: text('link').notNull().default(''),
  plannedTiming: text('planned_timing').notNull().default(''),
  remark: text('remark').notNull().default(''),
  importedAt: integer('imported_at', { mode: 'timestamp_ms' }).notNull(),
  /** 取り込んだのが本予算か補正予算か（取り込みごとに全明細で同じ値） */
  budgetKind: text('budget_kind', { enum: ['本予算', '補正予算'] }).notNull().default('本予算'),
})

/**
 * 取り込んだ「支出」シートの行をそのまま（見出しより上の行・見出しの行・金額のない見出しの行も含めて）持つ。
 * 決算シートを元のシートと同じ形で出力するために使う。予算を取り込むたびに入れ替える。
 */
export const budgetSheetRows = sqliteTable('budget_sheet_rows', {
  sortOrder: integer('sort_order').primaryKey(),
  /** preamble: 見出しより上の行（「支出の部」）／ header: 見出しの行／ row: それより下の行 */
  role: text('role', { enum: ['preamble', 'header', 'row'] }).notNull(),
  /** セルの文字列の配列（JSON） */
  cells: text('cells', { mode: 'json' }).$type<string[]>().notNull(),
  /** この行が明細（金額の入った行）なら、その明細の key */
  lineKey: text('line_key'),
})

/**
 * 申請と予算明細の対応（1申請に複数明細）。予算を取り込み直しても過去の申請が崩れないよう、
 * 申請時点の明細の内容をコピーして持つ。
 */
export const entryItems = sqliteTable('entry_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entryId: integer('entry_id').notNull().references(() => entries.id),
  lineKey: text('line_key').notNull(),
  itemNumber: text('item_number').notNull(),
  /** 明細の内部 ID（①の item_id） */
  itemId: text('item_id').notNull().default(''),
  label: text('label').notNull(),
  /** 予算での数量・取引先・金額（申請時点のコピー） */
  quantity: text('quantity').notNull().default(''),
  vendor: text('vendor').notNull().default(''),
  budgetAmount: integer('budget_amount').notNull(),
  /** 実際の数量・取引先・執行額（予算から変わることが多い）。未入力なら null */
  actualQuantity: text('actual_quantity'),
  actualVendor: text('actual_vendor'),
  actualAmount: integer('actual_amount'),
})

export type BudgetLine = typeof budgetLines.$inferSelect
export type EntryItem = typeof entryItems.$inferSelect

/**
 * 申請に付けた証憑（領収書など）。台帳から、誰でもどの申請にも付けられる。
 * 1つの申請に複数付けられる（立替で領収書が何枚もある場合など）。
 */
export const evidenceFiles = sqliteTable('evidence_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entryId: integer('entry_id').notNull().references(() => entries.id),
  attachmentId: integer('attachment_id').notNull().references(() => attachments.id),
  /** 領収書 / 見積書 / その他（以前に付けたものには「レシート」もある） */
  kind: text('kind').notNull(),
  /** 証憑の金額・日付（立替なら立替金額・立替日）。分からなければ null */
  amount: integer('amount'),
  date: text('date'),
  uploadedBy: text('uploaded_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export type EvidenceFile = typeof evidenceFiles.$inferSelect

/**
 * 収入の記録（入ってきたお金。協賛金・売上など）。支出の執行依頼にあたる。
 * 収入の予算明細（項目番号が in から始まる）から1つ選ぶか、予算にない収入として款〜節と項目番号を書く。
 * 財務局長・管理者が入金を確かめると確認済みになる。
 */
export const incomeRecords = sqliteTable('income_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 表示用の通し番号（I-001） */
  seq: text('seq').notNull().unique(),
  /** pending＝入金の確認待ち、done＝確認済み */
  status: text('status', { enum: ['pending', 'done'] }).notNull().default('pending'),
  applicantEmail: text('applicant_email').notNull(),
  applicantName: text('applicant_name').notNull(),
  /** 局（略称） */
  department: text('department').notNull(),
  inCharge: text('in_charge').notNull(),
  /** 選んだ収入の予算明細（budget_lines.key）。予算にない収入なら null */
  lineKey: text('line_key'),
  itemNumber: text('item_number').notNull(),
  /** 選んだ収入の予算明細の内部 ID（①の item_id。予算にない収入なら空） */
  itemId: text('item_id').notNull().default(''),
  itemName: text('item_name').notNull(),
  /** 記録したときの予算額（予算にない収入なら null） */
  budgetAmount: integer('budget_amount'),
  /** 入ってきた金額 */
  amount: integer('amount').notNull(),
  /** 入金日 */
  receivedOn: text('received_on').notNull(),
  /** 相手先（協賛企業・購入者など） */
  payer: text('payer').notNull().default(''),
  /** 受け取り方（振込・現金・その他） */
  method: text('method').notNull(),
  /** 振込で受け取った口座（SMBC・ゆうちょ・MUFG）。振込以外は null。出納帳でどの口座に入ったかに使う */
  account: text('account'),
  remark: text('remark').notNull().default(''),
  /** 予算にない収入の款・項・目・節（budgetPath）など */
  details: text('details', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  confirmedAt: integer('confirmed_at', { mode: 'timestamp_ms' }),
  confirmedBy: text('confirmed_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export type IncomeRecord = typeof incomeRecords.$inferSelect

/** 収入の証憑（入金の明細・領収書の控えなど。1件の収入に何枚でも） */
export const incomeFiles = sqliteTable('income_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  incomeId: integer('income_id').notNull().references(() => incomeRecords.id),
  attachmentId: integer('attachment_id').notNull().references(() => attachments.id),
  kind: text('kind').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * 出納帳に手で書く記録（財務局長・管理者）。執行・収入から自動で出る出入り以外のもの。
 * opening＝期首の残高、transfer＝口座間の移動（account → to_account）、adjust＝調整（利息・手数料など。増えたら正）、
 * check＝残高の照合（通帳・手元の現金で数えたその日の残高。帳簿の残高との差を出す）。
 */
export const cashbookRecords = sqliteTable('cashbook_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['opening', 'transfer', 'adjust', 'check'] }).notNull(),
  /** その記録の日付（YYYY-MM-DD） */
  date: text('date').notNull(),
  /** 口座（SMBC・ゆうちょ・MUFG・現金）。移動なら移動元 */
  account: text('account', { enum: CASH_ACCOUNTS }).notNull(),
  /** 移動先（移動のときだけ） */
  toAccount: text('to_account', { enum: CASH_ACCOUNTS }),
  amount: integer('amount').notNull(),
  memo: text('memo').notNull().default(''),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export type CashbookRecord = typeof cashbookRecords.$inferSelect

/**
 * 手で入れた仕訳（財務局長・管理者）。執行・収入・出納帳の記録からの仕訳は持たず、帳簿を開くたびに作る。
 * lines は [{ account, kind, debit, credit }]（借方の合計＝貸方の合計）。
 */
export const manualJournals = sqliteTable('manual_journals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 仕訳の日付（YYYY-MM-DD） */
  date: text('date').notNull(),
  /** 摘要 */
  memo: text('memo').notNull(),
  lines: text('lines', { mode: 'json' }).$type<{ account: string, kind: AccountKind, debit: number, credit: number }[]>().notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export type ManualJournal = typeof manualJournals.$inferSelect

/**
 * ⑬総勘定元帳DB。確定した仕訳を1行ずつ持つ（ERPNext の GL Entry にならう）。
 * もとの記録（③執行依頼・⑧収入・⑨出納帳・⑩手入力の仕訳）とは voucher_type・voucher_id で結ぶ。
 * 行は書き換えない。訂正は、もとの行に is_cancelled を付け、貸借を入れ替えた取り消しの行と新しい行を足す。帳簿に出すのは is_cancelled のない行だけ。
 */
export const GL_VOUCHER_TYPES = ['execution', 'income', 'cashbook', 'manual'] as const
export const glEntries = sqliteTable('gl_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** お金が動いた日（YYYY-MM-DD） */
  postingDate: text('posting_date').notNull(),
  /** 勘定科目と区分（資産・負債・純資産・収入・支出） */
  account: text('account').notNull(),
  accountKind: text('account_kind').$type<AccountKind>().notNull(),
  debit: integer('debit').notNull().default(0),
  credit: integer('credit').notNull().default(0),
  voucherType: text('voucher_type', { enum: GL_VOUCHER_TYPES }).notNull(),
  voucherId: integer('voucher_id').notNull(),
  /** 執行・収入の番号（E-001・I-001）。ほかは空 */
  voucherNo: text('voucher_no').notNull().default(''),
  /** 出納帳の記録の種類（opening・transfer・adjust）。ほかは空 */
  voucherSubtype: text('voucher_subtype').notNull().default(''),
  /** その仕訳の中の行の順番 */
  lineNo: integer('line_no').notNull(),
  /** 摘要 */
  remarks: text('remarks').notNull().default(''),
  /** どの局・担当の分か（ERPNext の Cost Center にあたる。執行・収入だけ） */
  bureau: text('bureau').notNull().default(''),
  team: text('team').notNull().default(''),
  isCancelled: integer('is_cancelled', { mode: 'boolean' }).notNull().default(false),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [
  // 同じ記録の同じ行が二重に入らないように（有効な行だけ）
  uniqueIndex('gl_entries_active_line').on(t.voucherType, t.voucherId, t.lineNo).where(sql`is_cancelled = 0`),
  index('gl_entries_voucher').on(t.voucherType, t.voucherId),
])
export type GlEntry = typeof glEntries.$inferSelect

/**
 * ⑭勘定科目DB（ERPNext の Account にならう）。⑬の account はここの name を指す。
 * 口座・繰越などの科目と、予算の款の科目は、仕訳を作るときに自動で足す。手入力の仕訳は、ここにある科目から選ぶ。
 */
export const ACCOUNT_ORIGINS = ['cash', 'budget', 'system', 'manual'] as const
export const accounts = sqliteTable('accounts', {
  name: text('name').primaryKey(),
  /** 区分（資産・負債・純資産・収入・支出）。ERPNext の root_type */
  kind: text('kind').$type<AccountKind>().notNull(),
  /** 科目番号（並び順に使う。空でもよい） */
  number: text('number').notNull().default(''),
  /** cash＝口座、budget＝予算の款、system＝繰越・雑収入など、manual＝手で足した科目 */
  origin: text('origin', { enum: ACCOUNT_ORIGINS }).notNull().default('manual'),
  /** 使わなくなった科目（手入力の仕訳で選べなくなる。帳簿には出る） */
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
export type Account = typeof accounts.$inferSelect

/**
 * ⑮会計期間DB（ERPNext の Accounting Period にならう）。
 * 締めた期（closed_at がある期）に日付が入る仕訳は、足すことも取り消すこともできない。
 */
export const accountingPeriods = sqliteTable('accounting_periods', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** 期の初日と最終日（YYYY-MM-DD。両端を含む） */
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  closedBy: text('closed_by'),
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
export type AccountingPeriod = typeof accountingPeriods.$inferSelect

/**
 * ユーザーと権限。財務局長・管理者が画面で先に登録するか、初回ログイン時に「一般」で作られる。
 * 環境変数 NUXT_ADMIN_EMAILS のユーザーはログインのたびに管理者に戻る（最初の管理者を作るため）。
 */
export const users = sqliteTable('users', {
  email: text('email').primaryKey(),
  name: text('name').notNull(),
  role: text('role', { enum: ROLES }).notNull().default('member'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  /** 財務局長・管理者が先に登録して、まだログインしていない人は null */
  lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
  /** Slack の DM を受け取るか（自分の申請を受け付けたとき / 対応済みになったとき）。本人が通知設定で変える */
  dmOnCreated: integer('dm_on_created', { mode: 'boolean' }).notNull().default(true),
  dmOnExecuted: integer('dm_on_executed', { mode: 'boolean' }).notNull().default(true),
  /** Slack に登録しているメール（本人が通知設定で入力する）。未入力の人は ECC のメールで Slack のユーザーを探す */
  slackEmail: text('slack_email').notNull().default(''),
  /** 予算の集約で、この人が入力する担当（局名と担当名）。財務管理部が「予算の設定」で割り当てる。空なら未割り当て */
  budgetBureau: text('budget_bureau').notNull().default(''),
  budgetTeam: text('budget_team').notNull().default(''),
})

export type User = typeof users.$inferSelect

/**
 * 予算の集約の段階：集約中（各担当が入力・提出）→ 集約終了（入力を締め切る）→ 査定中（財務管理部が査定、要修正だけ担当が直す）→ 確定
 */
export const BUDGET_ROUND_STATUSES = ['collecting', 'closed', 'reviewing', 'confirmed'] as const
/** 明細の査定の状態：未提出 → 査定待ち → 承認済み、または要修正（担当に戻る） */
export const BUDGET_ITEM_STATUSES = ['draft', 'submitted', 'returned', 'approved'] as const

/**
 * 予算の集約の1回分（本予算・補正予算）。始めるときに、最新の確定した予算をまるごと写す。
 * 確定すると、その明細が予算明細（budget_lines）になる。
 */
export const budgetRounds = sqliteTable('budget_rounds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 期（例: 第100期）。補正予算は本予算と同じ期 */
  term: text('term').notNull(),
  kind: text('kind', { enum: ['本予算', '補正予算'] }).notNull(),
  status: text('status', { enum: BUDGET_ROUND_STATUSES }).notNull().default('collecting'),
  /** 写したもとの集約（最初の予算は null） */
  baseRoundId: integer('base_round_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  createdBy: text('created_by').notNull(),
  confirmedAt: integer('confirmed_at', { mode: 'timestamp_ms' }),
})

/** 集約ごとの局・担当（担当者の名前つき）。並び順は予算の表の順 */
/** 集約ごとの局。担当は局の中のグループとして持つ（budget_teams.bureauId）。並び順は予算の表の順 */
export const budgetBureaus = sqliteTable('budget_bureaus', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roundId: integer('round_id').notNull().references(() => budgetRounds.id),
  /** 局の番号（例: out01）。項目番号の頭になる */
  bureauNo: text('bureau_no').notNull(),
  name: text('name').notNull(),
  sortOrder: real('sort_order').notNull(),
})

/** 集約ごとの部（局の中のグループ。例: 屋外運用部 mng）。担当は部の中に入れる（部に入らない局の直属の担当もある） */
export const budgetDepartments = sqliteTable('budget_departments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roundId: integer('round_id').notNull().references(() => budgetRounds.id),
  bureauId: integer('bureau_id').notNull().references(() => budgetBureaus.id),
  /** 部の英語名（例: mng） */
  code: text('code').notNull(),
  /** 部の日本語名（例: 屋外運用部） */
  nameJa: text('name_ja').notNull().default(''),
  sortOrder: real('sort_order').notNull(),
})

export const budgetTeams = sqliteTable('budget_teams', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roundId: integer('round_id').notNull().references(() => budgetRounds.id),
  /** 属する局 */
  bureauId: integer('bureau_id').references(() => budgetBureaus.id),
  /** 属する部（局の直属なら null） */
  departmentId: integer('department_id').references(() => budgetDepartments.id),
  /** 局の番号と局の名前（局の写し。局を直すと一緒に直す） */
  bureauNo: text('bureau_no').notNull(),
  bureau: text('bureau').notNull(),
  /** 担当名（英語の略称。例: eco）。画面と明細の行にはこの名前を使う */
  team: text('team').notNull(),
  /** 担当の日本語名（例: 環境計画部長）。日本語の担当名で書かれた予算のシート・CSV と合わせるため */
  nameJa: text('name_ja').notNull().default(''),
  /** 担当者の氏名 */
  person: text('person').notNull().default(''),
  sortOrder: real('sort_order').notNull(),
})

export type BudgetRound = typeof budgetRounds.$inferSelect
export type BudgetTeam = typeof budgetTeams.$inferSelect
export type BudgetBureau = typeof budgetBureaus.$inferSelect
export type BudgetDepartment = typeof budgetDepartments.$inferSelect

/**
 * ①予算項目DB と ⑦補正予算項目DB の列（同じ形）。
 * 行は書き換えず、直すたびに1行足す。項目番号ごとに、いちばん新しい行（作成日時）が今の値。
 * 消すときも「削除」の行を足す（いちばん新しい行が削除なら、その項目はない扱い）。
 */
const budgetItemColumns = () => ({
  /** ランダムな id */
  id: text('id').primaryKey(),
  /** 期（例: 第100期） */
  term: text('term').notNull(),
  /** この行を書いた集約（予算の変更・最初の取り込みは null） */
  roundId: integer('round_id'),
  /** 項目番号（例: out01-01-01 ＝ 局-款-項目）。行を足すときに自動で付け、以後はこの番号で同じ項目を追う */
  itemNumber: text('item_number').notNull(),
  /** 項目の内部 ID。項目番号が変わっても同じで、同じ項目の行を結ぶ */
  itemId: text('item_id').notNull().default(''),
  bureau: text('bureau').notNull(),
  team: text('team').notNull(),
  /** 項目名＝款・項・目・節 */
  kan: text('kan').notNull().default(''),
  kou: text('kou').notNull().default(''),
  moku: text('moku').notNull().default(''),
  setsu: text('setsu').notNull().default(''),
  amount: integer('amount').notNull(),
  quantity: text('quantity').notNull().default(''),
  unitPrice: integer('unit_price'),
  /** 仕様等 */
  spec: text('spec').notNull().default(''),
  vendor: text('vendor').notNull().default(''),
  remark: text('remark').notNull().default(''),
  link: text('link').notNull().default(''),
  plannedTiming: text('planned_timing').notNull().default(''),
  isNew: integer('is_new', { mode: 'boolean' }).notNull().default(false),
  preExecution: integer('pre_execution', { mode: 'boolean' }).notNull().default(false),
  /** 削除の行 */
  deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
  /** 案（集約中）／承認済み（予算として確定・承認された） */
  status: text('status', { enum: ['draft', 'approved'] }).notNull().default('draft'),
  sortOrder: real('sort_order').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  /** 作成者（予算の変更は、承認した財務管理部の人） */
  createdBy: text('created_by').notNull(),
})

/** ①予算項目DB（本予算の集約・予算の変更・補正予算の承認で行が増える） */
export const mainBudgetItems = sqliteTable('main_budget_items', budgetItemColumns())
/** ⑦補正予算項目DB（①と同じ形。補正予算の集約で、①の今の値を写してから行を足していく） */
export const revisedBudgetItems = sqliteTable('revised_budget_items', budgetItemColumns())
/** ⑪収入の本予算項目DB（①と同じ列。項目番号が in から始まる行） */
export const mainIncomeItems = sqliteTable('main_income_items', budgetItemColumns())
/** ⑫収入の補正予算項目DB（⑦と同じ列。項目番号が in から始まる行） */
export const revisedIncomeItems = sqliteTable('revised_income_items', budgetItemColumns())
export type BudgetItemRow = typeof mainBudgetItems.$inferSelect

/**
 * 払い出した項目番号の控え。同時に足しても同じ番号にならないよう、ここへの登録で番号を取る（主キーで1つだけ通る）。
 * 集約を中止しても消さないので、一度使った番号はその期の間もう使わない。
 * source：allocated＝新しく振った番号、copy＝昨年の参考の番号をそのまま使った番号。
 * reference_number：昨年の参考をコピーしたのに番号が使えず、新しく振ったときの、もとの参考の番号。
 */
export const issuedItemNumbers = sqliteTable('issued_item_numbers', {
  term: text('term').notNull(),
  itemNumber: text('item_number').notNull(),
  source: text('source', { enum: ['allocated', 'copy'] }).notNull(),
  referenceNumber: text('reference_number').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [primaryKey({ columns: [t.term, t.itemNumber] })])

export type IssuedItemNumber = typeof issuedItemNumbers.$inferSelect

/**
 * ②予算変更申請DB。担当の人が申請し、財務管理部が承認すると①に行を足す（補正予算の集約中は⑦にも）。
 * 財務管理部は直接変更できる（申請と承認を同時に行った扱い）。だれが変えたかは画面に出さない（メールは記録だけ）。
 */
export const BUDGET_CHANGE_REQUEST_KINDS = ['add', 'edit', 'delete'] as const
export const budgetChangeRequests = sqliteTable('budget_change_requests', {
  id: text('id').primaryKey(),
  term: text('term').notNull(),
  /** 項目番号（新規は承認したときに付いた番号） */
  itemNumber: text('item_number').notNull().default(''),
  /** 項目の内部 ID（①の item_id。新規は承認したときに付く） */
  itemId: text('item_id').notNull().default(''),
  bureau: text('bureau').notNull(),
  team: text('team').notNull(),
  /** 新規／変更／削除 */
  kind: text('kind', { enum: BUDGET_CHANGE_REQUEST_KINDS }).notNull(),
  /** 変更後の情報（①とほぼ同じ項目。削除は null） */
  after: text('after', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  /** 変更前の情報（履歴で比べるため。新規は null） */
  before: text('before', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  reason: text('reason').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  createdBy: text('created_by').notNull(),
  sortOrder: real('sort_order').notNull().default(0),
  /** 承認状況：承認待ち／承認／却下／取り下げ */
  status: text('status', { enum: ['pending', 'approved', 'rejected', 'withdrawn'] }).notNull().default('pending'),
  /** 財務管理部が直接変更したもの */
  direct: integer('direct', { mode: 'boolean' }).notNull().default(false),
  reviewComment: text('review_comment').notNull().default(''),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  reviewedBy: text('reviewed_by'),
})
export type BudgetChangeRequest = typeof budgetChangeRequests.$inferSelect

/**
 * ⑤査定DB。提出・承認・要修正・修正・返事を、項目ごとに1行ずつ残す（書き換えない）。
 * 項目の査定の状態は、その集約での最新の行の status。
 */
export const BUDGET_REVIEW_ACTIONS = ['create', 'edit', 'submit', 'approve', 'return', 'reply', 'reflect'] as const
export const budgetReviews = sqliteTable('budget_reviews', {
  id: text('id').primaryKey(),
  roundId: integer('round_id').notNull(),
  itemNumber: text('item_number').notNull(),
  /** 項目の内部 ID（項目番号が変わっても同じ。①⑦の item_id） */
  itemId: text('item_id').notNull().default(''),
  /** 追加／修正／提出／承認／要修正／返事／財務管理部の修正（折衝の反映） */
  action: text('action', { enum: BUDGET_REVIEW_ACTIONS }).notNull(),
  /** この行のあとの査定の状態 */
  status: text('status', { enum: BUDGET_ITEM_STATUSES }).notNull(),
  comment: text('comment').notNull().default(''),
  /** そのときの①⑦の行（どの版を見たか） */
  rowId: text('row_id'),
  /** まとめて行った操作（担当のすべて提出・まとめて承認・すべて承認・集約終了の自動提出） */
  bulk: text('bulk'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  createdBy: text('created_by').notNull(),
})
export type BudgetReview = typeof budgetReviews.$inferSelect

/**
 * 本予算の集約で参考にする、取り込んだ昨年の本予算・決算の明細。
 * 本予算は「支出」シート、決算は「支出詳細」シートの CSV から取り込む。種類ごとに、取り込み直すと入れ替える。
 */
/** 昨年の参考の種類（支出の本予算・決算と、収入の本予算・決算） */
export const BUDGET_REFERENCE_KINDS = ['budget', 'settlement', 'incomeBudget', 'incomeSettlement'] as const
export const budgetReferences = sqliteTable('budget_references', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: BUDGET_REFERENCE_KINDS }).notNull(),
  sortOrder: integer('sort_order').notNull(),
  itemNumber: text('item_number').notNull().default(''),
  bureau: text('bureau').notNull().default(''),
  team: text('team').notNull().default(''),
  kan: text('kan').notNull().default(''),
  kou: text('kou').notNull().default(''),
  moku: text('moku').notNull().default(''),
  setsu: text('setsu').notNull().default(''),
  quantity: text('quantity').notNull().default(''),
  unitPrice: integer('unit_price'),
  amount: integer('amount').notNull(),
  vendor: text('vendor').notNull().default(''),
  spec: text('spec').notNull().default(''),
  link: text('link').notNull().default(''),
  plannedTiming: text('planned_timing').notNull().default(''),
  remark: text('remark').notNull().default(''),
  isNew: integer('is_new', { mode: 'boolean' }).notNull().default(false),
  preExecution: integer('pre_execution', { mode: 'boolean' }).notNull().default(false),
})

/** 取り込んだ昨年の本予算・決算のファイル（種類ごとに1つ） */
export const budgetReferenceFiles = sqliteTable('budget_reference_files', {
  kind: text('kind', { enum: BUDGET_REFERENCE_KINDS }).primaryKey(),
  fileName: text('file_name').notNull(),
  count: integer('count').notNull(),
  total: integer('total').notNull(),
  importedAt: integer('imported_at', { mode: 'timestamp_ms' }).notNull(),
  importedBy: text('imported_by').notNull(),
})
