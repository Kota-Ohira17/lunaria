<script setup lang="ts">
/**
 * 帳簿の「勘定科目」（財務局長・管理者）。⑭勘定科目DB の一覧・追加・番号・使うかどうか。
 * 口座・繰越などの科目と予算の款の科目は、仕訳を作るときに自動で足す。手入力の仕訳は、ここにある科目から選ぶ。
 */
import { ACCOUNT_KINDS } from '#shared/constants'

const emit = defineEmits<{ changed: [] }>()
const { data: accounts, refresh } = await useFetch('/api/ledger/accounts', { default: () => [] })
type Row = NonNullable<typeof accounts.value>[number]

const ORIGIN_LABELS: Record<Row['origin'], string> = { cash: '口座', budget: '予算の款', system: '決まった科目', manual: '手で足した科目' }
const errors = ref<string[]>([])
const pending = ref(false)
const form = reactive({ name: '', kind: '' as Row['kind'] | '', number: '' })
const numbers = reactive<Record<string, string>>({})
watch(accounts, list => { for (const a of list) numbers[a.name] = a.number }, { immediate: true })

async function run(task: () => Promise<unknown>) {
  errors.value = []
  pending.value = true
  try {
    await task()
    await refresh()
    emit('changed')
  }
  catch (error) {
    errors.value = toMessages(error)
  }
  finally {
    pending.value = false
  }
}
const url = (a: Row) => `/api/ledger/accounts/${encodeURIComponent(a.name)}`
const add = () => run(async () => {
  await $fetch('/api/ledger/accounts', { method: 'POST', body: form })
  Object.assign(form, { name: '', kind: '', number: '' })
})
const saveNumber = (a: Row) => numbers[a.name] !== a.number && run(() => $fetch(url(a), { method: 'PATCH', body: { number: numbers[a.name] } }))
const toggle = (a: Row) => run(() => $fetch(url(a), { method: 'PATCH', body: { disabled: !a.disabled } }))
const remove = (a: Row) => confirm(`勘定科目「${a.name}」を消します。よろしいですか？`) && run(() => $fetch(url(a), { method: 'DELETE' }))
</script>

<template>
  <div class="accounts">
    <p class="hint">
      口座・繰越などの科目と、予算の款の科目は、仕訳を作るときに自動で足します。手入力の仕訳で使う科目（未払金・備品など）はここで足してください。
      科目名は仕訳が名前で指すので、あとから変えられません。使わなくなった科目は「使わない」にすると、手入力の仕訳で選べなくなります。
    </p>
    <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>

    <form class="card add" @submit.prevent="add">
      <h2>勘定科目の追加</h2>
      <div class="inline-row">
        <label><span>勘定科目名<span class="req">*</span></span><input v-model="form.name" required></label>
        <label><span>区分<span class="req">*</span></span>
          <select v-model="form.kind" required><option value="" disabled>選択</option><option v-for="k in ACCOUNT_KINDS" :key="k">{{ k }}</option></select>
        </label>
        <label><span>科目番号</span><input v-model="form.number" class="w-s" placeholder="例：2110"></label>
        <button type="submit" :disabled="pending">追加</button>
      </div>
    </form>

    <div class="table-wrap">
      <table>
        <thead><tr><th>区分</th><th>科目番号</th><th>勘定科目</th><th>出どころ</th><th>状態</th><th /></tr></thead>
        <tbody>
          <tr v-for="a in accounts" :key="a.name" :class="{ off: a.disabled }">
            <td class="muted">{{ a.kind }}</td>
            <td><input v-model="numbers[a.name]" class="w-s" :aria-label="`${a.name} の科目番号`" @change="saveNumber(a)"></td>
            <td>{{ a.name }}</td>
            <td class="muted">{{ ORIGIN_LABELS[a.origin] }}</td>
            <td>{{ a.disabled ? '使わない' : '使う' }}</td>
            <td class="actions">
              <button type="button" class="link" :disabled="pending" @click="toggle(a)">{{ a.disabled ? '使う' : '使わない' }}</button>
              <button v-if="a.origin === 'manual' && !a.used" type="button" class="link danger" :disabled="pending" @click="remove(a)">削除</button>
            </td>
          </tr>
          <tr v-if="!accounts.length"><td colspan="6" class="hint">勘定科目はまだありません。帳簿を開くと自動で足します。</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.accounts { display: grid; gap: .8rem; }
.add { display: grid; gap: .6rem; max-width: none; }
.add h2 { margin: 0; font-size: 1.1rem; }
.inline-row { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; align-items: end; }
.w-s { max-width: 8rem; }
.muted { color: var(--muted); font-size: .85rem; }
.off td { color: var(--muted); }
.actions { white-space: nowrap; display: flex; gap: .8rem; }
.req { color: var(--danger); margin-left: .15rem; }
.danger { color: var(--danger); }
</style>
