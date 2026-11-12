import type { H3Event } from 'h3'
import type { CellValue, Table } from './settlement'

/**
 * Google スプレッドシートへの書き出し。出力する人自身の Google アカウント（アプリに登録しているメールアドレス）で書き込む。
 * 「書き出す」を押したとき、まだ Google の許可をもらっていなければ /auth/google-sheets で許可をもらい、
 * そのアクセストークンをセッション（サーバーだけが読める secure）に1時間ほど覚えておく。
 * 書き出し先は、その人が編集できるスプレッドシートならどれでもよい（共有の手順は要らない）。
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'

/** Google の許可をもらうのに必要な OAuth の設定（NUXT_OAUTH_GOOGLE_CLIENT_ID / _SECRET）があるか */
export function sheetsOAuthConfigured() {
  const { clientId, clientSecret } = serverConfig().oauth.google
  return !!clientId && !!clientSecret
}

/** セッションに覚えている、スプレッドシートを書き込むためのアクセストークン（期限が近ければ null） */
export async function sheetsAccessToken(event: H3Event) {
  const { secure } = await getUserSession(event)
  const token = secure?.googleSheets
  return token && token.expiresAt > Date.now() + 60_000 ? token.accessToken : null
}

/** Google の許可がない・切れたとき。画面はこれを受けて /auth/google-sheets に移る */
export const needsGoogleAuth = () => createError({
  statusCode: 401,
  message: 'Google アカウントでスプレッドシートへの書き込みを許可してください。',
  data: { needsGoogleAuth: true },
})

/** URL（…/spreadsheets/d/<ID>/edit…）か ID そのものから ID を取り出す */
export function spreadsheetIdOf(input: string) {
  const m = input.match(/\/spreadsheets\/d\/([\w-]+)/)
  if (m) return m[1]!
  return /^[\w-]{20,}$/.test(input.trim()) ? input.trim() : null
}

/** Sheets API を呼ぶ。権限・存在のエラーは分かる日本語にする */
async function sheetsApi<T>(token: string, path: string, init: { method?: 'GET' | 'POST' | 'PUT', body?: unknown, query?: Record<string, string> } = {}) {
  try {
    return await $fetch<T>(`${SHEETS_API}/${path}`, {
      method: init.method ?? 'GET',
      body: init.body as Record<string, unknown> | undefined,
      query: init.query,
      headers: { Authorization: `Bearer ${token}` },
    })
  }
  catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    if (status === 401) throw needsGoogleAuth()
    if (status === 403 || status === 404) {
      throw createError({
        statusCode: 400,
        message: 'スプレッドシートを開けませんでした。URL が正しいか、あなたのアカウントでそのスプレッドシートを編集できるか確認してください。',
      })
    }
    throw createError({ statusCode: 502, message: 'スプレッドシートへの書き込みに失敗しました。時間をおいてもう一度試してください。' })
  }
}

const NUMBER_FORMAT = {
  yen: { type: 'NUMBER', pattern: '#,##0;[Red]-#,##0' },
  currency: { type: 'CURRENCY', pattern: '[$¥-411]#,##0' },
  rate: { type: 'PERCENT', pattern: '0.0%' },
  date: { type: 'DATE', pattern: 'yyyy/mm/dd' },
} as const

const rgb = (hex: string) => ({
  red: Number.parseInt(hex.slice(0, 2), 16) / 255,
  green: Number.parseInt(hex.slice(2, 4), 16) / 255,
  blue: Number.parseInt(hex.slice(4, 6), 16) / 255,
})
const RED = { red: 1, green: 0, blue: 0 }

/**
 * セルの値。リンクは HYPERLINK 関数、文字は数式として解釈されないよう先頭の = + - @ を無効化する。
 * 複数のリンクはいったん名前を改行で並べて書き、あとで1つずつリンクを付ける（linkRuns）。
 */
function cellValue(v: CellValue | undefined): string | number | boolean {
  if (v == null) return ''
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replaceAll('-', '/')
  if (typeof v === 'object' && 'links' in v) return v.links.map(l => l.text).join('\n')
  if (typeof v === 'object') return `=HYPERLINK("${v.url.replaceAll('"', '""')}","${v.text.replaceAll('"', '""')}")`
  return /^[=+\-@]/.test(v) ? `'${v}` : v
}

/** 1つのセルに複数のリンク：名前ごとにリンクを付けた文字の書式 */
function linkRuns(links: { text: string, url: string }[]) {
  let at = 0
  return links.map((l) => {
    const run = { startIndex: at, format: { link: { uri: l.url } } }
    at += l.text.length + 1
    return run
  })
}

/**
 * 表をスプレッドシートに書き出す。同じ名前のシートがあれば中身を消して書き直し、なければ追加する。
 * dryRun のときは Google に送らず、送る予定の内容の概要を返す。
 */
export async function writeTablesToSpreadsheet(spreadsheetId: string, tables: Table[], { token, dryRun = false }: { token: string | null, dryRun?: boolean }) {
  const plan = tables.map(t => ({
    name: t.name,
    values: [
      ...(t.title ? [t.title] : []),
      t.columns.map(c => c.header),
      ...t.rows.map(r => t.columns.map(c => cellValue(r.values[c.key]))),
    ],
  }))
  if (dryRun) {
    return { dryRun: true, sheets: plan.map(p => ({ name: p.name, rows: p.values.length, columns: Math.max(...p.values.map(v => v.length)), sample: p.values.slice(0, 4) })) }
  }

  if (!token) throw needsGoogleAuth()
  const meta = await sheetsApi<{ sheets: { properties: { sheetId: number, title: string }, basicFilter?: object, merges?: object[] }[] }>(
    token, spreadsheetId, { query: { fields: 'sheets(properties(sheetId,title),basicFilter.range,merges)' } },
  )
  const sheetIds = new Map(meta.sheets.map(s => [s.properties.title, s.properties.sheetId]))
  const hasFilter = new Set(meta.sheets.filter(s => s.basicFilter).map(s => s.properties.title))
  const hasMerges = new Set(meta.sheets.filter(s => s.merges?.length).map(s => s.properties.title))

  // 足りないシートを追加
  const missing = tables.filter(t => !sheetIds.has(t.name))
  if (missing.length) {
    const added = await sheetsApi<{ replies: { addSheet: { properties: { sheetId: number, title: string } } }[] }>(
      token, `${spreadsheetId}:batchUpdate`,
      { method: 'POST', body: { requests: missing.map(t => ({ addSheet: { properties: { title: t.name } } })) } },
    )
    for (const r of added.replies) sheetIds.set(r.addSheet.properties.title, r.addSheet.properties.sheetId)
  }

  // 中身・書式・入力規則・フィルタ・セルの結合を消して、行数・列数・固定する行をそろえる
  await sheetsApi(token, `${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: {
      requests: tables.flatMap((t, i) => {
        const sheetId = sheetIds.get(t.name)!
        return [
          ...(hasFilter.has(t.name) ? [{ clearBasicFilter: { sheetId } }] : []),
          ...(hasMerges.has(t.name) ? [{ unmergeCells: { range: { sheetId } } }] : []),
          { updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat,dataValidation,textFormatRuns' } },
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { rowCount: plan[i]!.values.length + 5, columnCount: t.columns.length, frozenRowCount: t.title ? 2 : 1 },
              },
              fields: 'gridProperties(rowCount,columnCount,frozenRowCount)',
            },
          },
        ]
      }),
    },
  })

  // 値を書き込む（HYPERLINK 関数や日付を解釈させるため USER_ENTERED）
  await sheetsApi(token, `${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: {
      valueInputOption: 'USER_ENTERED',
      data: plan.map(p => ({ range: `'${p.name}'!A1`, values: p.values })),
    },
  })

  // 書式（フォント・タイトル・見出し・数値の形式・階層の色・複数のリンク・総計の線・列幅・フィルタ）
  const requests: object[] = []
  for (const t of tables) {
    const sheetId = sheetIds.get(t.name)!
    const top = t.title ? 1 : 0
    const rowCount = top + 1 + t.rows.length
    const all = { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: t.columns.length }

    if (t.sheetStyle) {
      // 決算シートと同じ Arial 9
      requests.push({
        repeatCell: { range: all, cell: { userEnteredFormat: { textFormat: { fontFamily: 'Arial', fontSize: 9 } } }, fields: 'userEnteredFormat.textFormat(fontFamily,fontSize)' },
      })
    }
    if (t.title) {
      // 「決算案｜支出」：赤の太字を赤の二重線で囲み、2つ目は2列分につなげる
      const titleRange = { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 }
      const line = { style: 'DOUBLE', color: RED }
      requests.push(
        { mergeCells: { range: { ...titleRange, startColumnIndex: 1 }, mergeType: 'MERGE_ALL' } },
        { repeatCell: { range: titleRange, cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: RED } } }, fields: 'userEnteredFormat.textFormat(bold,foregroundColor)' } },
        { updateBorders: { range: titleRange, top: line, bottom: line, left: line, right: line } },
      )
    }
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: top, endRowIndex: top + 1, startColumnIndex: 0, endColumnIndex: t.columns.length },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: rgb(t.sheetStyle ? SHEET_HEADER_FILL : HEADER_FILL) } },
        fields: 'userEnteredFormat(textFormat.bold,backgroundColor)',
      },
    })

    t.columns.forEach((c, ci) => {
      if (c.format) {
        requests.push({
          repeatCell: {
            range: { sheetId, startRowIndex: top + 1, endRowIndex: rowCount, startColumnIndex: ci, endColumnIndex: ci + 1 },
            cell: { userEnteredFormat: { numberFormat: NUMBER_FORMAT[c.format] } },
            fields: 'userEnteredFormat.numberFormat',
          },
        })
      }
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: ci, endIndex: ci + 1 },
          properties: { pixelSize: Math.round(c.width * 7.5) },
          fields: 'pixelSize',
        },
      })
    })

    t.rows.forEach((r, ri) => {
      const rowIndex = top + 1 + ri
      const range = { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1 }
      if (r.bold) {
        requests.push({
          repeatCell: { range, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' },
        })
      }
      for (const f of r.fills ?? []) {
        requests.push({
          repeatCell: {
            range: { ...range, startColumnIndex: f.from, endColumnIndex: f.to },
            cell: { userEnteredFormat: { backgroundColor: rgb(f.color) } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        })
      }
      if (r.topBorder) requests.push({ updateBorders: { range, top: { style: 'DOUBLE' } } })
      // 1つのセルに複数のリンク：名前ごとにリンクを付ける
      t.columns.forEach((c, ci) => {
        const v = r.values[c.key]
        if (v && typeof v === 'object' && 'links' in v) {
          requests.push({
            updateCells: {
              start: { sheetId, rowIndex, columnIndex: ci },
              rows: [{ values: [{ userEnteredValue: { stringValue: cellValue(v) }, textFormatRuns: linkRuns(v.links) }] }],
              fields: 'userEnteredValue,textFormatRuns',
            },
          })
        }
      })
    })

    // 決算シートと同じ形の表にはフィルタを付けない
    if (!t.sheetStyle) {
      requests.push({ setBasicFilter: { filter: { range: { ...all, startRowIndex: top } } } })
    }
  }
  await sheetsApi(token, `${spreadsheetId}:batchUpdate`, { method: 'POST', body: { requests } })

  return {
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    sheets: plan.map((p, i) => ({ name: p.name, rows: tables[i]!.rows.length })),
  }
}
