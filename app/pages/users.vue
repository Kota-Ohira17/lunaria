<script setup lang="ts">
import { PERMISSIONS, ROLE_LABELS, ROLES, type Permission, type Role } from '#shared/roles'

const { can, user: me } = usePermissions()
if (!can('manageUsers')) await navigateTo('/')

const { data: users, refresh } = await useFetch('/api/users', { default: () => [] })
type UserRow = (typeof users.value)[number]

/** 行ごとの編集中の権限 */
const drafts = reactive<Record<string, Role>>({})
watchEffect(() => {
  for (const u of users.value) drafts[u.email] ??= u.role
})
const saving = ref<string>()
const messages = reactive<Record<string, { ok: boolean, text: string }>>({})

const query = ref('')
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return users.value.filter(u => !q || `${u.email} ${u.name} ${ROLE_LABELS[u.role]}`.toLowerCase().includes(q))
})

const changed = (u: UserRow) => drafts[u.email] != null && drafts[u.email] !== u.role

async function save(email: string) {
  const role = drafts[email]!
  saving.value = email
  delete messages[email]
  try {
    await $fetch<unknown>(`/api/users/${encodeURIComponent(email)}`, { method: 'PATCH', body: { role } })
    await refresh()
    messages[email] = { ok: true, text: '保存しました。' }
  }
  catch (error) {
    messages[email] = { ok: false, text: toMessages(error).join(' / ') }
  }
  finally {
    saving.value = undefined
  }
}

async function remove(u: UserRow) {
  if (!confirm(`${u.name}（${u.email}）を削除しますか？\n過去の申請は残ります。次にログインすると一般として登録し直されます。`)) return
  delete messages[u.email]
  try {
    await $fetch<unknown>(`/api/users/${encodeURIComponent(u.email)}`, { method: 'DELETE' })
    delete drafts[u.email]
    await refresh()
  }
  catch (error) {
    messages[u.email] = { ok: false, text: toMessages(error).join(' / ') }
  }
}

/** 委員の追加（まだログインしていない人にも先に権限を付けられる） */
const newUser = reactive({ email: '', name: '', role: 'member' as Role })
const adding = ref(false)
const addErrors = ref<string[]>([])
const added = ref('')
async function add() {
  adding.value = true
  addErrors.value = []
  added.value = ''
  try {
    await $fetch<unknown>('/api/users', { method: 'POST', body: newUser })
    added.value = `${newUser.email} を${ROLE_LABELS[newUser.role]}として登録しました。`
    Object.assign(newUser, { email: '', name: '', role: 'member' })
    await refresh()
  }
  catch (error) {
    addErrors.value = toMessages(error)
  }
  finally {
    adding.value = false
  }
}

const PERMISSION_LABELS: Record<Permission, string> = {
  viewAllEntries: '全申請の閲覧（台帳・添付ファイル）',
  viewBankAccount: '口座情報の閲覧',
  executeEntries: '対応済み操作・執行額の修正',
  exportSettlement: '決算シートの出力',
  reviewBudget: '予算の集約・査定・確定',
  arrangeBudget: '集約の段取り',
  manageUsers: '委員の登録・権限変更',
  manageCashbook: '出納帳（残高の照合）',
}
const formatDate = (d: string | Date | null) => (d ? new Date(d).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '未ログイン')
</script>

<template>
  <section>
    <h1>ユーザーと権限</h1>
    <p class="hint">
      全員がすべての申請を閲覧できます。財務管理部は予算の集約・査定・確定ができます。財務局長・財務局長補佐・管理者はさらに、口座情報の閲覧・対応済み操作・決算シートの出力・集約の段取り・この画面を使えます（できることは同じです）。昨年の本予算・決算の取り込みは、管理者と、予算を入力する担当が ZAI の zas の人だけができます。
      委員をメールアドレスで先に登録しておくこともでき、登録していない人も初回ログインで「一般」として一覧に加わります。
    </p>

    <form class="card add" @submit.prevent="add">
      <h2>委員を追加</h2>
      <div class="add-fields">
        <label>メールアドレス<input v-model.trim="newUser.email" type="email" placeholder="xxxx@g.ecc.u-tokyo.ac.jp" required></label>
        <label>氏名（任意）<input v-model.trim="newUser.name" placeholder="初回ログイン時に更新されます。"></label>
        <label>権限
          <select v-model="newUser.role">
            <option v-for="r in ROLES" :key="r" :value="r">{{ ROLE_LABELS[r] }}</option>
          </select>
        </label>
      </div>
      <ul v-if="addErrors.length" class="error"><li v-for="e in addErrors" :key="e">{{ e }}</li></ul>
      <p v-if="added" class="ok">{{ added }}</p>
      <button type="submit" :disabled="adding">{{ adding ? '追加中…' : '追加' }}</button>
    </form>

    <details class="card perms">
      <summary>権限ごとにできること</summary>
      <table>
        <thead>
          <tr><th />
            <th v-for="r in ROLES" :key="r">{{ ROLE_LABELS[r] }}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>申請・自分の申請の閲覧</th>
            <td v-for="r in ROLES" :key="r" class="mark">○</td>
          </tr>
          <tr v-for="(label, p) in PERMISSION_LABELS" :key="p">
            <th>{{ label }}</th>
            <td v-for="r in ROLES" :key="r" class="mark">{{ (PERMISSIONS[p] as readonly Role[]).includes(r) ? '○' : '' }}</td>
          </tr>
        </tbody>
      </table>
    </details>

    <input v-model="query" type="search" class="search" placeholder="絞り込み（メール・氏名・権限）">

    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>氏名</th><th>メール</th><th>権限</th><th>最終ログイン</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="u in filtered" :key="u.email">
            <td>{{ u.name }}<small v-if="u.email === me?.email">（自分）</small></td>
            <td>{{ u.email }}</td>
            <td>
              <select v-model="drafts[u.email]" :disabled="u.bootstrapAdmin">
                <option v-for="r in ROLES" :key="r" :value="r">{{ ROLE_LABELS[r] }}</option>
              </select>
              <small v-if="u.bootstrapAdmin" class="hint">環境変数で管理者に固定</small>
            </td>
            <td class="nowrap">{{ formatDate(u.lastLoginAt) }}</td>
            <td class="nowrap">
              <button v-if="changed(u)" :disabled="saving === u.email" @click="save(u.email)">
                {{ saving === u.email ? '保存中…' : '保存' }}
              </button>
              <button v-if="u.email !== me?.email && !u.bootstrapAdmin" class="secondary" @click="remove(u)">削除</button>
              <span v-if="messages[u.email]" :class="messages[u.email]!.ok ? 'ok' : 'error'">{{ messages[u.email]!.text }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AttachmentsToDrive v-if="me?.role === 'admin'" />
  </section>
</template>

<style scoped>
.perms { max-width: 560px; margin: 0 0 1rem; padding: .75rem 1rem; }
.perms summary { cursor: pointer; font-weight: 600; }
.perms table { margin-top: .5rem; }
.perms .mark { text-align: center; color: var(--done); font-weight: 700; }
.search { max-width: 420px; margin-bottom: .75rem; }
.nowrap { white-space: nowrap; }
td select { min-width: 9rem; }
.ok { color: var(--done); margin-left: .5rem; }
.error { margin-left: .5rem; }
.add { max-width: none; margin-bottom: 1rem; }
.add h2 { font-size: 1rem; margin: 0; }
.add-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .75rem; }
td button + button { margin-left: .5rem; }
</style>
