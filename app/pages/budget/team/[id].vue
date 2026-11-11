<script setup lang="ts">
/**
 * 担当の予算の明細。その担当の人（と財務管理部）は、明細を直す・足す・消すことができ、終わったら提出する。
 * 担当の人が直せるのは、集約中は査定待ち以外、査定中は要修正の明細だけ。集約終了のあとは直せない（財務管理部は確定までいつでも）。
 * 本予算は空から作り、「昨年の本予算・決算（参考）」（財務管理部が取り込んだもの）から明細をコピーできる（1件・款ごと・すべて）。
 * 補正予算で写してきた明細を消すと「削除」の印が付き、査定で承認されると確定したときに予算から消える。
 * ほかの人は見るだけ。
 */
import type { BudgetItemInput } from '#shared/schemas'
import { BUDGET_FLOWS, FLOW_LABELS, type BudgetFlow } from '#shared/budgetCompile'

const route = useRoute()
const teamId = Number(route.params.id)
const { data: view, refresh } = await useBudgetRound()

const team = computed(() => view.value?.teams.find(t => t.id === teamId))
const { can } = usePermissions()
const reviewer = computed(() => can('reviewBudget'))
const phase = computed(() => view.value?.round.status ?? 'confirmed')
const open = computed(() => phase.value !== 'confirmed')
const editable = computed(() => open.value && !!view.value?.editableTeamIds.includes(teamId))
/** 明細を足せるか（担当の人は集約中だけ） */
const canAdd = computed(() => editable.value && (reviewer.value || phase.value === 'collecting'))
const items = computed(() => view.value?.items.filter(i => i.teamId === teamId) ?? [])
const summary = computed(() => teamSummary(items.value))
/** この担当の予算前執行（担当名の合わないものは、同じ局の担当の画面に出す） */
const preExecutions = computed(() => (view.value?.preExecutions ?? []).filter(p => p.teamId === teamId || (p.teamId == null && p.bureau === team.value?.bureau)))
const preNotAdded = computed(() => preExecutions.value.filter(p => !p.itemNumber).length)
/** 収入・支出ごとに、款でまとめる（並びは予算の表の順。収入が先） */
const kans = computed(() => {
  const groups = new Map<string, BudgetItemView[]>()
  for (const i of items.value) groups.set(`${i.flow}|${i.kan}`, [...(groups.get(`${i.flow}|${i.kan}`) ?? []), i])
  return [...groups].map(([key, list]) => ({ key, flow: list[0]!.flow, kan: list[0]!.kan, list, total: list.filter(i => !i.deleted).reduce((s, i) => s + i.amount, 0) }))
})
const sections = computed(() => BUDGET_FLOWS
  .map(flow => ({ flow, kans: kans.value.filter(k => k.flow === flow) }))
  .filter(s => s.kans.length)
  .map(s => ({ ...s, total: s.kans.reduce((sum, k) => sum + k.total, 0) })))
const kansByFlow = computed(() => Object.fromEntries(BUDGET_FLOWS.map(f => [f, kans.value.filter(k => k.flow === f).map(k => k.kan).filter(Boolean)])) as Record<BudgetFlow, string[]>)
/** 折りたたんだ款（見出しを押すと開け閉めできる） */
const folded = reactive(new Set<string>())
const toggle = (kan: string) => (folded.has(kan) ? folded.delete(kan) : folded.add(kan))

/** 昨年の本予算・決算（財務管理部が取り込んだもの。本予算の集約のときの参考。1件・款ごと・すべてをコピーできる） */
const { data: reference, refresh: refreshReference } = await useFetch(`/api/budget/teams/${teamId}/reference`)
type RefItem = NonNullable<NonNullable<typeof reference.value>>['items'][number]
const refFile = (kind: 'budget' | 'settlement' | 'incomeBudget' | 'incomeSettlement') => reference.value?.files.find(f => f.kind === kind)
/** 収入・支出ごとに、款でまとめる。予算外の決算はそれぞれの最後に1つにまとめる */
const refKans = computed(() => {
  const groups = new Map<string, RefItem[]>()
  for (const i of reference.value?.items ?? []) {
    const key = `${i.flow}|${i.outside ? '\u0000' : i.kan}`
    groups.set(key, [...(groups.get(key) ?? []), i])
  }
  return [...groups].map(([key, list]) => ({
    key,
    flow: list[0]!.flow,
    kan: list[0]!.outside ? '予算外の決算' : list[0]!.kan,
    list,
    budget: list.reduce((s, i) => s + (i.budget ?? 0), 0),
    actual: list.reduce((s, i) => s + (i.actual ?? 0), 0),
  }))
})
/** 昨年の参考の合計（収入・支出それぞれ） */
const refTotalOf = (flow: BudgetFlow) => refKans.value.filter(k => k.flow === flow).reduce((s, k) => ({ budget: s.budget + k.budget, actual: s.actual + k.actual }), { budget: 0, actual: 0 })
const refTotal = computed(() => refTotalOf('expense'))
const refIncomeTotal = computed(() => refTotalOf('income'))
const refSections = computed(() => BUDGET_FLOWS.map(flow => ({ flow, kans: refKans.value.filter(k => k.flow === flow) })).filter(s => s.kans.length))
const notCopied = (list: RefItem[]) => list.filter(i => !i.copied).map(i => i.id)
/** 収入・支出それぞれの、まだコピーしていない参考の明細 */
const notCopiedOf = (sec: (typeof refSections.value)[number]) => notCopied(sec.kans.flatMap(k => k.list))
/** はじめは、まだ明細がないときだけ開いておく */
const refOpen = ref(items.value.length === 0)
const copy = (ids: number[]) => run(() => $fetch(`/api/budget/teams/${teamId}/copy`, { method: 'POST', body: { ids } }), `${ids.length}件コピーしました。内容を確認してから提出してください。`)
const canChange = (i: BudgetItemView) => editable.value && !i.locked && (reviewer.value
  || (phase.value === 'collecting' && i.status !== 'submitted')
  || (phase.value === 'reviewing' && (i.status === 'returned' || i.status === 'draft')))
/** 提出できる件数（未提出・要修正。集約終了の間は0） */
const toSubmit = computed(() => (phase.value === 'closed' ? 0 : summary.value.draft + summary.value.returned))

const editing = ref<string | 'new' | null>(null)
/** ⑤のやり取りを開いている項目 */
const historyOpen = reactive(new Set<string>())
const toggleHistory = (id: string) => (historyOpen.has(id) ? historyOpen.delete(id) : historyOpen.add(id))
const newKan = ref('')
const newFlow = ref<BudgetFlow>('expense')
type PreExecution = NonNullable<typeof view.value>['preExecutions'][number]
/** 予算前執行から足すときの、その予算前執行 */
const newPre = ref<PreExecution | null>(null)
const pending = ref(false)
const errors = ref<string[]>([])
const message = ref('')

async function run(task: () => Promise<unknown>, done = '') {
  pending.value = true
  errors.value = []
  message.value = ''
  try {
    await task()
    editing.value = null
    message.value = done
    await Promise.all([refresh(), reference.value && refreshReference()])
  }
  catch (error) {
    errors.value = toMessages(error)
  }
  finally {
    pending.value = false
  }
}
const save = (value: BudgetItemInput) => run(() => editing.value === 'new'
  ? $fetch(`/api/budget/teams/${teamId}/items`, { method: 'POST', body: { ...value, preExecutionId: newPre.value?.id } })
  : $fetch(`/api/budget/items/${editing.value}`, { method: 'PATCH', body: value }), '保存しました。提出するまで査定には回りません。')
function remove(i: BudgetItemView) {
  const text = i.baseItemId == null || view.value?.round.kind === '本予算' ? 'この明細を消します。' : 'この明細に「削除」の印を付けます（査定で承認されると、確定したときに予算から消えます）。'
  if (confirm(`${itemName(i)}\n${text}よろしいですか？`)) run(() => $fetch(`/api/budget/items/${i.id}`, { method: 'DELETE' }))
}
const restore = (i: BudgetItemView) => run(() => $fetch(`/api/budget/items/${i.id}/restore`, { method: 'POST' }))
function submit() {
  if (confirm(`未提出・要修正の明細${toSubmit.value}件を提出します。提出すると、査定が終わるまで直せません。よろしいですか？`)) {
    run(() => $fetch(`/api/budget/teams/${teamId}/submit`, { method: 'POST' }), '提出しました。財務管理部の査定を待ってください。')
  }
}
function addTo(flow: BudgetFlow, kan: string) {
  newPre.value = null
  newFlow.value = flow
  newKan.value = kan
  editing.value = 'new'
}
/** 予算前執行を明細にする（款は担当が選ぶ。金額と名前を初めに入れておく） */
function addFromPre(p: PreExecution) {
  newPre.value = p
  newFlow.value = 'expense'
  newKan.value = ''
  editing.value = 'new'
}
</script>

<template>
  <section>
    <p><NuxtLink to="/budget/collect">← 集約</NuxtLink></p>
    <template v-if="team && view">
      <h1>{{ team.bureau }} ／ {{ team.team }}</h1>
      <p class="hint">
        {{ view.round.term }} {{ view.round.kind }}（{{ PHASE_LABELS[phase] }}）・入力する人 {{ team.members.length ? `${team.members.length}人` : '未割り当て' }}
      </p>

      <div class="card head">
        <p>
          支出 <strong>{{ formatYen(summary.total) }}</strong>（{{ view.round.kind === '本予算' ? `昨年の予算 ${formatYen(refTotal.budget)}` : `もとの予算 ${formatYen(summary.base)}` }}）・
          収入 <strong>{{ formatYen(summary.income) }}</strong>（{{ view.round.kind === '本予算' ? `昨年の予算 ${formatYen(refIncomeTotal.budget)}` : `もとの予算 ${formatYen(summary.incomeBase)}` }}）・
          収支 <strong>{{ formatYen(summary.income - summary.total) }}</strong>・
          未提出 {{ summary.draft }} ／ 要修正 {{ summary.returned }} ／ 査定待ち {{ summary.submitted }} ／ 承認済み {{ summary.approved }}
        </p>
        <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
        <p v-if="message" class="ok">{{ message }}</p>
        <div v-if="editable && toSubmit && phase !== 'closed'" class="buttons">
          <button :disabled="pending" @click="submit">今年の明細を提出（{{ toSubmit }}件）</button>
        </div>
        <p v-if="editable && !reviewer && phase === 'closed'" class="hint">集約は終了しました。査定が始まると、要修正になった明細だけ直して出し直せます。</p>
        <p v-if="editable && !reviewer && phase === 'reviewing'" class="hint">査定中です。要修正になった明細だけ直して出し直せます。</p>
      </div>

      <section v-if="preExecutions.length" class="pre-list" :class="{ todo: preNotAdded }">
        <h2>予算前執行 <span class="muted">{{ preExecutions.length }}件<template v-if="preNotAdded">・未追加 {{ preNotAdded }}件</template></span></h2>
        <p class="hint">この担当の予算前執行です。「明細に追加」で今年の明細にして、ほかの明細と同じように提出してください。明細にしておくと、本予算の確定のときにその明細へ付け替えます。明細にしたあとは修正・削除できないので、款・金額をよく確かめてから追加してください。</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>番号</th><th>支出項目名</th><th class="num">金額</th><th>理由</th><th>明細</th></tr></thead>
            <tbody>
              <tr v-for="p in preExecutions" :key="p.id">
                <td>{{ p.seq }}</td>
                <td>{{ p.itemName }}<small v-if="p.teamId == null" class="muted">（依頼の担当名：{{ p.team }}）</small></td>
                <td class="num">{{ formatYen(p.amount) }}</td>
                <td class="remark">{{ p.reason }}</td>
                <td>
                  <span v-if="p.itemNumber" class="added">{{ p.itemNumber }}</span>
                  <button v-else-if="canAdd" class="secondary" :disabled="pending" @click="addFromPre(p)">明細に追加</button>
                  <span v-else class="not-added">未追加</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="mine">
        <header class="mine-head">
          <div class="mine-title">
            <h2>今年の明細（{{ view.round.term }} {{ view.round.kind }}・提出する分）</h2>
            <span class="muted">{{ items.filter(i => !i.deleted).length }}件・支出 {{ formatYen(summary.total) }}・収入 {{ formatYen(summary.income) }}</span>
          </div>
          <div v-if="canAdd" class="add-buttons">
            <button class="secondary" :disabled="pending" @click="addTo('income', '')">収入の明細の追加</button>
            <button class="secondary" :disabled="pending" @click="addTo('expense', '')">支出の明細の追加</button>
          </div>
        </header>
        <BudgetItemForm
          v-if="editing === 'new'" :key="`${newFlow}|${newKan}|${newPre?.id}`"
          :initial="newPre ? { flow: 'expense', kou: newPre.itemName, amount: newPre.amount, preExecution: true } : { flow: newFlow, kan: newKan }"
          :kans="kansByFlow[newFlow]" :kans-by-flow="kansByFlow" :with-flow="!newPre" submit-label="追加"
          :pending="pending" :errors="errors" @submit="save" @cancel="editing = null"
        />

        <template v-for="sec in sections" :key="sec.flow">
        <h3 class="flow-head" :class="sec.flow">{{ FLOW_LABELS[sec.flow] }}の部 <span class="muted">{{ formatYen(sec.total) }}</span></h3>
        <div v-for="k in sec.kans" :key="k.key" class="kan" :class="{ folded: folded.has(k.key) }">
          <div class="kan-head">
            <button class="fold" :aria-expanded="!folded.has(k.key)" :aria-label="folded.has(k.key) ? '開く' : '折りたたむ'" @click="toggle(k.key)">
              <AppIcon name="chevron-down" />
            </button>
            <h2 @click="toggle(k.key)">{{ k.kan || '（款なし）' }}</h2>
            <span class="muted">{{ k.list.length }}件</span>
            <span class="muted">{{ formatYen(k.total) }}</span>
            <button v-if="canAdd" class="link" @click="addTo(k.flow, k.kan)">この款に追加</button>
          </div>
          <div v-show="!folded.has(k.key)" class="table-wrap">
            <table class="items">
              <thead>
                <tr><th>項目番号</th><th>項 / 目 / 節</th><th>数量</th><th>単価</th><th>金額</th><th>{{ view.round.kind === '本予算' ? '昨年から' : 'もとの予算から' }}</th><th>取引先</th><th>状態</th><th /></tr>
              </thead>
              <tbody>
                <template v-for="i in k.list" :key="i.id">
                  <tr :class="{ deleted: i.deleted }">
                    <td class="no">{{ i.number }}</td>
                    <td>
                      {{ itemName(i) }}
                      <span v-if="i.isNew" class="tag fill pink">新規</span>
                      <span v-if="i.preExecution" class="tag fill yellow">予算前執行</span>
                      <BudgetItemDetails :item="i" />
                    </td>
                    <td>{{ i.quantity }}</td>
                    <td class="num">{{ formatYen(i.unitPrice) }}</td>
                    <td class="num">{{ formatYen(i.amount) }}</td>
                    <td class="num change" :class="changeOf(i).kind">{{ changeOf(i).label }}</td>
                    <td>{{ i.vendor }}</td>
                    <td>
                      <span class="status" :class="i.status">{{ itemStatusLabel(i) }}</span>
                      <small v-if="i.reviewComment && i.status !== 'approved'" class="comment">{{ i.reviewComment }}</small>
                    </td>
                    <td class="actions">
                      <template v-if="canChange(i)">
                        <button v-if="!i.deleted" class="link" @click="editing = i.id">修正</button>
                        <button v-if="!i.deleted" class="link" @click="remove(i)">削除</button>
                        <button v-else class="link" @click="restore(i)">削除の取り消し</button>
                      </template>
                      <button v-if="i.reviewCount || i.status === 'returned'" class="link" @click="toggleHistory(i.id)">やり取り</button>
                    </td>
                  </tr>
                  <tr v-if="historyOpen.has(i.id)">
                    <td colspan="9">
                      <ReviewHistory :round-id="view.round.id" :track-id="i.trackId" :item-id="i.id" :can-reply="editable" @replied="refresh()" />
                    </td>
                  </tr>
                  <tr v-if="editing === i.id">
                    <td colspan="9">
                      <BudgetItemForm
                        :initial="i" :kans="kansByFlow[i.flow]" submit-label="保存" :pending="pending" :errors="errors"
                        @submit="save" @cancel="editing = null"
                      />
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </div>
        </template>
        <p v-if="!items.length" class="hint">まだ明細がありません。「収入の明細の追加」「支出の明細の追加」で入れるか、下の昨年の本予算・決算（参考）からコピーしてください。</p>
      </section>

      <section v-if="reference" class="reference" :class="{ folded: !refOpen }">
        <header class="ref-head" @click="refOpen = !refOpen">
          <button class="fold" :aria-expanded="refOpen" :aria-label="refOpen ? '折りたたむ' : '開く'" @click.stop="refOpen = !refOpen">
            <AppIcon name="chevron-down" />
          </button>
          <div class="ref-title">
            <h2>昨年の本予算・決算（参考）</h2>
            <span class="muted">収入 予算 {{ formatYen(refIncomeTotal.budget) }} ／ 決算 {{ formatYen(refIncomeTotal.actual) }}・支出 予算 {{ formatYen(refTotal.budget) }} ／ 決算 {{ formatYen(refTotal.actual) }}</span>
          </div>
          <button
            v-if="canAdd && notCopied(reference.items).length" class="secondary" :disabled="pending"
            @click.stop="copy(notCopied(reference.items))"
          >
            すべてコピー（{{ notCopied(reference.items).length }}件）
          </button>
        </header>
        <div v-if="refOpen" class="ref-body">
          <p class="hint">
            取り込んである昨年の本予算と決算です（収入の本予算：{{ refFile('incomeBudget')?.fileName || '未取り込み' }} ／ 収入の決算：{{ refFile('incomeSettlement')?.fileName || '未取り込み' }} ／ 支出の本予算：{{ refFile('budget')?.fileName || '未取り込み' }} ／ 支出の決算：{{ refFile('settlement')?.fileName || '未取り込み' }}）。
            使える明細はコピーして、内容を確認してから提出してください（コピーしなくても、「明細の追加」で一から入れられます）。決算は項目番号で本予算の明細に合わせています。
          </p>
          <p v-if="!reference.files.length" class="hint">まだ取り込まれていません。管理者か、ZAI の zas に割り当てられた人が「集約」の画面で昨年の本予算・決算を取り込むと、ここに出ます。</p>
          <p v-else-if="!reference.items.length" class="hint">取り込んだ本予算・決算に、この担当（{{ team.bureau }} ／ {{ team.team }}）の明細はありません。</p>
          <template v-for="sec in refSections" :key="sec.flow">
          <div class="flow-head ref-flow-head" :class="sec.flow">
            <h3>{{ FLOW_LABELS[sec.flow] }}の部</h3>
            <button
              v-if="canAdd && notCopiedOf(sec).length" class="secondary" :disabled="pending"
              @click="copy(notCopiedOf(sec))"
            >
              {{ FLOW_LABELS[sec.flow] }}をすべてコピー（{{ notCopiedOf(sec).length }}件）
            </button>
          </div>
          <div v-for="k in sec.kans" :key="k.key" class="kan">
            <div class="kan-head">
              <h3>{{ k.kan || '（款なし）' }}</h3>
              <span class="muted">予算 {{ formatYen(k.budget) }} ／ 決算 {{ formatYen(k.actual) }}</span>
              <button v-if="canAdd && notCopied(k.list).length" class="link" :disabled="pending" @click="copy(notCopied(k.list))">この款をコピー</button>
            </div>
            <div class="table-wrap">
              <table class="items ref">
                <thead>
                  <tr><th>項目番号</th><th>項 / 目 / 節</th><th>数量</th><th>予算額</th><th>決算額</th><th>取引先</th><th /></tr>
                </thead>
                <tbody>
                  <tr v-for="i in k.list" :key="i.id" :class="{ copied: i.copied }">
                    <td class="no">{{ i.itemNumber }}</td>
                    <td>{{ itemName(i) }}<small v-if="i.spec" class="muted spec">{{ i.spec }}</small></td>
                    <td>{{ i.quantity }}</td>
                    <td class="num">{{ i.budget == null ? '—' : formatYen(i.budget) }}</td>
                    <td class="num">{{ i.actual == null ? '（上にまとめて）' : formatYen(i.actual) }}</td>
                    <td>{{ i.vendor }}</td>
                    <td class="actions">
                      <span v-if="i.copied" class="copied-tag">今年の明細にコピー済み</span>
                      <button v-else-if="canAdd" class="link" :disabled="pending" @click="copy([i.id])">コピー</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          </template>
        </div>
      </section>

    </template>
    <p v-else>担当が見つかりません。</p>
  </section>
</template>

<style scoped>
.card { max-width: none; margin-bottom: 1rem; display: grid; gap: .5rem; }
.head p { margin: 0; }
.buttons { display: flex; flex-wrap: wrap; gap: .5rem; }
.kan { margin: 1.4rem 0; }
.kan-head { display: flex; align-items: center; gap: .8rem; margin-bottom: .4rem; }
.kan-head h2 { font-size: 1.05rem; margin: 0; cursor: pointer; user-select: none; }
.fold { display: inline-grid; place-items: center; width: 1.8rem; height: 1.8rem; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--text); }
.fold:hover:not(:disabled) { background: var(--accent-bg); }
.fold :deep(.app-icon) { transition: transform .15s; }
.kan.folded .fold :deep(.app-icon) { transform: rotate(-90deg); }
/* 今年の明細（提出する分）：色の付いた実線の枠で囲み、昨年の参考（点線）と見分ける */
.pre-list { display: grid; gap: .5rem; margin: 1rem 0; padding: .8rem; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.pre-list.todo { border-color: var(--danger); }
.pre-list h2 { margin: 0; font-size: 1.05rem; }
.pre-list .muted { font-weight: 400; font-size: .85rem; }
.pre-list td { vertical-align: middle; }
.pre-list .remark { white-space: pre-wrap; }
.pre-list .added { font-variant-numeric: tabular-nums; color: var(--done); }
.pre-list .not-added { color: var(--danger); font-weight: 600; }
.mine { margin: 1rem 0 1.6rem; padding: .2rem .8rem .8rem; border: 2px solid var(--accent); border-radius: 12px; background: var(--surface); }
.mine-head { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; padding: .5rem 0; border-bottom: 1px solid var(--border); }
.mine-title { flex: 1 1 14rem; display: grid; }
.mine-title h2 { font-size: 1.1rem; margin: 0; color: var(--accent-text); }
.mine-title .muted { font-size: .82rem; }
.mine .kan:first-of-type { margin-top: .8rem; }
.add-buttons { display: flex; flex-wrap: wrap; gap: .5rem; }
/* 収入の部・支出の部の見出し */
.flow-head { margin: 1.2rem 0 0; padding: .3rem .6rem; border-left: 4px solid var(--accent); font-size: 1rem; }
.flow-head.income { border-left-color: var(--done); }
.flow-head .muted { font-weight: 400; font-size: .85rem; margin-left: .4rem; }
/* 参考の収入の部・支出の部の見出し（右に「〜をすべてコピー」） */
.ref-flow-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; }
.ref-flow-head h3 { margin: 0; font-size: 1rem; }
.ref-flow-head button { font-size: .85rem; padding: .25rem .8rem; }
/* 昨年の本予算・決算（参考）：本体の明細と見分けられるよう、点線の枠で囲む */
.reference { margin: 1rem 0 1.6rem; border: 1.5px dashed var(--border); border-radius: 12px; background: var(--panel); }
.ref-head { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; padding: .6rem .8rem; cursor: pointer; user-select: none; }
.ref-title { flex: 1 1 14rem; display: grid; }
.ref-title h2 { font-size: 1rem; margin: 0; }
.ref-title .muted { font-size: .82rem; }
.reference.folded .fold :deep(.app-icon) { transform: rotate(-90deg); }
.ref-body { padding: 0 .8rem .8rem; }
.ref-body .kan { margin: .8rem 0; }
.ref-body h3 { font-size: .95rem; margin: 0; }
.items.ref { min-width: 40rem; background: transparent; }
/* コピー済みの参考の行は薄くして、まだコピーしていない行を目立たせる */
.items.ref tr.copied td { color: var(--muted); }
.copied-tag { font-size: .78rem; color: var(--done); white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.items { border-collapse: collapse; width: 100%; min-width: 52rem; background: var(--surface); }
.items th, .items td { padding: .4rem .55rem; border-bottom: 1px solid var(--border); text-align: left; font-size: .88rem; vertical-align: top; }
.items .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.items .no { white-space: nowrap; font-variant-numeric: tabular-nums; }
.spec, .comment { display: block; font-size: .78rem; }
.items .tag { margin-left: .3rem; font-size: .72rem; }
.comment { color: var(--danger); }
.change.plus { color: var(--danger); }
.change.minus { color: var(--done); }
.change.same { color: var(--muted); }
.status { white-space: nowrap; font-size: .82rem; }
.status.draft { color: var(--muted); }
.status.returned { color: var(--danger); font-weight: 600; }
.status.submitted { color: #9a6b00; font-weight: 600; }
.status.approved { color: var(--done); }
.deleted td { text-decoration: line-through; color: var(--muted); }
.deleted td.actions { text-decoration: none; }
.actions { white-space: nowrap; }
.actions .link + .link { margin-left: .6rem; }
.ok { color: var(--done); }
</style>
