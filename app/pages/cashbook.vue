<script setup lang="ts">
/**
 * 出納帳（財務局長・財務局長補佐・管理者）。口座（SMBC・ゆうちょ・MUFG・現金）ごとに、執行済みの申請（出金）と
 * 確認済みの収入（入金）、手で書いた期首の残高・口座間の移動・調整から帳簿の残高を出す。
 * 通帳や手元の現金で数えた残高を入れると帳簿との差が出て、執行の記録と食い違っていないかを確かめられる（残高の照合）。
 */
import type { CashAccount } from '#shared/constants'
import { CASH_ACCOUNTS, CASHBOOK_KINDS } from '#shared/constants'

const { can } = usePermissions()
if (!can('manageCashbook')) await navigateTo('/')

const { data, refresh } = await useFetch('/api/cashbook')
type Row = NonNullable<typeof data.value>['rows'][number]

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date())
const errors = ref<string[]>([])
const pending = ref(false)
async function run(task: () => Promise<unknown>) {
  errors.value = []
  pending.value = true
  try {
    await task()
    await refresh()
    return true
  }
  catch (error) {
    errors.value = toMessages(error)
    return false
  }
  finally {
    pending.value = false
  }
}

const bookTotal = computed(() => data.value?.accounts.reduce((s, a) => s + a.balance, 0) ?? 0)
const noOpening = computed(() => data.value?.accounts.filter(a => !a.hasOpening).map(a => a.account) ?? [])

/** 残高の照合：数えた残高を口座ごとに入れて、帳簿の残高との差を見る */
const checkDate = ref(today())
const counted = reactive<Record<CashAccount, string>>({ SMBC: '', ゆうちょ: '', MUFG: '', 現金: '' })
/** 照合の日の終わりの帳簿の残高（今日なら今の残高） */
function bookOn(account: CashAccount, date: string) {
  return (data.value?.rows ?? []).filter(r => r.account === account && r.date <= date).reduce((s, r) => s + r.in - r.out, 0)
}
const diffOf = (account: CashAccount) => (/^-?\d+$/.test(counted[account]) ? Number(counted[account]) - bookOn(account, checkDate.value) : null)
const filledAccounts = computed(() => CASH_ACCOUNTS.filter(a => counted[a] !== ''))
async function saveChecks() {
  const ok = await run(async () => {
    for (const account of filledAccounts.value) {
      await $fetch('/api/cashbook/records', { method: 'POST', body: { kind: 'check', date: checkDate.value, account, amount: counted[account] } })
    }
  })
  if (ok) for (const a of CASH_ACCOUNTS) counted[a] = ''
}

/** 期首の残高・口座間の移動・調整の記録 */
const MANUAL_KINDS = ['opening', 'transfer', 'adjust'] as const
const form = reactive({ kind: 'opening' as (typeof MANUAL_KINDS)[number], date: today(), account: '' as CashAccount | '', toAccount: '' as CashAccount | '', amount: '', memo: '' })
async function addRecord() {
  const ok = await run(() => $fetch('/api/cashbook/records', { method: 'POST', body: form }))
  if (ok) Object.assign(form, { amount: '', memo: '', toAccount: '' })
}
function removeRecord(id: number, what: string) {
  if (confirm(`${what}を取り消します。よろしいですか？`)) run(() => $fetch(`/api/cashbook/records/${id}`, { method: 'DELETE' }))
}

/** 出納帳の表：口座で絞り込む */
const tab = ref<CashAccount | ''>('')
const shownRows = computed(() => (data.value?.rows ?? []).filter(r => !tab.value || r.account === tab.value).toReversed())
const SOURCE_LABELS: Record<Row['source'], string> = { execution: '執行', income: '収入', ...CASHBOOK_KINDS, transfer: '移動' }
const signed = (n: number) => (n > 0 ? `+${formatYen(n)}` : formatYen(n))
</script>

<template>
  <section class="page">
    <h1>出納帳</h1>
    <p class="hint">
      執行済みの申請（出金）と確認済みの収入（入金）から、口座ごとの帳簿の残高を出します。
      振込は選んだ口座、発注の口座引落は SMBC、デビットは MUFG、現金執行と立替の返金は現金から出たものとして数えます。
    </p>
    <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>

    <template v-if="data">
      <p v-if="noOpening.length" class="warn">期首の残高が未入力の口座：{{ noOpening.join('・') }}。下の「記録の追加」から入れると、帳簿の残高が実際の残高と比べられるようになります。</p>

      <div class="card">
        <h2>残高の照合</h2>
        <p class="hint">通帳・ネットバンキング・手元の現金で数えた残高を入れると、帳簿の残高との差が出ます。差が0円なら、執行・収入の記録と食い違いはありません。</p>
        <label class="inline"><span>照合の日</span><input v-model="checkDate" type="date"></label>
        <div class="table-wrap">
          <table class="balances">
            <thead>
              <tr><th>口座</th><th class="num">帳簿の残高</th><th class="num">数えた残高</th><th class="num">差（数えた − 帳簿）</th><th>前回の照合</th></tr>
            </thead>
            <tbody>
              <tr v-for="a in data.accounts" :key="a.account">
                <th scope="row">{{ a.account }}</th>
                <td class="num">{{ formatYen(bookOn(a.account, checkDate)) }}</td>
                <td class="num"><YenInput v-model="counted[a.account]" :aria-label="`${a.account}の数えた残高`" /></td>
                <td class="num" :class="{ ng: diffOf(a.account), ok: diffOf(a.account) === 0 }">{{ diffOf(a.account) == null ? '' : diffOf(a.account) === 0 ? '一致' : signed(diffOf(a.account)!) }}</td>
                <td>
                  <template v-if="a.lastCheck">
                    {{ a.lastCheck.date }}
                    <span :class="a.lastCheck.actual === a.lastCheck.book ? 'ok' : 'ng'">{{ a.lastCheck.actual === a.lastCheck.book ? '一致' : `差 ${signed(a.lastCheck.actual - a.lastCheck.book)}` }}</span>
                  </template>
                  <span v-else class="muted">—</span>
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr><th>合計</th><td class="num">{{ formatYen(CASH_ACCOUNTS.reduce((s, a) => s + bookOn(a, checkDate), 0)) }}</td><td colspan="3" /></tr>
            </tfoot>
          </table>
        </div>
        <p class="hint">今の帳簿の残高の合計は {{ formatYen(bookTotal) }}。まだ執行していない執行依頼・立替の返金（{{ data.pendingOut.count }}件・{{ formatYen(data.pendingOut.total) }}）は入っていません。</p>
        <div class="actions">
          <button type="button" :disabled="pending || !filledAccounts.length" @click="saveChecks">照合の記録</button>
          <span class="hint">数えた残高を入れた口座だけ記録します。</span>
        </div>
      </div>

      <div v-if="data.unknown.length" class="card">
        <h2>出納帳に入っていない記録 <span class="muted">{{ data.unknown.length }}件</span></h2>
        <p class="hint">どの口座のお金か決まらない、または金額が分からないので、帳簿の残高に入れていません。必要なら「調整」で口座に入れてください。</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>番号</th><th>日付</th><th>内容</th><th>執行形態・受け取り方</th><th class="num">金額</th><th>理由</th></tr></thead>
            <tbody>
              <tr v-for="u in data.unknown" :key="u.seq">
                <td>{{ u.seq }}</td><td>{{ u.date }}</td><td>{{ u.label }}</td><td>{{ u.method }}</td>
                <td class="num">{{ u.amount == null ? '—' : formatYen(u.amount) }}</td><td>{{ u.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>記録の追加</h2>
        <form class="record-form" @submit.prevent="addRecord">
          <div class="kinds" role="radiogroup" aria-label="記録の種類">
            <label v-for="k in MANUAL_KINDS" :key="k" class="check"><input v-model="form.kind" type="radio" :value="k">{{ CASHBOOK_KINDS[k] }}</label>
          </div>
          <p class="hint">
            <template v-if="form.kind === 'opening'">出納帳を始める日の、その口座の残高。口座ごとに1回入れます。</template>
            <template v-else-if="form.kind === 'transfer'">ATM での引き出し・預け入れ、口座から口座への移動など。合計は変わらず、口座ごとの残高が変わります。</template>
            <template v-else>利息・手数料など、執行にも収入にも当たらない増減。減ったときは負の数（例：-220）で入れます。</template>
          </p>
          <div class="fields">
            <label><span>日付<span class="req">*</span></span><input v-model="form.date" type="date" required></label>
            <label><span>{{ form.kind === 'transfer' ? '移動元' : '口座' }}<span class="req">*</span></span>
              <select v-model="form.account" required><option value="" disabled>選択</option><option v-for="a in CASH_ACCOUNTS" :key="a">{{ a }}</option></select>
            </label>
            <label v-if="form.kind === 'transfer'"><span>移動先<span class="req">*</span></span>
              <select v-model="form.toAccount" required><option value="" disabled>選択</option><option v-for="a in CASH_ACCOUNTS" :key="a" :disabled="a === form.account">{{ a }}</option></select>
            </label>
            <label><span>{{ form.kind === 'opening' ? '残高' : '金額' }}<span class="req">*</span></span>
              <input v-if="form.kind === 'adjust'" v-model="form.amount" type="number" step="1" required>
              <YenInput v-else v-model="form.amount" required />
            </label>
            <label class="memo"><span>{{ form.kind === 'adjust' ? '理由' : 'メモ' }}<span v-if="form.kind === 'adjust'" class="req">*</span></span><input v-model="form.memo" :required="form.kind === 'adjust'"></label>
          </div>
          <div><button type="submit" :disabled="pending">記録</button></div>
        </form>
      </div>

      <h2 class="section">出入りの一覧</h2>
      <nav class="tabs" aria-label="口座で絞り込む">
        <button type="button" :class="{ active: tab === '' }" @click="tab = ''">すべて</button>
        <button v-for="a in data.accounts" :key="a.account" type="button" :class="{ active: tab === a.account }" @click="tab = a.account">{{ a.account }} <small>{{ formatYen(a.balance) }}</small></button>
      </nav>
      <div class="table-wrap">
        <table class="flows">
          <thead>
            <tr><th>日付</th><th>種類</th><th>番号</th><th>内容</th><th>口座</th><th class="num">入金</th><th class="num">出金</th><th class="num">残高（その口座）</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="r in shownRows" :key="r.key">
              <td>{{ r.date }}</td>
              <td><span class="kind" :class="r.source">{{ SOURCE_LABELS[r.source] }}</span></td>
              <td class="muted">{{ r.seq ?? '' }}</td>
              <td>{{ r.label }}</td>
              <td>{{ r.account }}</td>
              <td class="num">{{ r.in ? formatYen(r.in) : '' }}</td>
              <td class="num">{{ r.out ? formatYen(r.out) : '' }}</td>
              <td class="num">{{ formatYen(r.balance) }}</td>
              <td><button v-if="r.recordId" type="button" class="link danger" :disabled="pending" @click="removeRecord(r.recordId, `${SOURCE_LABELS[r.source]}（${r.date}・${r.label}）`)">取り消し</button></td>
            </tr>
            <tr v-if="!shownRows.length"><td colspan="9" class="hint">まだ出入りはありません。</td></tr>
          </tbody>
        </table>
      </div>

      <template v-if="data.checks.length">
        <h2 class="section">照合の履歴</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>日付</th><th>口座</th><th class="num">数えた残高</th><th class="num">帳簿の残高</th><th class="num">差</th><th /></tr></thead>
            <tbody>
              <tr v-for="c in data.checks.toReversed()" :key="c.id">
                <td>{{ c.date }}</td><td>{{ c.account }}</td>
                <td class="num">{{ formatYen(c.actual) }}</td><td class="num">{{ formatYen(c.book) }}</td>
                <td class="num" :class="c.actual === c.book ? 'ok' : 'ng'">{{ c.actual === c.book ? '一致' : signed(c.actual - c.book) }}</td>
                <td><button type="button" class="link danger" :disabled="pending" @click="removeRecord(c.id, `${c.date}の${c.account}の照合`)">取り消し</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="hint">帳簿の残高は今の記録から計算し直すので、あとから執行・収入を直すと照合の差も変わります。</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.card { display: grid; gap: .75rem; margin-bottom: 1rem; }
.card h2, .section { margin: 0; font-size: 1.1rem; }
.section { margin: 1.4rem 0 .6rem; }
.muted { color: var(--muted); font-weight: 400; font-size: .85rem; }
.warn { border: 1px solid var(--danger); border-radius: 6px; padding: .6rem .8rem; color: var(--danger); margin: 0 0 1rem; }
.inline { display: flex; align-items: center; gap: .5rem; }
.inline input { max-width: 13rem; }
.balances th[scope="row"] { color: var(--text); background: none; }
.balances td.num :deep(input) { max-width: 10rem; text-align: right; margin-left: auto; }
.balances tfoot th, .balances tfoot td { border-top: 2px solid var(--border); font-weight: 600; background: var(--sub); color: var(--text); }
.ok { color: var(--done); font-weight: 600; }
.ng { color: var(--danger); font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
.record-form { gap: .75rem; }
.kinds { display: flex; flex-wrap: wrap; gap: 1rem; }
.fields { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; }
.fields label { min-width: 9rem; }
.fields .memo { flex: 1 1 16rem; }
.flows { min-width: 52rem; }
.kind { font-size: .8rem; white-space: nowrap; }
.kind.execution { color: var(--danger); }
.kind.income { color: var(--done); }
.tabs small { color: var(--muted); margin-left: .2rem; }
.danger { color: var(--danger); }
</style>
