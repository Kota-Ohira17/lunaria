import { asc, eq, inArray } from 'drizzle-orm'
import { can } from '../../shared/roles'
import { shortenItemNumbers } from '../../shared/itemNumbers'
import type { Entry } from '../db/schema'

type SessionUser = { email: string, role: Parameters<typeof can>[0] }

/** 付けた証憑を消せるか（付けた本人か、財務局長・財務局長補佐・管理者） */
export function canDeleteEvidence(user: SessionUser, file: { uploadedBy: string }) {
  return file.uploadedBy === user.email || can(user.role, 'executeEntries')
}

/**
 * 証憑のファイル名（拡張子なし）。「項目番号_担当名_支出項目名_月日（4桁）」。
 * 月日は証憑の日付（立替日・執行日）、なければ提出した日。同じ申請の2枚目からは末尾に _2, _3。
 * 例: out01-04-01~03_資材計画部長_レンタカー代_1017
 */
export function evidenceLabel(entry: Pick<Entry, 'itemNumber' | 'inCharge' | 'itemName'>, date: string, nth: number) {
  return [
    shortenItemNumbers(entry.itemNumber),
    entry.inCharge,
    entry.itemName,
    monthDayOf(date),
    nth > 1 ? String(nth) : '',
  ].filter(Boolean).join('_')
}

/** 「2026-10-17」→「1017」 */
const monthDayOf = (date: string) => date.slice(5, 7) + date.slice(8, 10)

/** 日付を日本時間の YYYY-MM-DD にする */
export function dateInJapan(d: Date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d)
}

/** 今日の日付（日本時間、YYYY-MM-DD） */
export const todayInJapan = () => dateInJapan(new Date())

/** 申請ごとの証憑の一覧（ファイル名つき、付けた順） */
export async function evidencesOf(entryIds: number[]) {
  if (!entryIds.length) return new Map<number, EvidenceView[]>()
  const ev = schema.evidenceFiles
  const rows = await useDb()
    .select({
      id: ev.id,
      entryId: ev.entryId,
      kind: ev.kind,
      amount: ev.amount,
      date: ev.date,
      uploadedBy: ev.uploadedBy,
      createdAt: ev.createdAt,
      fileName: schema.attachments.fileName,
    })
    .from(ev)
    .innerJoin(schema.attachments, eq(schema.attachments.id, ev.attachmentId))
    .where(inArray(ev.entryId, entryIds))
    .orderBy(asc(ev.id))
  return Map.groupBy(rows, r => r.entryId)
}

export type EvidenceView = {
  id: number
  entryId: number
  kind: string
  amount: number | null
  date: string | null
  uploadedBy: string
  createdAt: Date
  fileName: string
}

/** 申請の一覧に証憑の一覧を付ける */
export async function withEvidences<T extends Entry>(rows: T[]): Promise<(T & { evidences: EvidenceView[] })[]> {
  const byEntry = await evidencesOf(rows.map(r => r.id))
  return rows.map(r => ({ ...r, evidences: byEntry.get(r.id) ?? [] }))
}
