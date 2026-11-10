/**
 * 権限（役割）と、それぞれができること。サーバー・画面の両方でこの表だけを見て判定する。
 * 全員がすべての申請を閲覧できる。財務局長・財務局長補佐・管理者はできることが同じで、名前（肩書き）だけが違う。
 * 財務管理部は予算の集約・査定だけができる。それ以外は一般。
 * 役割を足したり、できることを変えたりするときはここを直す。
 */
export const ROLES = ['member', 'budget_officer', 'finance_deputy', 'finance_chief', 'admin'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  member: '一般',
  budget_officer: '財務管理部',
  finance_deputy: '財務局長補佐',
  finance_chief: '財務局長',
  admin: '管理者',
}

/** 特別な権限を持つ役割（財務局長・財務局長補佐・管理者） */
const STAFF = ['finance_deputy', 'finance_chief', 'admin'] as const

export const PERMISSIONS = {
  /** すべての申請（添付の請求書・領収書を含む）を見る。一般も可 */
  viewAllEntries: ROLES,
  /** 振込先の口座情報を見る */
  viewBankAccount: STAFF,
  /** 対応済みにする / 戻す、明細ごとの執行額などを直す */
  executeEntries: STAFF,
  /** 決算シートの出力（Excel・スプレッドシート） */
  exportSettlement: STAFF,
  /** 予算の集約を始める・査定する・確定する、局と担当を整える（最初の予算の取り込みも） */
  reviewBudget: ['budget_officer', ...STAFF],
  /** 集約の段取り（局・部・担当と入力する人の設定、集約の開始・終了・査定開始・確定・中止）。昨年の本予算・決算の取り込みは、管理者と、ZAI の zas に割り当てられた人だけ（budgetAccess.ts） */
  arrangeBudget: STAFF,
  /** 委員の登録・権限変更 */
  manageUsers: STAFF,
  /** 出納帳を見る・期首の残高や移動・調整・残高の照合を記録する */
  manageCashbook: STAFF,
} as const satisfies Record<string, readonly Role[]>
export type Permission = keyof typeof PERMISSIONS

export function can(role: Role | undefined | null, permission: Permission) {
  return role != null && (PERMISSIONS[permission] as readonly Role[]).includes(role)
}
