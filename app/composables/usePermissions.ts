import { can as canRole, ROLE_LABELS, type Permission } from '#shared/roles'

/** ログイン中のユーザーの権限。表示の出し分け用（実際の制限はサーバー側で行う） */
export function usePermissions() {
  const { user } = useUserSession()
  const can = (permission: Permission) => canRole(user.value?.role, permission)
  const roleLabel = computed(() => (user.value ? ROLE_LABELS[user.value.role] : ''))
  /** 一覧ページの名前（財務局長・財務局長補佐・管理者は全件、それ以外は自分の申請） */
  const entriesTitle = computed(() => (can('viewAllEntries') ? '台帳' : '自分の申請'))
  return { user, can, roleLabel, entriesTitle }
}
