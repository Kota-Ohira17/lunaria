import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { can, type Permission } from '../../shared/roles'
import type { User } from '../db/schema'

/** 環境変数 NUXT_ADMIN_EMAILS のユーザー。ログインのたびに管理者になる（最初の管理者を作るため） */
export function isBootstrapAdmin(email: string) {
  const { adminEmails } = serverConfig()
  return adminEmails
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase())
}

export function isAllowedEmail(email: string) {
  const { allowedEmailDomain } = serverConfig()
  return email.toLowerCase().endsWith(`@${allowedEmailDomain.toLowerCase()}`)
}

function toSessionUser(u: User) {
  return { email: u.email, name: u.name, role: u.role }
}

/**
 * ログインの入口はここだけ。どの認証方式（Google / 委員会のログイン / 開発用）でも、
 * 本人確認ができたらこれを呼ぶ。初回はユーザーを「一般」で作り、以降は名前と最終ログインを更新する。
 */
export async function loginAs(event: H3Event, rawEmail: string, name: string, options: { admin?: boolean } = {}) {
  const email = rawEmail.trim().toLowerCase()
  const now = new Date()
  // NUXT_ADMIN_EMAILS の人か、テスト公開で管理者用の合言葉を使った人は管理者にする
  const admin = options.admin || isBootstrapAdmin(email)
  const [user] = await useDb()
    .insert(schema.users)
    .values({ email, name, role: admin ? 'admin' : 'member', createdAt: now, lastLoginAt: now })
    .onConflictDoUpdate({
      target: schema.users.email,
      set: { name, lastLoginAt: now, ...(admin ? { role: 'admin' as const } : {}) },
    })
    .returning()
  // 前にログインしていた人の情報（スプレッドシート用の Google の許可など）を残さないよう、セッションを作り直す
  await replaceUserSession(event, { user: toSessionUser(user!), loggedInAt: Date.now() })
}

/**
 * ログイン中のユーザーを DB から読み直して返す。権限を変えたら次のリクエストから効く。
 * 削除されたユーザーはログアウトさせる。
 */
export async function requireUser(event: H3Event) {
  const session = await requireUserSession(event)
  const user = await useDb().query.users.findFirst({ where: eq(schema.users.email, session.user.email) })
  if (!user) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, message: 'もう一度ログインしてください。' })
  }
  const current = toSessionUser(user)
  if (current.role !== session.user.role || current.name !== session.user.name) {
    await setUserSession(event, { user: current, loggedInAt: session.loggedInAt })
  }
  return current
}

export async function requirePermission(event: H3Event, permission: Permission) {
  const user = await requireUser(event)
  if (!can(user.role, permission)) {
    throw createError({ statusCode: 403, message: 'この操作の権限がありません。' })
  }
  return user
}

export type SessionUser = Awaited<ReturnType<typeof requireUser>>

/** その申請を見てよいか（本人・全件閲覧できる人） */
export function canSeeEntry(user: SessionUser, entry: { applicantEmail: string }) {
  return can(user.role, 'viewAllEntries')
    || entry.applicantEmail === user.email
}
