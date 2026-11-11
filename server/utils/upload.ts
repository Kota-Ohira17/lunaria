import { extname } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { MAX_ATTACHMENT_BYTES } from '../../shared/constants'

/** 添付できるのは PDF・JPEG・PNG だけ（HEIC・WebP は画面で JPEG にしてから送る） */
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png']

type Part = NonNullable<Awaited<ReturnType<typeof readMultipartFormData>>>[number]

/** multipart の `payload`（JSON）と `attachment`（ファイル）を取り出す */
export async function readPayloadAndFile(event: H3Event) {
  const parts = (await readMultipartFormData(event)) ?? []
  const payloadPart = parts.find(p => p.name === 'payload')
  if (!payloadPart) throw createError({ statusCode: 400, message: 'payload がありません。' })
  let payload: unknown
  try {
    payload = JSON.parse(payloadPart.data.toString('utf8'))
  }
  catch {
    throw createError({ statusCode: 400, message: 'payload が JSON ではありません。' })
  }
  const file = parts.find(p => p.name === 'attachment' && p.filename && p.data.length > 0)
  if (file) {
    if (file.data.length > MAX_ATTACHMENT_BYTES) {
      throw createError({ statusCode: 400, message: 'ファイルは4MB以下にしてください。' })
    }
    if (!file.type || !ALLOWED_TYPES.includes(file.type)) {
      throw createError({ statusCode: 400, message: 'PDF・JPEG・PNG のどれかを添付してください。' })
    }
  }
  return { payload, file }
}

/**
 * 添付ファイルを保存し、ID を返す。ファイル名は旧GASと同じく「担当 項目名 種類」にする。
 * ドライブの設定があれば共有ドライブのフォルダに上げてリンクを持ち、なければ DB に中身を持つ。
 */
export async function saveAttachment(file: Part, label: string) {
  const safeLabel = label.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120)
  const fileName = `${safeLabel}${extname(file.filename ?? '').toLowerCase()}`
  const stored = driveEnabled() ? { data: null, ...(await uploadToDrive(fileName, file.type!, file.data)) } : { data: file.data }
  const [row] = await useDb()
    .insert(schema.attachments)
    .values({ fileName, contentType: file.type!, size: file.data.length, ...stored, createdAt: new Date() })
    .returning({ id: schema.attachments.id })
  return row!.id
}

/** 添付ファイルを返す（ドライブに置いたものはドライブから読んで返す）。開ける人かどうかは呼ぶ側で確かめる */
export async function sendAttachment(event: H3Event, id: number) {
  const file = await useDb().query.attachments.findFirst({ where: eq(schema.attachments.id, id) })
  if (!file) throw createError({ statusCode: 404 })
  const data = file.data ?? (file.driveFileId ? await downloadFromDrive(file.driveFileId) : null)
  if (!data) throw createError({ statusCode: 404 })
  setResponseHeaders(event, {
    'Content-Type': file.contentType,
    'Content-Length': String(data.length),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  return data
}

/** 添付ファイルを消す（ドライブに置いたものはゴミ箱に入れる。共有ドライブのゴミ箱から30日は戻せる） */
export async function deleteAttachments(ids: number[]) {
  if (!ids.length) return
  const db = useDb()
  const files = await db.select({ driveFileId: schema.attachments.driveFileId }).from(schema.attachments).where(inArray(schema.attachments.id, ids))
  for (const f of files) {
    if (!f.driveFileId) continue
    try {
      await trashOnDrive(f.driveFileId)
    }
    catch (error) {
      // ドライブで消せなくても DB の記録は消す（ドライブに残ったファイルは手で消せる）
      console.error('ドライブのファイルを消せませんでした', f.driveFileId, error)
    }
  }
  await db.delete(schema.attachments).where(inArray(schema.attachments.id, ids))
}

/** zod のエラーを 400 にする */
export function parseOr400<T>(result: { success: true, data: T } | { success: false, error: { issues: { message: string }[] } }) {
  if (!result.success) {
    throw createError({ statusCode: 400, message: '入力内容に誤りがあります。', data: result.error.issues.map(i => i.message) })
  }
  return result.data
}
