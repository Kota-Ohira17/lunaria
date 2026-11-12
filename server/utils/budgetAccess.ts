import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { bureauNameOf } from '../../shared/constants'
import { can } from '../../shared/roles'
import type { SessionUser } from './auth'

/**
 * 集約の段取り（局・部・担当と入力する人の設定）ができる人：
 * 財務局長・財務局長補佐・管理者（roles.ts の arrangeBudget）。
 */
export function canArrangeBudget(user: SessionUser) {
  return can(user.role, 'arrangeBudget')
}

/** 段取りができる人でなければ 403 */
export async function requireArrangeBudget(event: H3Event) {
  const user = await requireUser(event)
  if (!canArrangeBudget(user)) throw createError({ statusCode: 403, message: 'この操作は、財務局長・財務局長補佐・管理者だけができます。' })
  return user
}

/**
 * 管理者か、予算を入力する担当が財務局 ZAI の zas の人か（ユーザー管理の「予算を入力する担当」）。
 * 管理者以外は役職では決めない（財務局長・財務局長補佐でも、zas に割り当てられていなければ当たらない）。
 * 昨年の本予算・決算の取り込みと、予算の変更の承認に使う。
 */
export async function isAdminOrZas(user: SessionUser) {
  if (user.role === 'admin') return true
  const me = await useDb().query.users.findFirst({ where: eq(schema.users.email, user.email) })
  return !!me && me.budgetBureau === bureauNameOf('ZAI') && me.budgetTeam.toLowerCase() === 'zas'
}

/** 昨年の本予算・決算の取り込みができるか（管理者と ZAI の zas） */
export const canImportReferences = isAdminOrZas

/** 予算の変更（②）を承認・却下できるか、直接変更できるか（管理者と ZAI の zas） */
export const canApproveBudgetChange = isAdminOrZas

/** 予算の変更を承認できる人でなければ 403 */
export async function requireApproveBudgetChange(event: H3Event) {
  const user = await requireUser(event)
  if (!(await canApproveBudgetChange(user))) throw createError({ statusCode: 403, message: '予算の変更を承認できるのは、管理者と、ZAI の zas に割り当てられた人だけです。' })
  return user
}

/** 取り込みができる人でなければ 403 */
export async function requireImportReferences(event: H3Event) {
  const user = await requireUser(event)
  if (!(await canImportReferences(user))) throw createError({ statusCode: 403, message: 'この操作は、管理者と、ZAI の zas に割り当てられた人だけができます。' })
  return user
}
