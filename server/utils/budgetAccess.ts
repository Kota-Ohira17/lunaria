import type { H3Event } from 'h3'
import { can } from '../../shared/roles'
import type { SessionUser } from './auth'

/**
 * 集約の段取り（局・部・担当と入力する人の設定）と、昨年の本予算・決算の取り込みができる人：
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
