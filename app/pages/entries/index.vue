<script setup lang="ts">
import { TRANSFER_BANKS, VIEWS, type ViewKey } from '#shared/constants'
import { findTransferFeeLine } from '#shared/cashbook'
import { extractLinks, splitByLinks } from '#shared/links'
import { shortenItemNumbers } from '#shared/itemNumbers'
import { SHIPPING_RULES, shippingAdvice } from '#shared/shipping'

const { can, entriesTitle } = usePermissions()
const { public: { bankLinkSmbc, bankLinkYucho } } = useRuntimeConfig()
/** 振込で使う口座 → その銀行のサイト（NUXT_PUBLIC_BANK_LINK_SMBC / _YUCHO で変えられる） */
const bankLinks: Record<(typeof TRANSFER_BANKS)[number], string> = { SMBC: bankLinkSmbc, ゆうちょ: bankLinkYucho }
const route = useRoute()
const router = useRouter()

/** 支出（執行依頼）と収入のどちらを見るか。収入の一覧は IncomeLedger */
const flow = computed<'expense' | 'income'>({
  get: () => (route.query.flow === 'income' ? 'income' : 'expense'),
  set: v => router.replace({ query: v === 'income' ? { flow: 'income' } : {} }),
})

const view = computed<ViewKey>({
  get: () => (String(route.query.view ?? 'deadline') in VIEWS ? route.query.view : 'deadline') as ViewKey,
  set: v => router.replace({ query: { view: v } }),
})
const { data: entries, refresh } = await useFetch('/api/entries', { query: { view } })

/** 未対応の発注をサイトごとにまとめ、送料無料の基準に届くかを出す（送料の決まりがあるサイトだけ） */
const orderSummary = computed(() => {
  const bySite = new Map<string, { count: number, total: number }>()
  for (const r of entries.value ?? []) {
    if (r.type !== '発注' || r.status !== 'pending' || !SHIPPING_RULES[siteOf(r)]) continue
    const s = bySite.get(siteOf(r)) ?? { count: 0, total: 0 }
    s.count++
    s.total += orderAmountOf(r)
    bySite.set(siteOf(r), s)
  }
  return [...bySite].map(([site, s]) => ({ site, ...s, freeFrom: SHIPPING_RULES[site]!.freeFrom }))
})

const opened = ref<number>()
const exec = reactive({ bank: 'SMBC' as (typeof TRANSFER_BANKS)[number], amount: '', quantity: '', transferFee: '' })

/** 振込手数料は必ず財務局（ZAI）の「振込手数料」の明細に入れる（サーバーで決める。ここでは表示だけ） */
const { data: expenseLines } = useBudgetLines()
const feeLine = computed(() => findTransferFeeLine(expenseLines.value ?? []))
const feeLineText = (key: unknown) => { const l = (expenseLines.value ?? []).find(x => x.key === key); return l ? `${l.itemNumber} ${l.label}` : '' }
const execErrors = ref<string[]>([])

type Row = NonNullable<typeof entries.value>[number]

/** 証憑が出ているか（台帳から付けた証憑） */
const hasEvidence = (row: Row) => row.evidences.length > 0
/**
 * 状態：執行待ち（ZAI の対応前）→ 証憑提出待ち（ZAI が執行した、証憑はまだ）→ 証憑確認待ち（証憑が出た）→ 完了（財務局長・管理者が証憑を確認した）。
 * 証憑が先に出ていても、ZAI が対応するまでは「執行待ち」（立替の返金待ちなど）。
 * 差し戻すと「証憑差し戻し」になり、証憑を付け直すとまた確認待ちになる。
 */
const STAGE_LABELS = { pending: '執行待ち', done: '証憑提出待ち', returned: '証憑差し戻し', checking: '証憑確認待ち', complete: '完了' } as const
function stageOf(row: Row): keyof typeof STAGE_LABELS {
  if (row.status !== 'done') return 'pending'
  if (row.evidenceCheckedAt) return 'complete'
  if (row.evidenceReturnComment) return 'returned'
  return hasEvidence(row) ? 'checking' : 'done'
}
const evidenceStatus = (row: Row) => (row.evidences.length ? `${row.evidences.length}件` : '未提出')

/** 形態の列。発注は通販サイトも出して、詳細を開かなくても分かるようにする */
function methodLabel(row: Row) {
  if (row.type !== '発注' || !siteOf(row)) return row.paymentMethod ?? row.type
  return `発注（${siteOf(row)}）${row.paymentMethod ? ` / ${row.paymentMethod}` : ''}`
}

/** 「発注」で見ているときの通販サイトの絞り込み（'' はすべて） */
// URL（?site=）に持たせて、未対応の発注のまとめからそのサイトへ飛べるようにする。形態を切り替えると外れる
const siteFilter = computed({
  get: () => String(route.query.site ?? ''),
  set: v => router.replace({ query: { view: '発注', ...(v ? { site: v } : {}) } }),
})
/** まとめて発注の欄に出す、絞り込んだサイトの未対応の発注 */
const batchRows = computed(() => (view.value === '発注' && siteFilter.value
  ? shownEntries.value.filter(r => r.status === 'pending')
  : []))
const orderSites = computed(() => [...new Set((entries.value ?? []).filter(r => r.type === '発注').map(r => siteOf(r) || '（未記入）'))])
/** そのサイトの未対応の発注の件数（絞り込みボタンの横に出す） */
const pendingCount = (site: string) => (entries.value ?? [])
  .filter(r => r.type === '発注' && r.status === 'pending' && (siteOf(r) || '（未記入）') === site).length
const shownEntries = computed(() => (entries.value ?? []).filter(r =>
  view.value !== '発注' || !siteFilter.value || (siteOf(r) || '（未記入）') === siteFilter.value))

const DETAIL_LABELS: Record<string, string> = {
  budgetChange: '予算からの変更',
  budgetCommitteeApproved: '役員会の承認',
  preExecution: '予算前執行',
  preExecutionReason: '予算前執行が必要な理由',
  site: '通販サイト',
  url: '商品ページのリンク',
  deliveryPlace: '配達場所',
  purchase: '購入先',
  paperReceipt: '紙の領収証',
  details: '詳細',
  otherMethod: '執行形態（その他）',
  kindOfEvidence: '証憑の種類',
  refundTiming: '返金時期',
  bankName: '金融機関名',
  branchName: '支店名',
  accountType: '口座種別',
  accountNumber: '口座番号',
  accountName: '口座名義',
  transferFee: '振込手数料',
  transferFeeLine: '振込手数料の予算明細',
}

function detailRows(row: Row) {
  const { bank, preExecutionItemId: _item, preExecutionSettled: _settled, transferFeeLineKey: feeKey, ...rest } = row.details as Record<string, unknown>
  if (rest.transferFee) rest.transferFeeLine = feeLineText(feeKey) || '（予算にない項目）'
  return Object.entries({ ...rest, ...(bank as object | undefined) })
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => ({ label: DETAIL_LABELS[k] ?? k, value: v === true ? (k === 'preExecution' ? 'はい' : '承認済み') : k === 'transferFee' ? formatYen(Number(v)) : String(v), isUrl: k === 'url' }))
}

/** 一覧の行からそのまま開く商品のリンク（依頼に書いたものと、選んだ予算明細のもの） */
function rowLinks(row: Row) {
  const url = (row.details as { url?: unknown }).url
  return extractLinks([typeof url === 'string' ? url : '', ...row.items.map(i => i.link)].join('\n'))
}

const yen = (n: number | null) => (n == null ? '' : `${n.toLocaleString('ja-JP')}円`)
const dateTime = (s: string | Date | null) => (s ? new Date(s).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '')

/** 明細ごとの執行額・数量・取引先の編集中の値（entry_items の id → 入力値） */
const itemDrafts = reactive<Record<number, string>>({})
const quantityDrafts = reactive<Record<number, string>>({})
const vendorDrafts = reactive<Record<number, string>>({})

type Item = Row['items'][number]
/** 実際の数量・取引先（入力がなければ予算の値） */
const quantityOf = (i: Item) => i.actualQuantity ?? i.quantity
const vendorOf = (i: Item) => i.actualVendor ?? i.vendor

function resetDrafts(items: Item[]) {
  for (const i of items) {
    itemDrafts[i.id] = i.actualAmount == null ? '' : String(i.actualAmount)
    quantityDrafts[i.id] = quantityOf(i)
    vendorDrafts[i.id] = vendorOf(i)
  }
}
const itemsSaved = ref(false)

function toggle(row: Row) {
  opened.value = opened.value === row.id ? undefined : row.id
  exec.amount = row.amount ? String(row.amount) : ''
  exec.quantity = row.quantity ?? ''
  exec.transferFee = ''
  execErrors.value = []
  itemsSaved.value = false
  resetDrafts(row.items)
}

const itemsChanged = (row: Row) =>
  row.items.some(i => (itemDrafts[i.id] ?? '') !== (i.actualAmount == null ? '' : String(i.actualAmount))
    || (quantityDrafts[i.id] ?? '') !== quantityOf(i)
    || (vendorDrafts[i.id] ?? '') !== vendorOf(i))

const itemsActualTotal = (row: Row) => row.items.reduce((s, i) => s + (i.actualAmount ?? 0), 0)

function diff(budget: number, actual: number | null) {
  if (actual == null || actual === budget) return ''
  const d = actual - budget
  return `${d > 0 ? '+' : '-'}¥${Math.abs(d).toLocaleString('ja-JP')}`
}

/** 数字として読めない執行額の入力 */
const invalidItem = (id: number) => parseYenInput(itemDrafts[id] ?? '') === null

/** 明細ごとの執行額・数量・取引先を保存する。読めない執行額があれば保存せず false */
async function saveItems(row: Row) {
  if (row.items.some(i => invalidItem(i.id))) {
    execErrors.value = ['執行額は数字で入力してください。']
    return false
  }
  const amounts = Object.fromEntries(row.items.map((i) => {
    const n = parseYenInput(itemDrafts[i.id] ?? '')
    return [i.id, n === '' ? null : n]
  }))
  // 数量・取引先は、予算と同じなら「入力なし」として保存する
  const quantities = Object.fromEntries(row.items.map(i => [i.id, (quantityDrafts[i.id] ?? '').trim() === i.quantity ? null : (quantityDrafts[i.id] ?? '').trim()]))
  const vendors = Object.fromEntries(row.items.map(i => [i.id, (vendorDrafts[i.id] ?? '').trim() === i.vendor ? null : (vendorDrafts[i.id] ?? '').trim()]))
  await $fetch(`/api/entries/${row.id}/items`, { method: 'PATCH', body: { amounts, quantities, vendors } })
  return true
}

async function onSaveItems(row: Row) {
  execErrors.value = []
  itemsSaved.value = false
  try {
    if (!await saveItems(row)) return
    await refresh()
    // 入力欄を保存された値（半角の数字）の表示にそろえる
    resetDrafts(entries.value?.find(e => e.id === row.id)?.items ?? [])
    itemsSaved.value = true
  }
  catch (error) {
    execErrors.value = toMessages(error)
  }
}

async function setDone(row: Row, done: boolean) {
  execErrors.value = []
  try {
    // 対応済みにするときは、直した執行額も一緒に保存する（申請の金額は明細の合計になる）
    if (done && itemsChanged(row) && !await saveItems(row)) return
    await $fetch(`/api/entries/${row.id}/execute`, {
      method: 'POST',
      body: {
        done,
        bank: row.type === '振込' ? exec.bank : undefined,
        transferFee: done && row.type === '振込' && exec.transferFee !== '' ? exec.transferFee : undefined,        amount: !row.items.length && exec.amount ? Number(exec.amount) : undefined,
        quantity: exec.quantity || undefined,
      },
    })
    await refresh()
  }
  catch (error) {
    execErrors.value = toMessages(error)
  }
}
</script>

<template>
  <section>
    <div class="page-head">
      <h1>{{ entriesTitle }}</h1>
      <SettlementExport v-if="can('exportSettlement')" />
    </div>

    <div class="flow-bar">
      <nav class="flow-tabs" aria-label="支出と収入の切り替え">
        <button type="button" :class="{ active: flow === 'expense' }" @click="flow = 'expense'">支出</button>
        <button type="button" :class="{ active: flow === 'income' }" @click="flow = 'income'">収入</button>
      </nav>
      <NuxtLink v-if="flow === 'income'" class="button secondary" to="/incomes/new">収入の記録</NuxtLink>
      <NuxtLink v-else class="button secondary" to="/requests/new">執行依頼</NuxtLink>
    </div>

    <IncomeLedger v-if="flow === 'income'" />
    <template v-else>
      <nav class="tabs">
        <button
          v-for="(label, key) in VIEWS"
          :key="key"
          :class="{ active: view === key }"
          @click="view = key"
        >
          {{ label }}
        </button>
      </nav>

      <nav v-if="view === '発注' && orderSites.length" class="tabs site-tabs" aria-label="通販サイトで絞り込む">
        <span class="site-tabs-label">通販サイト：</span>
        <button :class="{ active: siteFilter === '' }" @click="siteFilter = ''">すべて</button>
        <button v-for="s in orderSites" :key="s" :class="{ active: siteFilter === s }" @click="siteFilter = s">
          {{ s }}
          <small v-if="pendingCount(s)" :title="`未対応 ${pendingCount(s)}件`">{{ pendingCount(s) }}</small>
        </button>
      </nav>

      <OrderBatch
        v-if="batchRows.length && can('executeEntries')"
        :site="siteFilter"
        :rows="batchRows"
        @done="refresh"
      />
      <p v-else-if="view === '発注' && !siteFilter && orderSummary.length && can('executeEntries')" class="hint">
        通販サイトを選ぶと、そのサイトの未対応の発注をまとめて対応済みにできます。
      </p>

      <section v-if="orderSummary.length" class="order-summary" aria-label="未対応の発注（サイト別）">
        <strong>未対応の発注（サイト別）</strong>
        <ul>
          <li v-for="s in orderSummary" :key="s.site">
            <NuxtLink :to="{ query: { view: '発注', site: s.site } }">{{ s.site }}</NuxtLink>：{{ s.count }}件・合計{{ yen(s.total) }}
            <span v-if="s.freeFrom == null" class="muted">（送料無料の基準なし。まとめて発注すると送料1回分）</span>
            <span v-else-if="s.total >= s.freeFrom" class="ok">まとめれば送料無料（基準 {{ yen(s.freeFrom) }}）</span>
            <span v-else class="short">送料無料まであと{{ yen(s.freeFrom - s.total) }}（基準 {{ yen(s.freeFrom) }}）</span>
          </li>
        </ul>
      </section>

      <p v-if="!shownEntries.length" class="empty">該当する申請はありません。</p>

      <div v-else class="table-wrap ledger-wrap">
        <table class="ledger">
          <thead>
            <tr>
              <th>番号</th><th>申請日</th><th>項目番号</th><th>支出項目</th><th>数量</th>
              <th>金額</th><th>形態</th><th>期限・予定日</th><th>申請者</th><th>状態</th><th>証憑</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in shownEntries" :key="row.id">
              <tr class="clickable" :class="{ done: row.status === 'done' }" @click="toggle(row)">
                <td class="c-seq">{{ row.seq }}</td>
                <td class="c-date">{{ dateTime(row.createdAt) }}</td>
                <td data-label="項目番号">{{ shortenItemNumbers(row.itemNumber) }}</td>
                <td class="c-name">
                  {{ row.itemName }}
                  <span v-if="rowLinks(row).length" class="row-links">
                    <a v-for="(u, n) in rowLinks(row)" :key="u" :href="u" target="_blank" rel="noopener noreferrer" @click.stop>商品ページ{{ rowLinks(row).length > 1 ? n + 1 : '' }}</a>
                  </span>
                </td>
                <td data-label="数量">{{ row.quantity }}</td>
                <td class="num c-amount">{{ yen(row.amount) }}</td>
                <td data-label="形態">{{ methodLabel(row) }}</td>
                <td data-label="期限・予定日">{{ row.deadline }}</td>
                <td data-label="申請者">{{ row.applicantName }}<small>（{{ row.department }}/{{ row.inCharge }}）</small></td>
                <td class="c-status">
                  <span class="badge" :class="stageOf(row)">{{ STAGE_LABELS[stageOf(row)] }}</span>
                  <small v-if="row.status === 'done'" class="executed-at">{{ dateTime(row.executedAt) }}</small>
                </td>
                <td data-label="証憑" :class="{ 'no-evidence': !hasEvidence(row) }">{{ evidenceStatus(row) }}</td>
              </tr>
              <tr v-if="opened === row.id" class="detail">
                <td colspan="11">
                  <EvidenceCheck :entry="row" :has-evidence="hasEvidence(row)" @changed="refresh" />
                  <EvidenceSection :entry="row" @changed="refresh" />
                  <ShippingNotice
                    v-if="row.type === '発注' && row.status === 'pending'"
                    class="shipping-in-row"
                    :advice="shippingAdvice(siteOf(row), orderAmountOf(row), pendingOrdersOf(entries, siteOf(row), row.id))"
                    :site="siteOf(row)"
                  />
                  <div v-if="row.items.length" class="items">
                    <strong>予算明細（{{ row.items.length }}件）</strong>
                    <table class="items-table">
                      <thead>
                        <tr><th>項目番号</th><th>明細</th><th>数量</th><th>取引先</th><th class="num">予算額</th><th class="num">執行額</th><th class="num">予算比</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="i in row.items" :key="i.id">
                          <td class="muted">{{ i.itemNumber }}</td>
                          <td>{{ i.label }}</td>
                          <td>
                            <input v-if="can('executeEntries')" v-model="quantityDrafts[i.id]" class="text-input" autocomplete="off" :aria-label="`${i.label} の数量`">
                            <template v-else>{{ quantityOf(i) }}</template>
                            <small v-if="quantityOf(i) !== i.quantity" class="muted was">予算: {{ i.quantity || 'なし' }}</small>
                          </td>
                          <td>
                            <input v-if="can('executeEntries')" v-model="vendorDrafts[i.id]" class="text-input" autocomplete="off" :aria-label="`${i.label} の取引先`">
                            <template v-else>{{ vendorOf(i) }}</template>
                            <small v-if="vendorOf(i) !== i.vendor" class="muted was">予算: {{ i.vendor || 'なし' }}</small>
                          </td>
                          <td class="num">{{ formatYen(i.budgetAmount) }}</td>
                          <td class="num">
                            <input
                              v-if="can('executeEntries')"
                              v-model="itemDrafts[i.id]"
                              type="text"
                              inputmode="numeric"
                              autocomplete="off"
                              placeholder="未入力"
                              :class="{ invalid: invalidItem(i.id) }"
                              :aria-invalid="invalidItem(i.id) || undefined"
                              :aria-label="`${i.label} の執行額`"
                            >
                            <template v-else>{{ i.actualAmount == null ? '未入力' : formatYen(i.actualAmount) }}</template>
                          </td>
                          <td class="num muted">{{ diff(i.budgetAmount, i.actualAmount) }}</td>
                        </tr>
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colspan="4">合計</td>
                          <td class="num">{{ formatYen(row.items.reduce((s, i) => s + i.budgetAmount, 0)) }}</td>
                          <td class="num">{{ formatYen(itemsActualTotal(row)) }}</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                    <p v-if="can('executeEntries')" class="items-actions">
                      <button type="button" class="secondary" :disabled="!itemsChanged(row)" @click="onSaveItems(row)">数量・取引先・執行額を保存</button>
                      <span v-if="itemsSaved" class="ok">保存しました（申請の金額も明細の合計にそろえました）。</span>
                    </p>
                  </div>
                  <dl>
                    <template v-for="d in detailRows(row)" :key="d.label">
                      <dt>{{ d.label }}</dt>
                      <dd>
                        <template v-if="d.isUrl">
                          <span class="url-text"><template v-for="(p, n) in splitByLinks(d.value)" :key="n"><a v-if="p.isLink" :href="p.text" target="_blank" rel="noopener noreferrer">{{ p.text }}</a><template v-else>{{ p.text }}</template></template></span>
                        </template>
                        <template v-else>{{ d.value }}</template>
                      </dd>
                    </template>
                    <template v-if="row.remark"><dt>備考</dt><dd>{{ row.remark }}</dd></template>
                    <template v-if="row.attachmentId">
                      <dt>請求書</dt>
                      <dd><a :href="`/api/entries/${row.id}/attachment`" target="_blank">ファイルを開く</a></dd>
                    </template>
                  </dl>

                  <div v-if="can('executeEntries')" class="exec">
                    <template v-if="row.status === 'pending'">
                      <div v-if="row.type === '振込'" class="bank-pick">
                        <label>使用口座
                          <select v-model="exec.bank"><option v-for="b in TRANSFER_BANKS" :key="b">{{ b }}</option></select>
                        </label>
                        <a :href="bankLinks[exec.bank]" target="_blank" rel="noopener" class="bank-link">{{ exec.bank }}のサイトを開く ↗</a>
                      </div>
                      <div v-if="row.type === '振込'" class="fee-pick">
                        <label><span class="nowrap">振込手数料（円）<span class="req">*</span></span>
                          <YenInput v-model="exec.transferFee" class="fee-amount" required />
                        </label>
                        <p v-if="feeLine" class="hint fee-line">手数料は {{ feeLine.itemNumber }} {{ feeLine.label }}（財務局）に入れます。</p>
                        <p v-else class="error fee-line">財務局（ZAI）の予算に「振込手数料」の明細がありません。手数料が0円でなければ執行できません。</p>
                      </div>
                      <template v-if="row.type === '発注' && !row.items.length">
                        <label>確定金額（円）<YenInput v-model="exec.amount" /></label>
                        <label>数量<input v-model="exec.quantity"></label>
                      </template>
                      <button @click="setDone(row, true)">対応済みにする</button>
                    </template>
                    <button v-else class="secondary" @click="setDone(row, false)">未対応に戻す</button>
                    <ul v-if="execErrors.length" class="error"><li v-for="e in execErrors" :key="e">{{ e }}</li></ul>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* 支出・収入の切り替え（表示の切り替えより一段上なので、つなげた大きめのボタンにする） */
/* 切り替えの右に、その種類の新しい記録を出す画面へのボタン */
.flow-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .8rem; margin-bottom: .8rem; }
.flow-tabs { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.flow-tabs button { background: var(--surface); color: var(--text); border: none; border-radius: 0; padding: .4rem 1.4rem; font-weight: 600; }
.flow-tabs button + button { border-left: 1px solid var(--border); }
.flow-tabs button.active { background: var(--accent-bg); color: var(--accent-text); }
.page-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: .75rem; margin-bottom: 1rem; }
.page-head h1 { margin: 0; }
.items-table { width: auto; min-width: 32rem; margin: .4rem 0; background: var(--surface); }
.items-table th, .items-table td { padding: .25rem .5rem; }
.items-table input { width: 8rem; padding: .15rem .35rem; text-align: right; font-variant-numeric: tabular-nums; }
.items-table input.invalid { border-color: var(--danger); }
.items-table input.text-input { width: 7rem; text-align: left; }
.items-table .was { display: block; font-size: .72rem; }
.items-table tfoot td { font-weight: 600; border-bottom: none; }
.items-actions { display: flex; align-items: center; gap: .75rem; margin: 0 0 .75rem; }
.ok { color: var(--done); font-size: .85rem; }
.bank-pick { display: flex; flex-wrap: wrap; align-items: end; gap: .6rem; }
.req { color: var(--danger); margin-left: .15rem; }
/* 振込手数料：金額と、当てる予算明細を口座の下に並べる */
.fee-pick { display: flex; flex-wrap: wrap; align-items: end; gap: .6rem; margin-top: .5rem; }
.fee-amount { width: 8rem; }
.fee-line { max-width: min(24rem, 100%); margin: 0 0 .4rem; font-size: .85rem; }
.nowrap { white-space: nowrap; }
.bank-link { white-space: nowrap; padding-bottom: .5rem; }
.row-links { display: flex; flex-wrap: wrap; gap: .1rem .6rem; font-size: .82rem; font-weight: normal; }
.row-links a { white-space: nowrap; }
.url-text { white-space: pre-line; overflow-wrap: anywhere; }
td.no-evidence { color: var(--danger); font-weight: 600; }
.site-tabs { align-items: center; margin-top: -.4rem; }
.site-tabs-label { font-size: .85rem; color: var(--muted); }
.site-tabs button { font-size: .85rem; padding: .2rem .7rem; }
.site-tabs small { color: var(--muted); margin-left: .2rem; }
.order-summary { margin: 0 0 1rem; padding: .6rem .9rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; font-size: .88rem; }
.order-summary ul { margin: .25rem 0 0; padding-left: 1.2rem; }
.order-summary .short { color: #9a6b00; font-weight: 600; }
.shipping-in-row { margin-bottom: .75rem; }

/* スマホ: 台帳の1行を1枚のカードにして縦に並べる（中の明細の表は横スクロール） */
@media (max-width: 600px) {
  .ledger-wrap { background: none; border: none; overflow: visible; }
  .ledger, .ledger > tbody { display: block; }
  .ledger > thead { display: none; }
  .ledger > tbody > tr.clickable {
    display: grid; grid-template-columns: auto 1fr auto; gap: .15rem .6rem; padding: .7rem .8rem;
    margin-bottom: .6rem; background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  }
  .ledger > tbody > tr.clickable > td { padding: 0; border: none; }
  .ledger .c-status { order: 1; }
  .ledger .c-name { order: 2; }
  .ledger .c-amount { order: 3; }
  .ledger > tbody > tr.clickable > td[data-label] { order: 4; grid-column: 1 / -1; font-size: .82rem; color: var(--muted); }
  .ledger > tbody > tr.clickable > td[data-label]::before { content: attr(data-label) "："; }
  .ledger > tbody > tr.clickable > td[data-label]:empty { display: none; }
  .ledger .c-seq { font-weight: 700; }
  .ledger .c-date { color: var(--muted); font-size: .82rem; align-self: center; }
  .ledger .c-status { text-align: right; }
  .ledger .c-name { grid-column: 1 / 3; font-weight: 600; margin-top: .2rem; }
  .ledger .c-amount { align-self: end; font-weight: 700; }
  .ledger > tbody > tr.detail { display: block; margin: -.7rem 0 .6rem; }
  .ledger > tbody > tr.detail > td {
    display: block; overflow-x: auto; border: 1px solid var(--border); border-top: none; border-radius: 0 0 10px 10px;
  }
  .exec label { width: 100%; }
}
</style>
