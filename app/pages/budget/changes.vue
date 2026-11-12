<script setup lang="ts">
/**
 * 予算の変更。集約とは別に、確定した予算の支出の明細を直す・足す・消す（収入の予算は集約で変える）。
 * 担当の人は自分の担当の明細について申請し、管理者か ZAI の zas が承認すると予算に反映される（却下には理由を書く）。
 * 承認する人は直接変更できる（すぐ反映）。反映した変更は履歴に残る（だれが変えたかは出さない）。
 * 集約中は変更できない（集約の明細で直す）。執行依頼で使われた明細は、削除ができない。
 */
import type { BudgetItemInput } from '#shared/schemas'
import { BUDGET_TERM } from '#shared/constants'

const { data, refresh } = await useFetch('/api/budget/changes', { key: 'budget-changes' })
/** 承認・却下と、直接の変更ができる人（管理者と ZAI の zas） */
const reviewer = computed(() => !!data.value?.canApprove)

type Change = NonNullable<typeof data.value>['changes'][number]
type Item = NonNullable<typeof data.value>['items'][number]

const KIND_LABELS = { edit: '修正', add: '追加', delete: '削除' } as const
const STATUS = {
  pending: { label: '承認待ち', tone: 'yellow' },
  approved: { label: '反映済み', tone: 'green' },
  rejected: { label: '却下', tone: 'red' },
  withdrawn: { label: '取り下げ', tone: 'gray' },
} as const
/** 変更前後で比べる項目と、その表示名 */
const FIELDS = [
  ['kan', '款'], ['kou', '項'], ['moku', '目'], ['setsu', '節'], ['quantity', '数量'], ['unitPrice', '単価'], ['amount', '金額'],
  ['vendor', '取引先'], ['spec', '仕様・詳細'], ['link', 'リンク'], ['plannedTiming', '執行予定時期'], ['remark', '備考'],
  ['isNew', '新規'], ['preExecution', '予算前執行'],
] as const
const show = (key: string, v: unknown) => {
  if (v == null || v === '') return '（なし）'
  if (typeof v === 'boolean') return v ? 'あり' : 'なし'
  if (key === 'amount' || key === 'unitPrice') return formatYen(Number(v))
  return String(v)
}
/** 変わった項目（修正は変わったものだけ、追加・削除は金額などの主な項目） */
function diffOf(c: Change) {
  const before = (c.before ?? {}) as Record<string, unknown>
  const after = (c.after ?? {}) as Record<string, unknown>
  if (c.kind === 'edit') {
    return FIELDS.filter(([k]) => (before[k] ?? '') !== (after[k] ?? '')).map(([k, label]) => ({ label, from: show(k, before[k]), to: show(k, after[k]) }))
  }
  const values = c.kind === 'add' ? after : before
  return FIELDS.filter(([k]) => ['quantity', 'unitPrice', 'amount', 'vendor'].includes(k) && values[k] != null && values[k] !== '')
    .map(([k, label]) => ({ label, from: '', to: show(k, values[k]) }))
}
const nameOf = (c: Change) => {
  const v = (c.after ?? c.before ?? {}) as Record<string, string>
  return `${v.kan ?? ''} ／ ${[v.kou, v.moku, v.setsu].filter(Boolean).join(' / ')}`
}

/** 一覧のタブ */
const TABS = { pending: '承認待ち', approved: '履歴（反映済み）', closed: '却下・取り下げ' } as const
type Tab = keyof typeof TABS
const tab = ref<Tab>('pending')
const inTab = (c: Change, t: Tab) => (t === 'closed' ? c.status === 'rejected' || c.status === 'withdrawn' : c.status === t)
const listed = computed(() => (data.value?.changes ?? []).filter(c => inTab(c, tab.value)))
const countOf = (t: Tab) => (data.value?.changes ?? []).filter(c => inTab(c, t)).length

/** 局ごとのタブ（件数は今の一覧の件数） */
const bureau = ref('')
const bureaus = computed(() => [...new Set((data.value?.teams ?? []).map(t => t.bureau))])
const bureauTabs = computed(() => [
  { key: '', label: 'すべて', count: listed.value.length },
  ...bureaus.value.map(b => ({ key: b, label: b, count: listed.value.filter(c => c.bureau === b).length })),
])
const shown = computed(() => listed.value.filter(c => !bureau.value || c.bureau === bureau.value))

/** 変更・申請のフォーム */
const creating = ref(false)
const form = reactive({ teamId: '' as number | '', kind: 'edit' as 'edit' | 'add' | 'delete', itemNumber: '', reason: '' })
const myTeams = computed(() => (data.value?.teams ?? []).filter(t => data.value!.editableTeamIds.includes(t.id)))
const teamItems = computed(() => (data.value?.items ?? []).filter(i => i.teamId === form.teamId))
const teamKans = computed(() => [...new Set(teamItems.value.map(i => i.kan).filter(Boolean))])
const picked = computed(() => teamItems.value.find(i => i.number === form.itemNumber))
const pendingOn = (i: Item) => data.value?.pendingItemNumbers.includes(i.number)
watch(() => form.teamId, () => { form.itemNumber = '' })
const pending = ref(false)
const errors = ref<string[]>([])
const message = ref('')
function openForm() {
  creating.value = !creating.value
  message.value = ''
  errors.value = []
  if (myTeams.value.length === 1) form.teamId = myTeams.value[0]!.id
}
async function send(values: BudgetItemInput | null) {
  errors.value = []
  if (form.teamId === '') {
    errors.value = ['担当を選んでください。']
    return
  }
  if (form.kind !== 'add' && form.itemNumber === '') {
    errors.value = ['変える明細を選んでください。']
    return
  }
  if (!reviewer.value && form.kind === 'delete' && !confirm('この明細の削除を申請します。よろしいですか？')) return
  if (reviewer.value && form.kind === 'delete' && !confirm('この明細を予算から削除します。よろしいですか？')) return
  pending.value = true
  try {
    const res = await $fetch('/api/budget/changes', {
      method: 'POST',
      body: { kind: form.kind, teamId: form.teamId, itemNumber: form.kind === 'add' ? null : form.itemNumber, values, reason: form.reason },
    })
    message.value = res.applied ? '予算を変更しました。執行依頼で選ぶ予算にもすぐ反映されています。' : '変更を申請しました。ZAI の zas の承認を待ってください。'
    creating.value = false
    Object.assign(form, { itemNumber: '', reason: '' })
    tab.value = res.applied ? 'approved' : 'pending'
    await Promise.all([refresh(), res.applied && refreshNuxtData(['budget-lines', 'budget-current'])])
  }
  catch (error) {
    errors.value = toMessages(error)
  }
  finally {
    pending.value = false
  }
}

/** 承認・却下（管理者と ZAI の zas）と取り下げ（申請した人） */
const comments = reactive<Record<string, string>>({})
const cardErrors = reactive<Record<string, string[]>>({})
const busy = ref<string | null>(null)
async function act(c: Change, run: () => Promise<unknown>, linesChanged = false) {
  busy.value = c.id
  delete cardErrors[c.id]
  try {
    await run()
    await Promise.all([refresh(), linesChanged && refreshNuxtData(['budget-lines', 'budget-current'])])
  }
  catch (error) {
    cardErrors[c.id] = toMessages(error)
  }
  finally {
    busy.value = null
  }
}
const review = (c: Change, decision: 'approve' | 'reject') =>
  act(c, () => $fetch(`/api/budget/changes/${c.id}/review`, { method: 'POST', body: { decision, comment: comments[c.id] ?? '' } }), decision === 'approve')
function withdraw(c: Change) {
  if (confirm('この申請を取り下げます。よろしいですか？')) act(c, () => $fetch(`/api/budget/changes/${c.id}`, { method: 'DELETE' }))
}
</script>

<template>
  <section>
    <div class="page-head">
      <h1>予算の変更</h1>
      <button v-if="data && data.round && myTeams.length" class="primary" @click="openForm">
        <AppIcon name="plus" /> {{ reviewer ? '予算の変更' : '変更の申請' }}
      </button>
    </div>
    <p class="hint">
      集約とは別に、今の予算（{{ BUDGET_TERM }}）の項目を直す・足す・消すことができます。
      {{ reviewer ? 'あなたの変更はすぐ予算に反映されます。担当からの申請は、承認すると反映されます。収入の予算は、ここでは変えられません（集約で変えます）。' : '申請すると、ZAI の zas が承認したときに予算に反映されます。収入の予算は、ここでは変えられません（集約で変えます）。' }}
    </p>
    <p v-if="data?.round && !myTeams.length && !reviewer" class="card">あなたはまだ担当に割り当てられていないので、変更を申請できません。</p>
    <p v-if="message" class="ok">{{ message }}</p>

    <div v-if="creating" class="card create">
      <h2>{{ reviewer ? '予算の変更' : '変更の申請' }}</h2>
      <div class="fields">
        <label><span>担当<span class="req">*</span></span>
          <select v-model="form.teamId" required>
            <option value="">選んでください</option>
            <option v-for="t in myTeams" :key="t.id" :value="t.id">{{ t.bureau }} ／ {{ t.team }}</option>
          </select>
        </label>
        <fieldset class="kind">
          <legend>変更の種類</legend>
          <label v-for="(label, k) in KIND_LABELS" :key="k" class="check"><input v-model="form.kind" type="radio" :value="k"> {{ label }}</label>
        </fieldset>
      </div>
      <label v-if="form.kind !== 'add' && form.teamId !== ''"><span>変える明細<span class="req">*</span></span>
        <select v-model="form.itemNumber" required>
          <option value="">選んでください</option>
          <option v-for="i in teamItems" :key="i.id" :value="i.number" :disabled="pendingOn(i)">
            {{ i.number }}　{{ i.kan }} ／ {{ itemName(i) }}　{{ formatYen(i.amount) }}{{ pendingOn(i) ? '（承認待ちの変更あり）' : '' }}
          </option>
        </select>
      </label>
      <label><span>理由</span>
        <textarea v-model.trim="form.reason" rows="2" placeholder="例：見積もりが上がったため" />
      </label>
      <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>

      <template v-if="form.teamId !== ''">
        <BudgetItemForm
          v-if="form.kind === 'add'" :key="`add-${form.teamId}`" :kans="teamKans"
          :submit-label="reviewer ? '追加' : '追加を申請'" :pending="pending" @submit="send" @cancel="creating = false"
        />
        <BudgetItemForm
          v-else-if="form.kind === 'edit' && picked" :key="`edit-${picked.id}`" :initial="picked" :kans="teamKans"
          :submit-label="reviewer ? '変更' : '変更を申請'" :pending="pending" @submit="send" @cancel="creating = false"
        />
        <div v-else-if="form.kind === 'delete' && picked" class="buttons">
          <button class="danger" :disabled="pending" @click="send(null)">{{ reviewer ? '削除' : '削除を申請' }}</button>
          <button class="secondary" @click="creating = false">やめる</button>
        </div>
      </template>
    </div>

    <nav class="tabs">
      <button v-for="(label, key) in TABS" :key="key" :class="{ active: tab === key }" @click="tab = key">
        {{ label }}（{{ countOf(key) }}）
      </button>
    </nav>
    <BureauTabs v-model="bureau" :tabs="bureauTabs" />
    <p v-if="!shown.length" class="hint">
      {{ tab === 'pending' ? '承認待ちの変更はありません。' : tab === 'approved' ? 'まだ反映した変更はありません。' : '却下・取り下げた変更はありません。' }}
    </p>

    <div class="card-list">
      <InfoCard
        v-for="c in shown" :key="c.id"
        :status="STATUS[c.status].label" :tone="STATUS[c.status].tone"
        :meta="`${c.itemNumber || '番号なし'}　${c.bureau} ／ ${c.team}`"
        :title="nameOf(c)"
        :when="c.reviewedAt ?? c.createdAt"
        :note="[c.reason && `理由：${c.reason}`, c.reviewComment && `${c.status === 'rejected' ? '却下の理由' : 'コメント'}：${c.reviewComment}`].filter(Boolean).join('\n')"
      >
        <template #tags>
          <span class="tag fill" :class="{ red: c.kind === 'delete', green: c.kind === 'add' }">{{ KIND_LABELS[c.kind] }}</span>
          <span v-if="c.direct" class="tag">直接変更</span>
          <span v-if="c.mine && !c.direct" class="tag">あなたの申請</span>
        </template>
        <!-- カードの中身は <p> の中に入るので、ブロックの要素は使わない -->
        <span class="diff">
          <span v-for="d in diffOf(c)" :key="d.label" class="diff-row">
            <span class="field">{{ d.label }}</span>
            <template v-if="c.kind === 'edit'"><span class="from">{{ d.from }}</span> → <strong>{{ d.to }}</strong></template>
            <span v-else :class="{ from: c.kind === 'delete' }">{{ d.to }}</span>
          </span>
        </span>
        <template v-if="c.status === 'pending' && (reviewer || c.mine)" #footer>
          <div class="actions">
            <template v-if="reviewer">
              <input v-model="comments[c.id]" class="comment" placeholder="コメント（却下のときは必須）">
              <button :disabled="busy !== null" @click="review(c, 'approve')">承認</button>
              <button class="secondary" :disabled="busy !== null" @click="review(c, 'reject')">却下</button>
            </template>
            <button v-if="c.mine" class="link" :disabled="busy !== null" @click="withdraw(c)">取り下げ</button>
          </div>
          <ul v-if="cardErrors[c.id]?.length" class="error"><li v-for="e in cardErrors[c.id]" :key="e">{{ e }}</li></ul>
        </template>
      </InfoCard>
    </div>
  </section>
</template>

<style scoped>
.card { max-width: none; }
.page-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.page-head h1 { margin: 0; }
.primary { display: inline-flex; align-items: center; gap: .35rem; background: #1a73e8; color: #fff; border: none; font-weight: 700; padding: .55rem 1rem; border-radius: 8px; }
.primary:hover:not(:disabled) { background: #1666d0; }
.create { margin: 1rem 0; display: grid; gap: .7rem; }
.create h2 { margin: 0; font-size: 1.05rem; }
.fields { display: flex; flex-wrap: wrap; gap: .6rem 1.5rem; align-items: end; }
.kind { display: flex; flex-wrap: wrap; gap: .3rem 1rem; }
.buttons { display: flex; gap: .5rem; }
.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
.diff { display: grid; gap: .15rem; font-weight: 400; font-size: .88rem; }
.diff-row { display: block; }
.field { display: inline-block; min-width: 6.5rem; color: var(--muted); font-size: .8rem; }
.from { color: var(--muted); text-decoration: line-through; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.comment { flex: 1 1 16rem; max-width: none; }
.ok { color: var(--done); }
:deep(.note) { white-space: pre-line; }
</style>
