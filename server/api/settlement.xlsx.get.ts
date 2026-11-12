import ExcelJS from 'exceljs'
import type { CellValue, Table } from '../utils/settlement'

/** 決算シート（Excel）。中身は server/utils/settlement.ts（スプレッドシート出力と共通） */
export default defineEventHandler(async (event) => {
  await requirePermission(event, 'exportSettlement')
  const tables = await buildSettlementTables(getRequestURL(event).origin)

  const wb = new ExcelJS.Workbook()
  wb.creator = '財務管理システム'
  wb.created = new Date()
  for (const t of tables) writeTable(wb, t)

  const buffer = await wb.xlsx.writeBuffer()
  const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replaceAll('-', '')
  setResponseHeaders(event, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="settlement_${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(`決算_${stamp}.xlsx`)}`,
    'Cache-Control': 'private, no-store',
  })
  return Buffer.from(buffer)
})

const NUM_FMT = { yen: '#,##0;[Red]-#,##0', currency: '[$¥-411]#,##0', rate: '0.0%', date: 'yyyy/mm/dd' } as const
/** 決算シートと同じフォント */
const SHEET_FONT = { name: 'Arial', size: 9 }
const RED = { argb: 'FFFF0000' }
const LINK_COLOR = { argb: 'FF0B6BCB' }

const solid = (hex: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex}` } })

/** セルの値。複数のリンクは名前を改行で並べ、最初のファイルへのリンクにする（Excel は1セル1リンクのため） */
function cellValue(v: CellValue | undefined): ExcelJS.CellValue {
  if (v && typeof v === 'object' && 'links' in v) return { text: v.links.map(l => l.text).join('\n'), hyperlink: v.links[0]!.url }
  if (v && typeof v === 'object' && 'url' in v) return { text: v.text, hyperlink: v.url }
  return v ?? null
}
const isLink = (v: CellValue | undefined) => !!v && typeof v === 'object' && ('url' in v || 'links' in v)

function writeTable(wb: ExcelJS.Workbook, table: Table) {
  const headerRow = table.title ? 2 : 1
  const ws = wb.addWorksheet(table.name, { views: [{ state: 'frozen', ySplit: headerRow }] })
  ws.columns = table.columns.map(c => ({ key: c.key, width: c.width, style: c.format ? { numFmt: NUM_FMT[c.format] } : undefined }))
  const font = (extra: Partial<ExcelJS.Font> = {}) => (table.sheetStyle ? { ...SHEET_FONT, ...extra } : extra)

  // 「決算案｜支出」の行：赤の太字を赤の二重線で囲み、2つ目は2列分につなげる
  if (table.title) {
    const r = ws.addRow(table.title)
    r.font = font({ bold: true, color: RED })
    ws.mergeCells(1, 2, 1, 3)
    const line = { style: 'double' as const, color: RED }
    r.getCell(1).border = { top: line, bottom: line, left: line }
    r.getCell(2).border = { top: line, bottom: line, right: line }
  }
  const head = ws.addRow(table.columns.map(c => c.header))
  head.font = font({ bold: true })
  table.columns.forEach((_, i) => { head.getCell(i + 1).fill = solid(table.sheetStyle ? SHEET_HEADER_FILL : HEADER_FILL) })
  if (!table.sheetStyle) head.border = { bottom: { style: 'thin' } }

  for (const row of table.rows) {
    const r = ws.addRow(Object.fromEntries(Object.entries(row.values).map(([k, v]) => [k, cellValue(v)])))
    r.font = font({ bold: row.bold })
    for (const f of row.fills ?? []) {
      for (let ci = f.from; ci < f.to; ci++) r.getCell(ci + 1).fill = solid(f.color)
    }
    if (row.topBorder) r.border = { top: { style: 'double' } }
    table.columns.forEach((c, i) => {
      const v = row.values[c.key]
      // リンクのセルは青字・下線。複数のリンク・執行年月日などの改行はそのまま見せる
      if (isLink(v)) r.getCell(i + 1).font = font({ color: LINK_COLOR, underline: true })
      const multiline = (typeof v === 'string' && v.includes('\n')) || (!!v && typeof v === 'object' && 'links' in v)
      if (multiline) {
        r.getCell(i + 1).alignment = { wrapText: true, vertical: 'top' }
      }
    })
  }
  // 決算シートと同じ形の表にはフィルタを付けない
  if (!table.sheetStyle) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: table.columns.length } }
}
