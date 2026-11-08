<script setup lang="ts">
/**
 * 収入の記録。入ってきたお金（協賛金・売上など）を記録する。支出の執行依頼にあたる。
 * 収入の予算明細（項目番号が in から始まる）を選ぶか、予算にない収入として款〜節と項目番号を書く。
 * 明細は款などの見出しでまとめて選べ、明細ごとに金額を書く（明細ごとに1件ずつ記録される）。
 * 予算にない収入の項目番号は、局・担当・款を入れると候補が入る（手で直したらそれ以降は上書きしない）。
 */
import { BANK_ACCOUNTS, INCOME_METHODS, bureauCodeOf } from '#shared/constants'

const { user } = useUserSession()
const { submit, errors, pending } = useSubmit<{ seq: string, seqs: string[] }>('/api/incomes')
const { data: lines } = await useIncomeLines()

const form = reactive({
  applicantName: user.value?.name ?? '',
  department: '',
  inCharge: '',
  itemNumber: '',
  budgetPath: { kan: '', kou: '', moku: '', setsu: '' },
  itemName: '',
  amount: '',
  receivedOn: '',
  payer: '',
  method: '',
  account: '',
  remark: '',
})
const file = ref<File | null>(null)
const manual = ref(false)
const useManual = computed(() => manual.value || !lines.value.length)
const nameEdited = ref(false)
const numberEdited = ref(false)
const done = ref<string[]>([])

/** 選んだ明細の key と、明細ごとの金額（選んだときは予算額を入れておく） */
const pickedKeys = ref<string[]>([])
const lineAmounts = ref<Record<string, string>>({})
const byKey = computed(() => new Map(lines.value.map(l => [l.key, l])))
const pickedLines = computed(() => pickedKeys.value.map(k => byKey.value.get(k)).filter(l => l != null).sort((a, b) => a.sortOrder - b.sortOrder))
const pickedTotal = computed(() => pickedLines.value.reduce((s, l) => s + (Number(lineAmounts.value[l.key]) || 0), 0))
watch(pickedKeys, (keys) => {
  lineAmounts.value = Object.fromEntries(keys.map(k => [k, lineAmounts.value[k] ?? String(byKey.value.get(k)?.budgetAmount ?? '')]))
  // 1件だけのときは収入項目名を入れる（局・担当はサーバーで明細から決める）。複数なら明細ごとの名前になる
  const only = keys.length === 1 ? byKey.value.get(keys[0]!) : undefined
  if (only && !nameEdited.value) form.itemName = only.label
})
/** 予算にない収入：款〜節から収入項目名を作り、局・担当・款から項目番号の候補を取る */
watch(() => form.budgetPath, (p) => {
  if (useManual.value && !nameEdited.value) form.itemName = [p.kou || p.kan, p.moku, p.setsu].filter(Boolean).join(' / ')
}, { deep: true })
watch(() => [useManual.value, form.department, form.inCharge, form.budgetPath.kan] as const, async ([m, bureau, team, kan]) => {
  if (!m || numberEdited.value || !bureau || !team.trim()) return
  try {
    const { itemNumber } = await $fetch<{ itemNumber: string }>('/api/budget/next-number', { query: { bureau, team, kan, flow: 'income' } })
    if (!numberEdited.value && itemNumber) form.itemNumber = itemNumber
  }
  catch { /* 候補が出せなくても手で入れられる */ }
})
watch(useManual, (m) => {
  if (m) pickedKeys.value = []
  else {
    form.itemNumber = ''
    form.budgetPath = { kan: '', kou: '', moku: '', setsu: '' }
    numberEdited.value = false
  }
})

async function onSubmit() {
  const picked = useManual.value ? [] : pickedLines.value
  const result = await submit({
    ...form,
    lines: picked.map(l => ({ key: l.key, amount: lineAmounts.value[l.key] })),
    itemName: picked.length > 1 ? '' : form.itemName,
    amount: picked.length ? '' : form.amount,
    itemNumber: useManual.value ? form.itemNumber : '',
  }, file.value)
  if (result) done.value = result.seqs ?? [result.seq]
}
</script>

<template>
  <section class="page">
    <h1>収入の記録</h1>

    <div v-if="done.length" class="success">
      <p>記録しました（{{ done.length > 1 ? `${done.length}件、番号 ${done.join('・')}` : `番号 ${done[0]}` }}）。財務局長・管理者が入金を確かめると、確認済みになります。</p>
      <NuxtLink :to="{ path: '/entries', query: { flow: 'income' } }">台帳（収入）へ</NuxtLink>
    </div>

    <form v-else @submit.prevent="onSubmit">
      <div class="intro">
        <p>協賛金・売上など、入ってきたお金を記録するフォームです。</p>
        <p>収入の予算（項目番号が in から始まるもの）から項目を選んでください。予算にない収入は手入力できます。</p>
      </div>

      <fieldset>
        <legend>記録する人</legend>
        <label><span>記録する人の氏名<span class="req">*</span></span><input v-model="form.applicantName" class="w-m" required></label>
      </fieldset>

      <fieldset>
        <legend>収入項目</legend>
        <div class="block-head">
          <span class="block-label">{{ useManual ? '予算にない収入' : '収入の予算から選ぶ' }}<span class="req">*</span></span>
          <button v-if="lines.length" type="button" class="link" @click="manual = !manual">{{ manual ? '予算から選ぶ' : '予算にない収入を手入力する' }}</button>
        </div>
        <template v-if="useManual">
          <p class="hint">{{ lines.length ? '予算にない収入の款・項・目・節と項目番号を書いてください。' : '収入の予算がまだないので、項目を手入力してください。' }}</p>
          <div class="row">
            <BureauField v-model="form.department" all />
            <label><span>担当名<span class="req">*</span></span><input v-model="form.inCharge" placeholder="例：zas" required></label>
          </div>
          <div class="path">
            <label><span>款<span class="req">*</span></span><input v-model="form.budgetPath.kan" required></label>
            <label><span>項</span><input v-model="form.budgetPath.kou"></label>
            <label><span>目</span><input v-model="form.budgetPath.moku"></label>
            <label><span>節</span><input v-model="form.budgetPath.setsu"></label>
          </div>
          <label><span>項目番号<span class="req">*</span></span>
            <span class="hint">局・担当・款を入れると、収入の番号の付け方で候補が入ります（in から始まる番号）。必要なら書き換えてください。</span>
            <input v-model="form.itemNumber" class="w-m" placeholder="in01-01-01" required @input="numberEdited = true">
          </label>
        </template>
        <template v-else>
          <p class="hint">入ってきたお金に当たる明細を、表から選んでください。款・項・目・節の見出しでまとめて選ぶと、明細ごとに金額を入れて、明細ごとに1件ずつ記録します。</p>
          <BudgetPicker v-model="pickedKeys" flow="income" />
        </template>
        <label v-if="useManual || pickedLines.length <= 1"><span>収入項目名<span class="req">*</span></span><input v-model="form.itemName" class="w-m" required @input="nameEdited = true"></label>
        <p v-else class="hint">収入項目名は、明細ごとの名前で記録します。</p>
      </fieldset>

      <fieldset>
        <legend>入金</legend>
        <div v-if="!useManual && pickedLines.length" class="amounts">
          <span>金額<span class="req">*</span><span class="hint">（明細ごと。予算額を入れてあるので、実際に入った金額に直してください）</span></span>
          <ul>
            <li v-for="l in pickedLines" :key="l.key">
              <span class="label"><span class="num">{{ l.itemNumber }}</span>{{ l.label }}</span>
              <YenInput v-model="lineAmounts[l.key]!" :aria-label="`${l.label} の金額`" required />
            </li>
          </ul>
          <p v-if="pickedLines.length > 1" class="total">合計 {{ formatYen(pickedTotal) }}</p>
        </div>
        <div class="inline-row">
          <label v-if="useManual || !pickedLines.length"><span>金額<span class="req">*</span></span><YenInput v-model="form.amount" placeholder="例：50000" required /></label>
          <label><span>入金日<span class="req">*</span></span><input v-model="form.receivedOn" type="date" required></label>
        </div>
        <label><span>相手先</span><span class="hint">協賛企業・購入者など</span><input v-model="form.payer" class="w-m"></label>
        <RadioWithOther v-model="form.method" label="受け取り方" :options="INCOME_METHODS" required />
        <label v-if="form.method === '振込'"><span>受け取った口座<span class="req">*</span></span>
          <span class="hint">出納帳で、この口座に入ったものとして数えます。</span>
          <select v-model="form.account" class="fit" required><option value="" disabled>選択</option><option v-for="a in BANK_ACCOUNTS" :key="a">{{ a }}</option></select>
        </label>
        <label><span>備考</span><textarea v-model="form.remark" rows="3" /></label>
        <label><span>証憑（入金の明細など）</span>
          <span class="hint">PDF・JPEG・PNG、4MBまで。あとから台帳の「収入」で付けることもできます。</span>
          <input type="file" accept=".pdf,image/*" @change="file = ($event.target as HTMLInputElement).files?.[0] ?? null">
        </label>
      </fieldset>

      <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
      <div><button type="submit" :disabled="pending">{{ pending ? '送信中…' : '記録' }}</button></div>
    </form>
  </section>
</template>

<style scoped>
/* 執行依頼のフォームとそろえる */
.intro { border-left: 4px solid var(--accent); padding: .5rem .9rem; font-size: .9rem; background: var(--sub); border-radius: 0 6px 6px 0; }
.intro p { margin: .3rem 0; }
.block-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .5rem; }
.block-label { font-size: .9rem; }
/* 金額と入金日は短い欄なので、左に詰めて横に並べる */
.inline-row { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; align-items: start; }
.path { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .5rem; }
.req { color: var(--danger); margin-left: .15rem; }
/* 明細ごとの金額：名前 | 金額 */
.amounts { display: grid; gap: .4rem; font-size: .9rem; }
.amounts ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .3rem; }
.amounts li { display: grid; grid-template-columns: minmax(0, 1fr) 9rem; gap: .75rem; align-items: center; }
.amounts .label { overflow-wrap: anywhere; }
.amounts .num { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: .4rem; }
.amounts .total { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
label .hint { display: block; }
</style>
