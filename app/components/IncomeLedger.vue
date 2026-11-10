<script setup lang="ts">
/**
 * 台帳の「収入」。記録された収入の一覧（だれでも見られる）。
 * 状態：確認待ち（記録された）→ 確認済み（財務局長・財務局長補佐・管理者が入金を確かめた）。確認待ちに戻すこともできる。
 * 行を開くと、詳しい内容・証憑（付ける・外す）・取り消しが出る。
 */
import { INCOME_FILE_KINDS } from '#shared/constants'

const { user, can } = usePermissions()
const staff = computed(() => can('executeEntries'))
const { data: incomes, refresh } = await useFetch('/api/incomes', { default: () => [] })
type Income = NonNullable<typeof incomes.value>[number]

const filter = ref<'' | 'pending' | 'done'>('')
const shown = computed(() => incomes.value.filter(i => !filter.value || i.status === filter.value))
const total = computed(() => shown.value.reduce((s, i) => s + i.amount, 0))
const opened = ref<number | null>(null)
const errors = ref<string[]>([])
const pending = ref(false)

async function run(task: () => Promise<unknown>) {
  errors.value = []
  pending.value = true
  try {
    await task()
    await refresh()
  }
  catch (error) {
    errors.value = toMessages(error)
  }
  finally {
    pending.value = false
  }
}
const confirmIncome = (i: Income, done: boolean) => run(() => $fetch(`/api/incomes/${i.id}/confirm`, { method: 'POST', body: { done } }))
function cancel(i: Income) {
  if (confirm(`${i.seq}（${i.itemName}・${formatYen(i.amount)}）の記録を取り消します。証憑も消えます。よろしいですか？`)) {
    run(() => $fetch(`/api/incomes/${i.id}`, { method: 'DELETE' }))
  }
}
const canCancel = (i: Income) => staff.value || (i.applicantEmail === user.value?.email && i.status === 'pending')

/** 証憑を付ける */
const fileKind = ref<string>(INCOME_FILE_KINDS[0])
const picked = ref<File | null>(null)
const uploadForm = ref(0)
async function upload(i: Income) {
  const f = picked.value
  if (!f) {
    errors.value = ['証憑ファイルを選んでください。']
    return
  }
  const body = new FormData()
  body.append('payload', JSON.stringify({ kind: fileKind.value }))
  body.append('attachment', f, f.name)
  await run(() => $fetch(`/api/incomes/${i.id}/files`, { method: 'POST', body }))
  picked.value = null
  uploadForm.value++
}
function removeFile(i: Income, f: Income['files'][number]) {
  if (confirm(`証憑「${f.fileName}」を外します。よろしいですか？`)) run(() => $fetch(`/api/incomes/${i.id}/files/${f.id}`, { method: 'DELETE' }))
}
const pathOf = (i: Income) => (i.details as { budgetPath?: { kan: string, kou: string, moku: string, setsu: string } }).budgetPath
</script>

<template>
  <section>
    <nav class="tabs" aria-label="状態で絞り込む">
      <button type="button" :class="{ active: filter === '' }" @click="filter = ''">すべて</button>
      <button type="button" :class="{ active: filter === 'pending' }" @click="filter = 'pending'">確認待ち</button>
      <button type="button" :class="{ active: filter === 'done' }" @click="filter = 'done'">確認済み</button>
    </nav>
    <p class="hint">{{ shown.length }}件・合計 {{ formatYen(total) }}。収入の記録は「<NuxtLink to="/incomes/new">収入の記録</NuxtLink>」から。</p>
    <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>

    <div class="table-wrap">
      <table class="incomes">
        <thead>
          <tr><th>番号</th><th>入金日</th><th>項目番号</th><th>収入項目</th><th class="num">金額</th><th>受け取り方</th><th>記録した人（局/担当）</th><th>状態</th><th>証憑</th></tr>
        </thead>
        <tbody>
          <template v-for="i in shown" :key="i.id">
            <tr class="income-row" @click="opened = opened === i.id ? null : i.id">
              <td>{{ i.seq }}</td>
              <td>{{ i.receivedOn }}</td>
              <td class="muted">{{ i.itemNumber }}</td>
              <td>{{ i.itemName }}<small v-if="!i.lineKey" class="tag">予算にない収入</small></td>
              <td class="num">{{ formatYen(i.amount) }}</td>
              <td>{{ i.method }}<small v-if="i.account">（{{ i.account }}）</small></td>
              <td>{{ i.applicantName }}<small>（{{ i.department }}/{{ i.inCharge }}）</small></td>
              <td><span class="badge" :class="i.status === 'done' ? 'complete' : 'checking'">{{ i.status === 'done' ? '確認済み' : '確認待ち' }}</span></td>
              <td :class="{ 'no-evidence': !i.files.length }">{{ i.files.length ? `${i.files.length}件` : '未提出' }}</td>
            </tr>
            <tr v-if="opened === i.id" class="detail">
              <td colspan="9">
                <dl class="details">
                  <dt>相手先</dt><dd>{{ i.payer || '—' }}</dd>
                  <template v-if="i.budgetAmount != null"><dt>予算額</dt><dd>{{ formatYen(i.budgetAmount) }}</dd></template>
                  <template v-if="pathOf(i)"><dt>款・項・目・節</dt><dd>{{ [pathOf(i)!.kan, pathOf(i)!.kou, pathOf(i)!.moku, pathOf(i)!.setsu].filter(Boolean).join(' / ') }}</dd></template>
                  <template v-if="i.remark"><dt>備考</dt><dd class="remark">{{ i.remark }}</dd></template>
                </dl>

                <strong>証憑（{{ i.files.length }}件）</strong>
                <ul v-if="i.files.length" class="files">
                  <li v-for="f in i.files" :key="f.id">
                    <a :href="`/api/incomes/${i.id}/files/${f.id}`" target="_blank" rel="noopener">{{ f.fileName }}</a>
                    <small class="muted">{{ f.kind }}</small>
                    <button v-if="f.uploadedBy === user?.email || staff" type="button" class="link" @click="removeFile(i, f)">外す</button>
                  </li>
                </ul>
                <form :key="uploadForm" class="upload" @submit.prevent="upload(i)">
                  <select v-model="fileKind" class="fit"><option v-for="k in INCOME_FILE_KINDS" :key="k">{{ k }}</option></select>
                  <input type="file" accept=".pdf,image/*" @change="picked = ($event.target as HTMLInputElement).files?.[0] ?? null">
                  <button type="submit" class="secondary" :disabled="pending">証憑の提出</button>
                </form>

                <div class="actions">
                  <template v-if="staff">
                    <button v-if="i.status === 'pending'" type="button" :disabled="pending" @click="confirmIncome(i, true)">入金の確認</button>
                    <button v-else type="button" class="secondary" :disabled="pending" @click="confirmIncome(i, false)">確認の取り消し</button>
                  </template>
                  <button v-if="canCancel(i)" type="button" class="link danger" :disabled="pending" @click="cancel(i)">記録の取り消し</button>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!shown.length"><td colspan="9" class="hint">まだ収入の記録はありません。</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.tabs { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: .6rem; }
.tabs button { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
.tabs button.active { background: var(--accent-bg); color: var(--accent-text); border-color: var(--accent); font-weight: 700; }
.table-wrap { overflow-x: auto; }
.incomes { border-collapse: collapse; width: 100%; min-width: 56rem; background: var(--surface); }
.incomes th, .incomes td { padding: .45rem .55rem; border-bottom: 1px solid var(--border); text-align: left; font-size: .88rem; vertical-align: top; }
.incomes .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.income-row { cursor: pointer; }
.income-row:hover { background: var(--accent-bg); }
.detail td { background: var(--panel); }
.details { display: grid; grid-template-columns: auto 1fr; gap: .2rem .8rem; margin: 0 0 .8rem; font-size: .88rem; }
.details dt { color: var(--muted); }
.details dd { margin: 0; }
.remark { white-space: pre-wrap; }
.files { margin: .3rem 0 .6rem; padding-left: 1.2rem; }
.files li { margin: .2rem 0; }
.files .link { margin-left: .5rem; }
.upload, .actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-top: .6rem; }
.tag { margin-left: .4rem; }
td.no-evidence { color: var(--danger); font-weight: 600; }
.danger { color: var(--danger); }
</style>
