import { asc, eq, inArray } from 'drizzle-orm'
import { flowOf } from '../../shared/budgetCompile'
import { transferFeeLineKeyOf, transferFeeOf } from '../../shared/cashbook'
import type { BudgetLine, Entry, EntryItem, IncomeRecord } from '../db/schema'
import type { EvidenceView } from './evidence'

/**
 * 決算シートの中身。Excel（/api/settlement.xlsx）とGoogleスプレッドシート（/api/settlement/sheets）の
 * 両方に同じ表を書き出すため、書き出し方に依存しない形で作る。形は決算総会に出す決算シート（MF99_決算）に合わせる。
 * - 「支出詳細」: 執行した明細を 局 → 担当 → 款 の見出しの下に並べ、数量・単価・金額・仕様等・取引先と、款ごとの項目合計・局合計
 * - 「証憑（支出）」: 同じ並びで、金額・執行年月日・執行方法・領収書・その他証憑（ファイル名のリンク）
 * - 「執行一覧」: 対応済みの申請を明細ごとに1行ずつ（証憑へのリンクつき）
 * - 「収入詳細」: 確認済みの収入を、収入の予算明細（項目番号が in から始まる）ごとに足し、支出詳細と同じ並び・見出しで出す
 */

type Link = { text: string, url: string }
/** links: 1つのセルに複数のリンク（改行で並べ、それぞれ開ける） */
export type CellValue = string | number | boolean | Date | null | Link | { links: Link[] }

export interface TableColumn {
  key: string
  header: string
  /** 文字数の目安（px(n) で決算シートと同じピクセル幅） */
  width: number
  /** yen: 1,234 ／ currency: ¥1,234（決算シートと同じ） */
  format?: 'yen' | 'currency' | 'rate' | 'date'
}

export interface TableRow {
  values: Record<string, CellValue>
  bold?: boolean
  /** 背景色（RRGGBB）を塗る列の範囲（from 以上 to 未満の列番号） */
  fills?: { from: number, to: number, color: string }[]
  /** 上に二重線（総計の行） */
  topBorder?: boolean
}

export interface Table {
  name: string
  columns: TableColumn[]
  rows: TableRow[]
  /** 列見出しの上の行（決算シートの「決算案｜支出」。赤字・赤の二重線で囲み、2つ目を2列分につなげる） */
  title?: string[]
  /** 決算シートと同じ見た目にする（Arial 9、見出しは濃いグレーで太字、フィルタなし） */
  sheetStyle?: boolean
}

/** 列見出しの行の色（執行一覧） */
export const HEADER_FILL = 'D9D9D9'
/** 決算シートの列見出しの行の色 */
export const SHEET_HEADER_FILL = 'CCCCCC'
/** 決算シートの局・担当・款の行の色（項・目・節は塗らない） */
const FILL = { bureau: 'FFF2CC', team: 'D9EAD3', kan: 'C9DAF8' } as const

/** 決算シートの列幅（ピクセル）を文字数の目安にする */
const px = (n: number) => n / 7.5

type DoneEntry = Entry & { items: EntryItem[], evidences: EvidenceView[], attachmentName: string | null }

/**
 * 申請の証憑へのリンク（ファイル名を表示）。
 * 台帳から付けた証憑。まだなければ請求書（振込で添付されたもの）
 */
function evidenceLinks(e: DoneEntry, origin: string): Link[] {
  if (e.evidences.length) {
    return e.evidences.map(f => ({ text: f.fileName, url: `${origin}/api/entries/${e.id}/evidences/${f.id}` }))
  }
  if (e.attachmentId) return [{ text: e.attachmentName ?? `${e.seq} 添付`, url: `${origin}/api/entries/${e.id}/attachment` }]
  return []
}

/** 1つのセルに入れる証憑：1件ならリンク、複数なら最初のファイルへのリンクに「ほかN件」を添える */
function evidenceCellOf(links: Link[]): CellValue {
  if (!links.length) return null
  if (links.length === 1) return links[0]!
  return { text: `${links[0]!.text} ほか${links.length - 1}件`, url: links[0]!.url }
}

/** 複数のリンクを1つのセルに（1件ならふつうのリンク） */
const linksCell = (links: Link[]): CellValue => (links.length > 1 ? { links } : links[0] ?? null)

export async function buildSettlementTables(origin: string): Promise<Table[]> {
  const db = useDb()
  const lines = await db.select().from(schema.budgetLines).orderBy(asc(schema.budgetLines.sortOrder))
  const sheetRows = await db.select().from(schema.budgetSheetRows).orderBy(asc(schema.budgetSheetRows.sortOrder))
  const rows = await withEvidences(await withItems(
    await db.select().from(schema.entries).where(eq(schema.entries.status, 'done')).orderBy(asc(schema.entries.createdAt)),
  ))
  // 請求書のファイル名
  const attachmentIds = rows.map(r => r.attachmentId).filter((id): id is number => id != null)
  const names = new Map(attachmentIds.length
    ? (await db.select({ id: schema.attachments.id, fileName: schema.attachments.fileName }).from(schema.attachments).where(inArray(schema.attachments.id, attachmentIds))).map(a => [a.id, a.fileName])
    : [])
  const done: DoneEntry[] = rows.map(r => ({ ...r, attachmentName: r.attachmentId ? names.get(r.attachmentId) ?? null : null }))
  // 支出の決算は支出の明細だけで作る（収入の明細は収入詳細に出す）
  const expenseLines = lines.filter(l => flowOf(l.itemNumber) === 'expense')
  const settled = settledLines(expenseLines, done, sheetExtras(sheetRows))
  const incomes = await db.select().from(schema.incomeRecords).where(eq(schema.incomeRecords.status, 'done')).orderBy(asc(schema.incomeRecords.receivedOn))
  return [
    detailTable(settled), evidenceTable(settled, origin), executionTable(done, origin, expenseLines),
    incomeTable(incomeLines(lines.filter(l => flowOf(l.itemNumber) === 'income'), incomes)),
  ]
}

/**
 * 取り込んだ「支出」シートの行から、予算明細には持っていない 担当者（担当の行）と 仕様・詳細（明細の行）を拾う。
 * 予算をこの機能より前に取り込んでいて行がなければ、空のまま。
 */
function sheetExtras(stored: { role: string, cells: string[], lineKey: string | null }[]) {
  const header = stored.find(r => r.role === 'header')?.cells.map(normalizeHeader) ?? []
  const col = (...names: string[]) => names.map(n => header.indexOf(n)).find(i => i >= 0) ?? -1
  const spec = col('仕様・詳細', '仕様等', '仕様')
  const specs = new Map<string, string>()
  for (const r of stored.filter(r => r.role === 'row')) {
    const at = (i: number) => (i >= 0 ? (r.cells[i] ?? '').trim() : '')
    if (r.lineKey && at(spec)) specs.set(r.lineKey, at(spec))
  }
  return { specs }
}

/** 決算に載せる明細（執行したものだけ、予算の並び順）。予算に載っていない申請は「予算にない項目」の局にまとめる */
interface SettledLine {
  itemNumber: string
  bureau: string
  team: string
  person: string
  kan: string
  kou: string
  moku: string
  setsu: string
  quantity: string
  amount: number
  spec: string
  vendor: string
  note: string
  entries: DoneEntry[]
}

function settledLines(lines: BudgetLine[], done: DoneEntry[], extras: ReturnType<typeof sheetExtras>): SettledLine[] {
  const byKey = new Map(lines.map(l => [l.key, l]))
  const used = new Map<string, { items: { item: EntryItem, entry: DoneEntry }[] }>()
  const outside: SettledLine[] = []
  for (const entry of done) {
    // 振込手数料は、当てた予算明細の執行に足す（明細がなければ「予算にない項目」の振込手数料）
    const fee = transferFeeOf(entry.details)
    if (fee) {
      const feeKey = transferFeeLineKeyOf(entry.details)
      if (feeKey && byKey.has(feeKey)) {
        const feeItem = { lineKey: feeKey, actualAmount: fee, actualQuantity: null, quantity: '', actualVendor: null, vendor: '' } as unknown as EntryItem
        const rec = used.get(feeKey) ?? { items: [] }
        rec.items.push({ item: feeItem, entry })
        used.set(feeKey, rec)
      }
      else outside.push(outsideLine(entry.itemNumber, `振込手数料（${entry.itemName}）`, fee, '', '', [entry]))
    }
    if (!entry.items.length) {
      // 予算にない項目として出した申請は、書いた款・項・目・節と担当を出す
      const path = (entry.details as { budgetPath?: { kan?: string, kou?: string, moku?: string, setsu?: string } }).budgetPath
      outside.push(path?.kan
        ? { ...outsideLine(entry.itemNumber, entry.itemName, entry.amount, entry.quantity ?? '', '', [entry]), team: entry.inCharge, kan: path.kan, kou: path.kou ?? '', moku: path.moku ?? '', setsu: path.setsu ?? '' }
        : outsideLine(entry.itemNumber, entry.itemName, entry.amount, entry.quantity ?? '', '', [entry]))
      continue
    }
    for (const item of entry.items) {
      if (!byKey.has(item.lineKey)) {
        outside.push(outsideLine(item.itemNumber, item.label, actualAmountOf(item, entry), item.actualQuantity ?? item.quantity, item.actualVendor ?? item.vendor, [entry]))
        continue
      }
      const rec = used.get(item.lineKey) ?? { items: [] }
      rec.items.push({ item, entry })
      used.set(item.lineKey, rec)
    }
  }

  const result: SettledLine[] = []
  for (const l of lines) {
    const rec = used.get(l.key)
    if (!rec) continue
    const amounts = rec.items.map(({ item, entry }) => actualAmountOf(item, entry))
    const unknown = amounts.filter(a => a == null).length
    result.push({
      itemNumber: l.itemNumber,
      bureau: l.bureau,
      team: l.team,
      // 担当者の氏名は持たないので、決算シートの「担当者」の列は空にする
      person: '',
      kan: l.kan,
      kou: l.kou,
      moku: l.moku,
      setsu: l.setsu,
      quantity: sumQuantities(rec.items.map(({ item }) => item.actualQuantity ?? item.quantity)),
      amount: amounts.reduce<number>((s, a) => s + (a ?? 0), 0),
      spec: extras.specs.get(l.key) ?? '',
      vendor: [...new Set(rec.items.map(({ item }) => item.actualVendor ?? item.vendor).filter(Boolean))].join('・'),
      note: unknown ? `執行額未入力 ${unknown}件` : '',
      entries: [...new Set(rec.items.map(({ entry }) => entry))],
    })
  }
  return [...result, ...outside]
}

function outsideLine(itemNumber: string, name: string, amount: number | null, quantity: string, vendor: string, entries: DoneEntry[]): SettledLine {
  return {
    itemNumber, bureau: '予算にない項目', team: '', person: '', kan: '', kou: name, moku: '', setsu: '',
    quantity, amount: amount ?? 0, spec: '', vendor, note: amount == null ? '執行額未入力' : '', entries,
  }
}

/** 数量をまとめる。どれも数なら足し、そうでなければ「・」でつなぐ */
function sumQuantities(values: string[]) {
  const list = values.map(v => v.trim()).filter(Boolean)
  if (list.length && list.every(v => /^\d+(\.\d+)?$/.test(v))) return String(list.reduce((s, v) => s + Number(v), 0))
  return [...new Set(list)].join('・')
}

/**
 * 局 → 担当 → 款 の見出しの行を挟みながら明細の行を並べる。
 * 明細の行の 項・目・節 は、上の明細と同じなら空にする（決算シートと同じ書き方）。
 * 項の下に目・節がある明細では、項だけの行を挟み、明細の行には項を書かない。
 */
function groupedRows(settled: SettledLine[], cells: {
  bureau: (l: SettledLine, total: number) => Record<string, CellValue>
  team: (l: SettledLine) => Record<string, CellValue>
  kan: (l: SettledLine, total: number) => Record<string, CellValue>
  line: (l: SettledLine, names: { kou: string, moku: string, setsu: string }) => Record<string, CellValue>
}, fills: { bureau: number, team: number, kan: [number, number], end: number }) {
  const sum = (pick: (l: SettledLine) => boolean) => settled.filter(pick).reduce((s, l) => s + l.amount, 0)
  const rows: TableRow[] = []
  let prev: SettledLine | undefined
  for (const l of settled) {
    const newBureau = l.bureau !== prev?.bureau
    const newTeam = newBureau || l.team !== prev?.team
    const newKan = newTeam || l.kan !== prev?.kan
    if (newBureau) {
      rows.push({ values: cells.bureau(l, sum(x => x.bureau === l.bureau)), fills: [{ from: fills.bureau, to: fills.end, color: FILL.bureau }] })
    }
    if (newTeam && l.team) rows.push({ values: cells.team(l), fills: [{ from: fills.team, to: fills.end, color: FILL.team }] })
    if (newKan && l.kan) {
      rows.push({
        values: cells.kan(l, sum(x => x.bureau === l.bureau && x.team === l.team && x.kan === l.kan)),
        fills: [{ from: fills.kan[0], to: fills.kan[1], color: FILL.kan }],
      })
    }
    const newKou = newKan || l.kou !== prev?.kou
    const newMoku = newKou || l.moku !== prev?.moku
    const newSetsu = newMoku || l.setsu !== prev?.setsu
    // 下に目・節がある明細なら、項だけの行を先に出して明細の行には目・節だけを書く
    const deeper = !!(l.moku || l.setsu)
    if (newKou && l.kou && deeper) rows.push({ values: { kou: l.kou } })
    const kou = newKou && !deeper ? l.kou : ''
    rows.push({ values: cells.line(l, { kou, moku: newMoku ? l.moku : '', setsu: newSetsu ? l.setsu : '' }) })
    prev = l
  }
  return rows
}

function detailTable(settled: SettledLine[]): Table {
  const columns: TableColumn[] = [
    { key: 'number', header: '項目番号', width: px(100) },
    { key: 'bureau', header: '局', width: px(80) },
    { key: 'team', header: '担当', width: px(80) },
    { key: 'person', header: '担当者', width: px(120) },
    { key: 'kan', header: '款', width: px(150) },
    { key: 'kou', header: '項', width: px(150) },
    { key: 'moku', header: '目', width: px(150) },
    { key: 'setsu', header: '節', width: px(150) },
    { key: 'quantity', header: '数量', width: px(50) },
    { key: 'unitPrice', header: '単価', width: px(120), format: 'currency' },
    { key: 'amount', header: '金額', width: px(120), format: 'currency' },
    { key: 'spec', header: '仕様等', width: px(150) },
    { key: 'vendor', header: '取引先', width: px(150) },
    { key: 'note', header: '備考', width: px(170) },
    { key: 'kanTotal', header: '項目合計', width: px(120), format: 'currency' },
    { key: 'bureauTotal', header: '局合計', width: px(120), format: 'currency' },
  ]
  const rows = groupedRows(settled, {
    bureau: (l, total) => ({ bureau: l.bureau, bureauTotal: total }),
    team: l => ({ team: l.team, person: l.person }),
    kan: (l, total) => ({ kan: l.kan, kanTotal: total }),
    line: (l, names) => {
      // 数量が数なら、数値として入れて単価も出す（割り切れるときだけ）
      const qty = /^\d+(\.\d+)?$/.test(l.quantity) ? Number(l.quantity) : null
      const unit = qty && Number.isInteger(l.amount / qty) ? l.amount / qty : null
      return { number: l.itemNumber, ...names, quantity: qty ?? l.quantity, unitPrice: unit, amount: l.amount, spec: l.spec, vendor: l.vendor, note: l.note }
    },
  }, { bureau: 1, team: 2, kan: [4, 15], end: 16 })
  return { name: '支出詳細', columns, rows, title: ['決算案', '支出'], sheetStyle: true }
}

/**
 * 収入の決算に載せる明細（予算の並び順）。確認済みの収入を予算明細ごとに足す。
 * 予算にない収入（予算明細を選ばずに記録したもの・予算から消えた明細）は「予算にない収入」の局にまとめ、書いた款〜節と担当を出す。
 */
function incomeLines(lines: BudgetLine[], incomes: IncomeRecord[]): SettledLine[] {
  const byKey = new Map(lines.map(l => [l.key, l]))
  const used = new Map<string, IncomeRecord[]>()
  const outside: SettledLine[] = []
  const line = (base: Pick<SettledLine, 'itemNumber' | 'bureau' | 'team' | 'kan' | 'kou' | 'moku' | 'setsu'>, list: IncomeRecord[]): SettledLine => ({
    ...base,
    person: '',
    quantity: '',
    amount: list.reduce((sum, i) => sum + i.amount, 0),
    spec: '',
    vendor: [...new Set(list.map(i => i.payer).filter(Boolean))].join('・'),
    note: `${list.length}件（${list.map(i => i.seq).join('・')}）`,
    entries: [],
  })
  for (const i of incomes) {
    if (i.lineKey && byKey.has(i.lineKey)) used.set(i.lineKey, [...(used.get(i.lineKey) ?? []), i])
    else {
      const path = (i.details as { budgetPath?: { kan?: string, kou?: string, moku?: string, setsu?: string } }).budgetPath
      outside.push(line({ itemNumber: i.itemNumber, bureau: '予算にない収入', team: i.inCharge, kan: path?.kan ?? '', kou: path?.kou || i.itemName, moku: path?.moku ?? '', setsu: path?.setsu ?? '' }, [i]))
    }
  }
  const result = lines.filter(l => used.has(l.key)).map(l => line(l, used.get(l.key)!))
  return [...result, ...outside]
}

function incomeTable(settled: SettledLine[]): Table {
  const columns: TableColumn[] = [
    { key: 'number', header: '項目番号', width: px(100) },
    { key: 'bureau', header: '局', width: px(80) },
    { key: 'team', header: '担当', width: px(80) },
    { key: 'kan', header: '款', width: px(150) },
    { key: 'kou', header: '項', width: px(150) },
    { key: 'moku', header: '目', width: px(150) },
    { key: 'setsu', header: '節', width: px(150) },
    { key: 'amount', header: '金額', width: px(120), format: 'currency' },
    { key: 'vendor', header: '相手先', width: px(150) },
    { key: 'note', header: '備考', width: px(170) },
    { key: 'kanTotal', header: '項目合計', width: px(120), format: 'currency' },
    { key: 'bureauTotal', header: '局合計', width: px(120), format: 'currency' },
  ]
  const rows = groupedRows(settled, {
    bureau: (l, total) => ({ bureau: l.bureau, bureauTotal: total }),
    team: l => ({ team: l.team }),
    kan: (l, total) => ({ kan: l.kan, kanTotal: total }),
    line: (l, names) => ({ number: l.itemNumber, ...names, amount: l.amount, vendor: l.vendor, note: l.note }),
  }, { bureau: 1, team: 2, kan: [3, 11], end: 12 })
  return { name: '収入詳細', columns, rows, title: ['決算案', '収入'], sheetStyle: true }
}

/** 執行方法の書き方を決算シートに合わせる */
const METHOD_LABELS: Record<string, string> = { 現金執行: '現金', 'デビット（MUFG）': '三菱UFJ-VISAデビット' }

/** 年月日（2026/6/9） */
const ymd = (date: string | Date) => {
  const s = typeof date === 'string' ? date : dateInJapan(date)
  const [y, m, d] = s.split('-')
  return `${y}/${Number(m)}/${Number(d)}`
}

function evidenceTable(settled: SettledLine[], origin: string): Table {
  const columns: TableColumn[] = [
    { key: 'number', header: '項目番号', width: px(74) },
    { key: 'bureau', header: '局', width: px(50) },
    { key: 'team', header: '担当', width: px(50) },
    { key: 'kan', header: '款', width: px(100) },
    { key: 'kou', header: '項', width: px(100) },
    { key: 'moku', header: '目', width: px(100) },
    { key: 'setsu', header: '節', width: px(100) },
    { key: 'amount', header: '金額', width: px(100), format: 'currency' },
    { key: 'date', header: '執行年月日', width: px(66) },
    { key: 'method', header: '執行方法', width: px(242) },
    { key: 'receipt', header: '領収書', width: px(170) },
    { key: 'other', header: 'その他証憑', width: px(170) },
    { key: 'bank', header: '口座明細', width: px(170) },
    { key: 'card', header: 'カード明細', width: px(170) },
  ]
  const rows = groupedRows(settled, {
    bureau: l => ({ bureau: l.bureau }),
    team: l => ({ team: l.team }),
    kan: l => ({ kan: l.kan }),
    line: (l, names) => {
      // 執行年月日は、証憑の日付（立替日・執行日）があればそれ、なければ ZAI が執行した日
      const dates = [...new Set(l.entries.flatMap((e) => {
        const own = e.evidences.map(f => f.date).filter((d): d is string => !!d)
        return own.length ? own.map(ymd) : e.executedAt ? [ymd(e.executedAt)] : []
      }))]
      const methods = [...new Set(l.entries.map(e => e.paymentMethod ?? e.type).map(m => METHOD_LABELS[m] ?? m))]
      // 領収書（以前に付けた「レシート」も）は「領収書」、それ以外（見積書・請求書など）は「その他証憑」
      const receipts: Link[] = []
      const others: Link[] = []
      for (const e of l.entries) {
        const kinds = new Map(e.evidences.map(f => [`${origin}/api/entries/${e.id}/evidences/${f.id}`, f.kind]))
        for (const link of evidenceLinks(e, origin)) {
          const kind = kinds.get(link.url)
          if (kind === '領収書' || kind === 'レシート') receipts.push(link)
          else others.push(link)
        }
      }
      return {
        number: l.itemNumber,
        ...names,
        amount: l.amount,
        date: dates.join('\n'),
        method: methods.join('\n'),
        receipt: linksCell(receipts),
        other: linksCell(others),
      }
    },
  }, { bureau: 1, team: 2, kan: [3, 14], end: 14 })
  return { name: '証憑（支出）', columns, rows, title: ['決算案証憑', '支出'], sheetStyle: true }
}

function executionTable(done: DoneEntry[], origin: string, lines: BudgetLine[]): Table {
  const byKey = new Map(lines.map(l => [l.key, l]))
  const columns: TableColumn[] = [
    { key: 'seq', header: '申請番号', width: 10 },
    { key: 'createdAt', header: '申請日', width: 12, format: 'date' },
    { key: 'executedAt', header: '執行日', width: 12, format: 'date' },
    { key: 'paymentMethod', header: '執行形態', width: 14 },
    { key: 'department', header: '局', width: 8 },
    { key: 'inCharge', header: '担当', width: 10 },
    { key: 'applicantName', header: '申請者', width: 12 },
    { key: 'itemName', header: '支出項目名', width: 28 },
    { key: 'itemNumber', header: '項目番号', width: 14 },
    { key: 'label', header: '予算明細', width: 40 },
    { key: 'quantity', header: '数量', width: 10 },
    { key: 'vendor', header: '取引先', width: 14 },
    { key: 'budget', header: '予算額', width: 12, format: 'yen' },
    { key: 'actual', header: '執行額', width: 12, format: 'yen' },
    { key: 'entryAmount', header: '申請の金額', width: 12, format: 'yen' },
    { key: 'evidence', header: '証憑', width: 40 },
    { key: 'remark', header: '備考', width: 30 },
  ]
  const rows: TableRow[] = []
  for (const e of done) {
    const base = {
      seq: e.seq,
      createdAt: e.createdAt,
      executedAt: e.executedAt,
      paymentMethod: e.paymentMethod ?? e.type,
      department: e.department,
      inCharge: e.inCharge,
      applicantName: e.applicantName,
      itemName: e.itemName,
      entryAmount: e.amount,
      evidence: evidenceCellOf(evidenceLinks(e, origin)),
      remark: e.remark,
    }
    const fee = feeRow(e, base, byKey)
    if (!e.items.length) {
      rows.push({ values: { ...base, itemNumber: e.itemNumber, label: '（予算にない項目）', actual: e.amount } })
      if (fee) rows.push(fee)
      continue
    }
    for (const i of e.items) {
      rows.push({
        values: {
          ...base,
          itemNumber: i.itemNumber,
          label: i.label,
          // 実際の数量・取引先（入力がなければ予算のもの）
          quantity: i.actualQuantity ?? i.quantity,
          vendor: i.actualVendor ?? i.vendor,
          budget: i.budgetAmount,
          actual: actualAmountOf(i, e),
        },
      })
    }
    if (fee) rows.push(fee)
  }
  return { name: '執行一覧', columns, rows }
}

/** 振込手数料の行（執行一覧で、その申請の明細の行の下に出す） */
function feeRow(e: DoneEntry, base: Record<string, CellValue>, byKey: Map<string, BudgetLine>): TableRow | null {
  const fee = transferFeeOf(e.details)
  if (!fee) return null
  const line = byKey.get(transferFeeLineKeyOf(e.details))
  return { values: { ...base, itemNumber: line?.itemNumber ?? '', label: `振込手数料${line ? `（${line.label}）` : '（予算にない項目）'}`, actual: fee, entryAmount: null } }
}
