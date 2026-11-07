<script setup lang="ts">
/**
 * 帳簿（財務局長・管理者）。複式簿記の試算表・仕訳帳・総勘定元帳。
 * 仕訳は執行済みの申請・確認済みの収入・出納帳の記録から開くたびに作り（現金主義）、手で入れた仕訳を足す。
 * 収入・支出の科目は予算の款、口座は「普通預金（SMBC）」などの資産の科目。
 */
import type { AccountKind } from '#shared/constants'
import { ACCOUNT_KINDS } from '#shared/constants'

const { can } = usePermissions()
if (!can('manageCashbook')) await navigateTo('/')

const { data, refresh } = await useFetch('/api/ledger')
type Journal = NonNullable<typeof data.value>['journals'][number]

const tab = ref<'trial' | 'journal' | 'ledger'>('trial')
const TABS = { trial: '試算表', journal: '仕訳帳', ledger: '総勘定元帳' } as const
const SOURCE_LABELS: Record<Journal['source'], string> = { execution: '執行', income: '収入', opening: '期首の残高', transfer: '移動', adjust: '調整', manual: '手入力' }

const balanced = computed(() => !!data.value && data.value.totals.debit === data.value.totals.credit)
const kindsInUse = computed(() => ACCOUNT_KINDS.filter(k => data.value?.ledger.some(a => a.kind === k)))

/** 総勘定元帳で開く科目（'' はすべて） */
const account = ref('')
const shownAccounts = computed(() => (data.value?.ledger ?? []).filter(a => !account.value || a.account === account.value))
function openAccount(name: string) {
  account.value = name
  tab.value = 'ledger'
}

/** 仕訳帳は新しい順。絞り込み（摘要・科目・番号） */
const query = ref('')
const shownJournals = computed(() => {
  const q = query.value.trim()
  const list = (data.value?.journals ?? []).filter(j => !q || [j.memo, j.seq ?? '', ...j.lines.map(l => l.account)].some(t => t.includes(q)))
  return list.toReversed()
})

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date())
const errors = ref<string[]>([])
const pending = ref(false)
const message = ref('')

/** 手で入れる仕訳 */
type Line = { account: string, kind: AccountKind | '', debit: string, credit: string }
const emptyLine = (): Line => ({ account: '', kind: '', debit: '', credit: '' })
const form = reactive({ date: today(), memo: '', lines: [emptyLine(), emptyLine()] as Line[] })
const knownAccounts = computed(() => data.value?.ledger.map(a => ({ account: a.account, kind: a.kind })) ?? [])
/** 今ある科目名を入れたら、区分を合わせる */
function onAccount(l: Line) {
  const known = knownAccounts.value.find(a => a.account === l.account.trim())
  if (known) l.kind = known.kind
}
const num = (v: string) => (/^\d+$/.test(v) ? Number(v) : 0)
const formDebit = computed(() => form.lines.reduce((s, l) => s + num(l.debit), 0))
const formCredit = computed(() => form.lines.reduce((s, l) => s + num(l.credit), 0))
async function addJournal() {
  errors.value = []
  message.value = ''
  pending.value = true
  try {
    await $fetch('/api/ledger/journals', {
      method: 'POST',
      body: { date: form.date, memo: form.memo, lines: form.lines.filter(l => l.account || l.debit || l.credit).map(l => ({ ...l, debit: l.debit || 0, credit: l.credit || 0 })) },
    })
    Object.assign(form, { memo: '', lines: [emptyLine(), emptyLine()] })
    message.value = '仕訳を入れました。'
    await refresh()
  }
  catch (error) {
    errors.value = toMessages(error)
  }
  finally {
    pending.value = false
  }
}
async function removeJournal(j: Journal) {
  if (!j.manualId || !confirm(`${j.date}「${j.memo}」の仕訳を取り消します。よろしいですか？`)) return
  errors.value = []
  try {
    await $fetch(`/api/ledger/journals/${j.manualId}`, { method: 'DELETE' })
    await refresh()
  }
  catch (error) {
    errors.value = toMessages(error)
  }
}
const yenOrBlank = (n: number) => (n ? formatYen(n) : '')
</script>

<template>
  <section class="page">
    <h1>帳簿</h1>
    <p class="hint">
      執行済みの申請・確認済みの収入・出納帳の記録（期首の残高・口座間の移動・調整）から、お金が動いた日に仕訳します（現金主義）。
      収入・支出の科目は予算の款、口座は「普通預金（SMBC）」などの資産の科目です。口座や金額の決まらない執行・収入は入りません（出納帳の「出納帳に入っていない記録」）。
    </p>
    <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
    <p v-if="message" class="ok">{{ message }}</p>

    <template v-if="data">
      <nav class="tabs" aria-label="帳簿の種類">
        <button v-for="(label, key) in TABS" :key="key" type="button" :class="{ active: tab === key }" @click="tab = key">{{ label }}</button>
      </nav>

      <!-- 試算表 -->
      <template v-if="tab === 'trial'">
        <p :class="balanced ? 'ok' : 'ng'">
          {{ balanced ? '借方の合計と貸方の合計が一致しています。' : '借方の合計と貸方の合計が合っていません。' }}
          （借方 {{ formatYen(data.totals.debit) }} ／ 貸方 {{ formatYen(data.totals.credit) }}）
        </p>
        <div class="table-wrap">
          <table class="trial">
            <thead><tr><th>区分</th><th>勘定科目</th><th class="num">借方</th><th class="num">貸方</th><th class="num">残高</th></tr></thead>
            <template v-for="k in kindsInUse" :key="k">
              <tbody>
                <tr v-for="a in data.ledger.filter(x => x.kind === k)" :key="a.account">
                  <td class="muted">{{ k }}</td>
                  <td><button type="button" class="link" @click="openAccount(a.account)">{{ a.account }}</button></td>
                  <td class="num">{{ formatYen(a.debit) }}</td>
                  <td class="num">{{ formatYen(a.credit) }}</td>
                  <td class="num" :class="{ minus: a.balance < 0 }">{{ formatYen(a.balance) }}</td>
                </tr>
              </tbody>
            </template>
            <tfoot>
              <tr><th colspan="2">合計</th><td class="num">{{ formatYen(data.totals.debit) }}</td><td class="num">{{ formatYen(data.totals.credit) }}</td><td /></tr>
            </tfoot>
          </table>
        </div>
        <p class="hint">残高は、資産・支出は借方−貸方、負債・純資産・収入は貸方−借方です。口座（現金・普通預金）の残高は、手入力の仕訳で口座の科目を使っていなければ、出納帳の帳簿の残高と同じになります。</p>
      </template>

      <!-- 仕訳帳 -->
      <template v-else-if="tab === 'journal'">
        <label class="search">絞り込み<input v-model="query" type="search" placeholder="摘要・科目・番号"></label>
        <div class="table-wrap">
          <table class="journal">
            <thead><tr><th>日付</th><th>種類</th><th>摘要</th><th>借方の科目</th><th class="num">借方</th><th>貸方の科目</th><th class="num">貸方</th><th /></tr></thead>
            <tbody v-for="j in shownJournals" :key="j.key" class="journal-entry">
              <tr v-for="(l, n) in j.lines" :key="n">
                <template v-if="n === 0">
                  <td :rowspan="j.lines.length">{{ j.date }}</td>
                  <td :rowspan="j.lines.length"><span class="kind" :class="j.source">{{ SOURCE_LABELS[j.source] }}</span></td>
                  <td :rowspan="j.lines.length" class="memo">{{ j.memo }}<small v-if="j.seq" class="muted">（{{ j.seq }}）</small></td>
                </template>
                <td>{{ l.debit ? l.account : '' }}</td>
                <td class="num">{{ yenOrBlank(l.debit) }}</td>
                <td>{{ l.credit ? l.account : '' }}</td>
                <td class="num">{{ yenOrBlank(l.credit) }}</td>
                <td v-if="n === 0" :rowspan="j.lines.length">
                  <button v-if="j.manualId" type="button" class="link danger" @click="removeJournal(j)">取り消し</button>
                </td>
              </tr>
            </tbody>
            <tbody v-if="!shownJournals.length"><tr><td colspan="8" class="hint">仕訳はまだありません。</td></tr></tbody>
          </table>
        </div>

        <div class="card manual">
          <h2>仕訳の手入力</h2>
          <p class="hint">執行・収入・出納帳から作れない仕訳（備品の資産計上、預り金、科目の振り替えなど）を入れます。各行は借方か貸方のどちらかに金額を入れ、借方の合計と貸方の合計をそろえてください。</p>
          <form @submit.prevent="addJournal">
            <div class="inline-row">
              <label><span>日付<span class="req">*</span></span><input v-model="form.date" type="date" required></label>
              <label class="memo"><span>摘要<span class="req">*</span></span><input v-model="form.memo" required></label>
            </div>
            <div class="table-wrap">
              <table class="lines">
                <thead><tr><th>勘定科目</th><th>区分</th><th class="num">借方</th><th class="num">貸方</th><th /></tr></thead>
                <tbody>
                  <tr v-for="(l, n) in form.lines" :key="n">
                    <td><input v-model="l.account" list="ledger-accounts" :aria-label="`${n + 1}行目の勘定科目`" @change="onAccount(l)"></td>
                    <td>
                      <select v-model="l.kind" :aria-label="`${n + 1}行目の区分`"><option value="" disabled>選択</option><option v-for="k in ACCOUNT_KINDS" :key="k">{{ k }}</option></select>
                    </td>
                    <td class="num"><YenInput v-model="l.debit" :aria-label="`${n + 1}行目の借方`" /></td>
                    <td class="num"><YenInput v-model="l.credit" :aria-label="`${n + 1}行目の貸方`" /></td>
                    <td><button v-if="form.lines.length > 2" type="button" class="link" @click="form.lines.splice(n, 1)">外す</button></td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td colspan="2"><button type="button" class="link" @click="form.lines.push(emptyLine())">行を足す</button></td>
                    <td class="num">{{ formatYen(formDebit) }}</td>
                    <td class="num">{{ formatYen(formCredit) }}</td>
                    <td :class="formDebit === formCredit ? 'ok' : 'ng'">{{ formDebit === formCredit ? '一致' : '差あり' }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <datalist id="ledger-accounts"><option v-for="a in knownAccounts" :key="a.account" :value="a.account" /></datalist>
            <div><button type="submit" :disabled="pending || !formDebit || formDebit !== formCredit">仕訳の記録</button></div>
          </form>
        </div>
      </template>

      <!-- 総勘定元帳 -->
      <template v-else>
        <label class="search">勘定科目
          <select v-model="account" class="fit">
            <option value="">すべて</option>
            <option v-for="a in data.ledger" :key="a.account" :value="a.account">{{ a.kind }}：{{ a.account }}</option>
          </select>
        </label>
        <section v-for="a in shownAccounts" :key="a.account" class="account">
          <h2>{{ a.account }} <span class="muted">{{ a.kind }}・残高 {{ formatYen(a.balance) }}</span></h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>日付</th><th>摘要</th><th class="num">借方</th><th class="num">貸方</th><th class="num">残高</th></tr></thead>
              <tbody>
                <tr v-for="(r, n) in a.rows" :key="`${r.key}-${n}`">
                  <td>{{ r.date }}</td>
                  <td>{{ r.memo }}<small v-if="r.seq" class="muted">（{{ r.seq }}）</small></td>
                  <td class="num">{{ yenOrBlank(r.debit) }}</td>
                  <td class="num">{{ yenOrBlank(r.credit) }}</td>
                  <td class="num" :class="{ minus: r.balance < 0 }">{{ formatYen(r.balance) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <p v-if="!shownAccounts.length" class="hint">仕訳はまだありません。</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.ok { color: var(--done); font-weight: 600; }
.ng { color: var(--danger); font-weight: 600; }
.minus { color: var(--danger); }
.muted { color: var(--muted); font-weight: 400; font-size: .85rem; }
.search { display: grid; gap: .25rem; max-width: 24rem; margin-bottom: .6rem; }
.trial tfoot th, .trial tfoot td { border-top: 2px solid var(--border); font-weight: 600; background: var(--sub); color: var(--text); }
.journal { min-width: 60rem; }
/* 日付・科目・金額は折り返さない（摘要だけ折り返す） */
.journal td { white-space: nowrap; }
.journal td.memo { white-space: normal; min-width: 16rem; }
.journal-entry + .journal-entry tr:first-child td { border-top: 2px solid var(--border); }
.kind { font-size: .8rem; white-space: nowrap; }
.kind.execution { color: var(--danger); }
.kind.income { color: var(--done); }
.kind.manual { color: #2f6fd6; }
.account { margin: 1.2rem 0; }
.account h2 { font-size: 1.05rem; margin: 0 0 .4rem; }
.manual { margin-top: 1.2rem; display: grid; gap: .6rem; max-width: none; }
.manual h2 { margin: 0; font-size: 1.1rem; }
.inline-row { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; align-items: start; }
.inline-row .memo { flex: 1 1 20rem; }
.lines td { vertical-align: middle; }
.lines td input, .lines td select { min-width: 8rem; }
.lines td.num :deep(input) { text-align: right; max-width: 9rem; margin-left: auto; }
.req { color: var(--danger); margin-left: .15rem; }
.danger { color: var(--danger); }
</style>
