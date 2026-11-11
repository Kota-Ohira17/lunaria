import { createSign } from 'node:crypto'

/**
 * 添付ファイルを置く Google ドライブ（委員会の共有ドライブのフォルダ）。
 * サービスアカウント（アプリ専用の Google アカウント）の鍵で JWT を作ってアクセストークンをもらい、Drive API v3 を呼ぶ。
 * 上げる人の Google の許可は要らない。設定（runtimeConfig.googleDrive）がなければ使わない（DB に置く）。
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'
const SCOPE = 'https://www.googleapis.com/auth/drive'

function driveConfig() {
  const { googleDrive } = useRuntimeConfig()
  const key = String(googleDrive?.serviceAccountKey ?? '').replace(/\n/g, '\n')
  const email = String(googleDrive?.serviceAccountEmail ?? '')
  const folderId = String(googleDrive?.folderId ?? '')
  return email && key && folderId ? { email, key, folderId } : null
}

/** ドライブに置く設定があるか */
export const driveEnabled = () => driveConfig() != null

let cached: { token: string, expiresAt: number } | null = null

async function accessToken() {
  const config = driveConfig()
  if (!config) throw createError({ statusCode: 500, message: 'Google ドライブの設定がありません。' })
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  const now = Math.floor(Date.now() / 1000)
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: config.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(config.key).toString('base64url')
  const res = await $fetch<{ access_token: string, expires_in: number }>(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  })
  cached = { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 }
  return cached.token
}

/** ファイルをフォルダに上げ、ID とリンクを返す */
export async function uploadToDrive(fileName: string, contentType: string, data: Buffer) {
  const config = driveConfig()!
  const boundary = `----expenditure${Date.now().toString(36)}`
  const metadata = JSON.stringify({ name: fileName, parents: [config.folderId] })
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  const res = await $fetch<{ id: string, webViewLink: string }>(`${UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${await accessToken()}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  return { driveFileId: res.id, driveUrl: res.webViewLink }
}

/** ドライブのファイルの中身 */
export async function downloadFromDrive(fileId: string) {
  const data = await $fetch<ArrayBuffer>(`${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    responseType: 'arrayBuffer',
  })
  return Buffer.from(data)
}

/** ドライブのファイルをゴミ箱に入れる（消した証憑。共有ドライブのゴミ箱から30日は戻せる） */
export async function trashOnDrive(fileId: string) {
  await $fetch(`${DRIVE_API}/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await accessToken()}` },
    body: { trashed: true },
  })
}
