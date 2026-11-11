import { asc, eq, inArray } from 'drizzle-orm'
import { can } from '../../shared/roles'
import { shortenItemNumbers } from '../../shared/itemNumbers'
import type { IncomeRecord } from '../db/schema'
import type { SessionUser } from './auth'

/**
 * 収入の記録（income_records）と、その証憑（income_files）。
 * 支出の執行依頼と同じく、だれでも記録でき、だれでも見られる。財務局長・財務局長補佐・管理者が入金を確かめると確認済みになる。
 */

/** 収入の証憑のファイル名（拡張子なし）。「項目番号_担当名_収入項目名_月日（4桁）」 */
export function incomeFileLabel(income: Pick<IncomeRecord, 'itemNumber' | 'inCharge' | 'itemName' | 'receivedOn'>, nth: number) {
  return [
    shortenItemNumbers(income.itemNumber),
    income.inCharge,
    income.itemName,
    income.receivedOn.slice(5).replace('-', ''),
    nth > 1 ? String(nth) : '',
  ].filter(Boolean).join('_')
}

/** 証憑を外せるのは、付けた本人と財務局長・財務局長補佐・管理者 */
export const canDeleteIncomeFile = (user: SessionUser, file: { uploadedBy: string }) => file.uploadedBy === user.email || can(user.role, 'executeEntries')

/** 収入ごとの証憑（ファイル名つき。付けた順） */
export async function incomeFilesOf(ids: number[]) {
  const result = new Map<number, { id: number, kind: string, uploadedBy: string, fileName: string, driveUrl: string | null, createdAt: Date }[]>()
  if (!ids.length) return result
  const db = useDb()
  const files = await db.select({
    id: schema.incomeFiles.id,
    incomeId: schema.incomeFiles.incomeId,
    kind: schema.incomeFiles.kind,
    uploadedBy: schema.incomeFiles.uploadedBy,
    createdAt: schema.incomeFiles.createdAt,
    fileName: schema.attachments.fileName,
    driveUrl: schema.attachments.driveUrl,
  }).from(schema.incomeFiles)
    .innerJoin(schema.attachments, eq(schema.attachments.id, schema.incomeFiles.attachmentId))
    .where(inArray(schema.incomeFiles.incomeId, ids))
    .orderBy(asc(schema.incomeFiles.createdAt))
  for (const { incomeId, ...f } of files) result.set(incomeId, [...(result.get(incomeId) ?? []), f])
  return result
}

/** 画面に返す形（証憑つき。確認した人は出さない） */
export async function withIncomeFiles(rows: IncomeRecord[]) {
  const files = await incomeFilesOf(rows.map(r => r.id))
  return rows.map(({ confirmedBy: _by, ...r }) => ({ ...r, files: files.get(r.id) ?? [] }))
}
