<script setup lang="ts">
/**
 * 帳簿の「期の締め」（財務局長・管理者）。⑮会計期間DB。
 * 締めた期に日付が入る仕訳は、足すことも取り消すこともできない（執行・入金の確認・出納帳の記録・手入力の仕訳）。
 */
const emit = defineEmits<{ changed: [] }>()
const { data: periods, refresh } = await useFetch('/api/ledger/periods', { default: () => [] })
type Period = NonNullable<typeof periods.value>[number]

const errors = ref<string[]>([])
const pending = ref(false)
const form = reactive({ name: '', startDate: '', endDate: '' })
const dateTime = (s: string | Date | null) => (s ? new Date(s).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '')

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
const add = () => run(async () => {
  await $fetch('/api/ledger/periods', { method: 'POST', body: form })
  Object.assign(form, { name: '', startDate: '', endDate: '' })
})
function close(p: Period, done: boolean) {
  const text = done
    ? `期「${p.name}」（${p.startDate}〜${p.endDate}）を締めます。この期に入る仕訳は、足すことも取り消すこともできなくなります。よろしいですか？`
    : `期「${p.name}」の締めを解除します。この期の仕訳をまた変えられるようになります。よろしいですか？`
  if (confirm(text)) run(() => $fetch(`/api/ledger/periods/${p.id}/close`, { method: 'POST', body: { done } }))
}
const remove = (p: Period) => confirm(`期「${p.name}」を消します。よろしいですか？`) && run(() => $fetch(`/api/ledger/periods/${p.id}`, { method: 'DELETE' }))
</script>

<template>
  <div class="periods">
    <p class="hint">
      決算が済んだら、その期を締めてください。締めた期に日付が入る仕訳（執行・入金の確認・出納帳の記録・手入力の仕訳）は、足すことも取り消すこともできなくなり、帳簿がそのまま残ります。
      直す必要があるときは、締めを解除してから直してください。
    </p>
    <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>

    <form class="card add" @submit.prevent="add">
      <h2>期の追加</h2>
      <div class="inline-row">
        <label><span>期の名前<span class="req">*</span></span><input v-model="form.name" placeholder="例：第100期" required></label>
        <label><span>初日<span class="req">*</span></span><input v-model="form.startDate" type="date" required></label>
        <label><span>最終日<span class="req">*</span></span><input v-model="form.endDate" type="date" required></label>
        <button type="submit" :disabled="pending">追加</button>
      </div>
    </form>

    <div class="table-wrap">
      <table>
        <thead><tr><th>期</th><th>初日</th><th>最終日</th><th>状態</th><th /></tr></thead>
        <tbody>
          <tr v-for="p in periods" :key="p.id">
            <td>{{ p.name }}</td>
            <td>{{ p.startDate }}</td>
            <td>{{ p.endDate }}</td>
            <td><span :class="p.closedAt ? 'closed' : 'open'">{{ p.closedAt ? '締め済み' : '未締め' }}</span><small v-if="p.closedAt" class="muted">（{{ dateTime(p.closedAt) }}）</small></td>
            <td class="actions">
              <button v-if="!p.closedAt" type="button" :disabled="pending" @click="close(p, true)">締め</button>
              <button v-else type="button" class="secondary" :disabled="pending" @click="close(p, false)">締めの解除</button>
              <button v-if="!p.closedAt" type="button" class="link danger" :disabled="pending" @click="remove(p)">削除</button>
            </td>
          </tr>
          <tr v-if="!periods.length"><td colspan="5" class="hint">期はまだありません。</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.periods { display: grid; gap: .8rem; }
.add { display: grid; gap: .6rem; max-width: none; }
.add h2 { margin: 0; font-size: 1.1rem; }
.inline-row { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; align-items: end; }
.muted { color: var(--muted); font-size: .85rem; margin-left: .3rem; }
.closed { color: var(--done); font-weight: 600; }
.open { color: var(--muted); }
.actions { white-space: nowrap; display: flex; gap: .8rem; align-items: center; }
.req { color: var(--danger); margin-left: .15rem; }
.danger { color: var(--danger); }
</style>
