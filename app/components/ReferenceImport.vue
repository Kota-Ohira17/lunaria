<script setup lang="ts">
/**
 * 昨年の本予算・決算の取り込み（集約の画面。財務局長・財務局長補佐・管理者だけに出す）。支出は「支出」「支出詳細」シート、収入は「収入」「収入詳細」シートの CSV。
 * 取り込んだものは、本予算の集約のとき担当の画面に参考として出る（コピーして使える）。取り込み直すと入れ替わる。
 */
const { data: files, refresh } = await useFetch('/api/budget/references', { default: () => [] })
const { data: access } = await useFetch('/api/budget/access', { default: () => ({ canArrange: false }) })
const KINDS = [
  { kind: 'incomeBudget', label: '本予算（収入）', sheet: '「収入」シート' },
  { kind: 'incomeSettlement', label: '決算（収入）', sheet: '「収入詳細」シート' },
  { kind: 'budget', label: '本予算（支出）', sheet: '「支出」シート' },
  { kind: 'settlement', label: '決算（支出）', sheet: '「支出詳細」シート' },
] as const
type Kind = typeof KINDS[number]['kind']
const fileOf = (kind: Kind) => files.value.find(f => f.kind === kind)
const picked = reactive<Record<Kind, File | null>>({ budget: null, settlement: null, incomeBudget: null, incomeSettlement: null })
const pending = ref<Kind | null>(null)
const errors = ref<string[]>([])
const message = ref('')

async function upload(kind: Kind) {
  const file = picked[kind]
  if (!file) return
  errors.value = []
  message.value = ''
  pending.value = kind
  const form = new FormData()
  form.append('kind', kind)
  form.append('file', file)
  try {
    const res = await $fetch('/api/budget/references', { method: 'POST', body: form })
    message.value = `${KINDS.find(k => k.kind === kind)!.label}を取り込みました（${res.count}件・${formatYen(res.total)}）。`
    picked[kind] = null
    await refresh()
  }
  catch (error) {
    errors.value = toMessages(error)
  }
  finally {
    pending.value = null
  }
}
async function remove(kind: Kind) {
  if (!confirm(`取り込んだ${KINDS.find(k => k.kind === kind)!.label}を消します（コピー済みの明細はそのまま残ります）。よろしいですか？`)) return
  pending.value = kind
  try {
    await $fetch(`/api/budget/references/${kind}`, { method: 'DELETE' })
    await refresh()
  }
  finally {
    pending.value = null
  }
}
const pick = (kind: Kind, e: Event) => { picked[kind] = (e.target as HTMLInputElement).files?.[0] ?? null }
const when = (d: string | Date) => new Date(d).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div v-if="access.canArrange" class="card ref-import">
    <h2>昨年の本予算・決算の取り込み</h2>
    <p class="hint">本予算の集約では、ここで取り込んだ収入・支出の本予算と決算が担当の画面に参考として出て、各担当が選んでコピーできます。CSV（UTF-8 / Shift_JIS）で取り込みます。収入は項目番号が in から、支出は out から始まる明細だけを読みます。</p>
    <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
    <p v-if="message" class="ok">{{ message }}</p>
    <div v-for="k in KINDS" :key="k.kind" class="row">
      <div class="what">
        <strong>{{ k.label }}</strong><span class="muted">{{ k.sheet }}</span>
      </div>
      <div class="state">
        <template v-if="fileOf(k.kind)">
          {{ fileOf(k.kind)!.fileName || '（ファイル名なし）' }}・{{ fileOf(k.kind)!.count }}件・{{ formatYen(fileOf(k.kind)!.total) }}
          <span class="muted">（{{ when(fileOf(k.kind)!.importedAt) }}）</span>
        </template>
        <span v-else class="muted">未取り込み</span>
      </div>
      <div class="actions">
        <input type="file" accept=".csv,text/csv" :aria-label="`${k.label}の CSV`" @change="pick(k.kind, $event)">
        <button :disabled="!picked[k.kind] || pending !== null" @click="upload(k.kind)">{{ fileOf(k.kind) ? '取り込み直し' : '取り込み' }}</button>
        <button v-if="fileOf(k.kind)" class="link" :disabled="pending !== null" @click="remove(k.kind)">削除</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ref-import { max-width: none; display: grid; gap: .6rem; margin-bottom: 1.5rem; }
.ref-import h2 { margin: 0; font-size: 1.05rem; }
.row { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: .3rem 1rem; padding: .6rem 0; border-top: 1px solid var(--border); }
.what { display: grid; }
.what .muted { font-size: .78rem; }
.state { font-size: .88rem; align-self: center; }
.actions { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.actions input { max-width: 20rem; }
.ok { color: var(--done); }
@media (max-width: 600px) {
  .row { grid-template-columns: minmax(0, 1fr); }
  .actions { grid-column: 1; }
}
</style>
