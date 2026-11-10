<script setup lang="ts">
/**
 * 集約。確定していない集約があれば、段階（集約中 → 集約終了 → 査定中）と担当ごとの進み具合、自分の担当への入口。
 * 財務管理部は段階を進める：集約中は「すべて提出」「集約終了」、集約終了は「査定開始」、査定中は「すべて承認」「確定」。
 * 担当ごとの進み具合は、局ごとのタブで絞り、担当の枠ははじめは折りたたんでおく（見出しを押すと開く）。
 * 集約していないときは、財務管理部には次の集約を始めるフォーム（最新の確定した予算を写して始める）。
 */
import { BUDGET_TERM } from '#shared/constants'

const { can } = usePermissions()
const reviewer = computed(() => can('reviewBudget'))
/** 集約の段取り（開始・すべて提出・終了・査定開始・確定・中止、局・部・担当と入力する人）ができるか（財務局長・財務局長補佐・管理者） */
const { data: access } = await useFetch('/api/budget/access', { default: () => ({ canArrange: false }) })
const arranger = computed(() => access.value.canArrange)
const { data: view, refresh } = await useBudgetRound()

const collecting = computed(() => view.value && view.value.round.status !== 'confirmed' ? view.value : null)
const phase = computed(() => collecting.value?.round.status ?? 'confirmed')
const itemsOf = (teamId: number) => view.value?.items.filter(i => i.teamId === teamId) ?? []

/** まだ明細にしていない予算前執行 */
const preNotAddedAll = computed(() => (collecting.value?.preExecutions ?? []).filter(p => !p.itemNumber))
const preNotAddedOf = (teamId: number) => preNotAddedAll.value.filter(p => p.teamId === teamId).length
/** 依頼に書いた担当名が、どの担当にも合わない予算前執行（同じ局の担当の画面で明細にできる） */
const preNoTeam = computed(() => preNotAddedAll.value.filter(p => p.teamId == null))

/** 担当のカードの中身：状態の札（次に動く人が分かるもの）・合計・最後に直した明細 */
function teamCard(t: BudgetTeamView) {
  const items = itemsOf(t.id)
  const s = teamSummary(items)
  const status = s.returned ? { label: '要修正あり', tone: 'red' as const }
    : s.draft ? { label: '未提出あり', tone: 'gray' as const }
      : s.submitted ? { label: '査定待ち', tone: 'yellow' as const }
        : { label: '承認済み', tone: 'green' as const }
  const last = items.reduce<BudgetItemView | undefined>((a, b) => (!a || new Date(b.updatedAt) > new Date(a.updatedAt) ? b : a), undefined)
  const changed = items.filter(i => changeOf(i).kind !== 'same').length
  const preNotAdded = preNotAddedOf(t.id)
  return { s, status, last, changed, preNotAdded, mine: collecting.value?.myTeamIds.includes(t.id) && !reviewer.value }
}
/** 自分の担当を先に、そのあと要修正・未提出・査定待ち・承認済みの順に並べる */
const order = { red: 0, gray: 1, yellow: 2, green: 3 }
/** 出す担当（昨年の本予算・決算に明細がある担当と、この集約に項目がある担当） */
const listedTeams = computed(() => (collecting.value?.teams ?? []).filter(t => t.listed))
const cards = computed(() => listedTeams.value
  .map(t => ({ team: t, ...teamCard(t) }))
  .sort((a, b) => Number(!!b.mine) - Number(!!a.mine) || order[a.status.tone] - order[b.status.tone]))
const summary = computed(() => (collecting.value ? teamSummary(collecting.value.items) : null))
/** 局ごとのタブ（件数は担当の数） */
const bureau = ref('')
const bureauTabs = computed(() => {
  const teams = listedTeams.value
  const bureaus = [...new Set(teams.map(t => t.bureau))]
  return [{ key: '', label: 'すべて', count: teams.length }, ...bureaus.map(b => ({ key: b, label: b, count: teams.filter(t => t.bureau === b).length }))]
})
const shownCards = computed(() => cards.value.filter(c => !bureau.value || c.team.bureau === bureau.value))
/** 開いている担当（はじめはすべて折りたたむ） */
const opened = reactive(new Set<number>())
const toggle = (teamId: number) => (opened.has(teamId) ? opened.delete(teamId) : opened.add(teamId))
const allOpen = computed(() => shownCards.value.length > 0 && shownCards.value.every(c => opened.has(c.team.id)))
function toggleAll() {
  const open = !allOpen.value
  for (const c of shownCards.value) {
    if (open) opened.add(c.team.id)
    else opened.delete(c.team.id)
  }
}
/** 自分が割り当てられた担当（財務管理部はどの担当も直せるので、一覧から入る） */
const myTeams = computed(() => (collecting.value && !reviewer.value ? collecting.value.teams.filter(t => collecting.value!.myTeamIds.includes(t.id)) : []))

const errors = ref<string[]>([])
const message = ref('')
const pending = ref(false)
async function act(run: () => Promise<unknown>, done: string, linesChanged = false) {
  errors.value = []
  message.value = ''
  pending.value = true
  try {
    await run()
    message.value = done
    // 予算明細（執行依頼で選ぶ予算）が変わるのは確定したときだけ
    await Promise.all([refresh(), linesChanged && refreshNuxtData('budget-lines')])
  }
  catch (error) {
    errors.value = toMessages(error)
  }
  finally {
    pending.value = false
  }
}

/** 集約を始める（財務管理部） */
const start = reactive({ kind: '' as '' | '本予算' | '補正予算' })
const startRound = () => act(() => $fetch('/api/budget/rounds', { method: 'POST', body: start }), `${BUDGET_TERM} ${start.kind}の集約を始めました。`)
function confirmRound() {
  const notAdded = preNotAddedAll.value.length ? `\n明細にしていない予算前執行が${preNotAddedAll.value.length}件あります。同じ名前の明細がなければ、予算外の執行になります。` : ''
  if (!collecting.value || !confirm(`予算を確定します。今の予算明細がこの予算に入れ替わります。${notAdded}\nよろしいですか？`)) return
  act(() => $fetch(`/api/budget/rounds/${collecting.value!.round.id}/confirm`, { method: 'POST' }), '予算を確定しました。執行依頼ではこの予算から選べます。', true)
}
/** まだ承認していない明細（未提出・要修正・査定待ち）の数。「すべて承認」で一度に承認できる */
const notApproved = computed(() => (summary.value ? summary.value.draft + summary.value.returned + summary.value.submitted : 0))
function approveAll() {
  const s = summary.value
  if (!collecting.value || !s || !confirm(`未提出 ${s.draft}件・要修正 ${s.returned}件・査定待ち ${s.submitted}件を、すべて承認済みにします。担当がまだ提出していない明細も承認されます。よろしいですか？`)) return
  act(() => $fetch(`/api/budget/rounds/${collecting.value!.round.id}/approve-all`, { method: 'POST' }), 'すべての明細を承認しました。確定できます。')
}
/** まだ提出していない明細（未提出・要修正）の数。「すべて提出」で一度に査定待ちにできる */
const notSubmitted = computed(() => (summary.value ? summary.value.draft + summary.value.returned : 0))
function submitAll() {
  const s = summary.value
  if (!collecting.value || !s || !confirm(`すべての担当の未提出 ${s.draft}件・要修正 ${s.returned}件を提出します（査定待ちになります）。よろしいですか？`)) return
  act(() => $fetch(`/api/budget/rounds/${collecting.value!.round.id}/submit-all`, { method: 'POST' }), 'すべての明細を提出しました。「査定」で査定できます。')
}
/** 集約終了（入力の締め切り。未提出・要修正は自動で提出される） */
function closeRound() {
  if (!collecting.value || !confirm(`集約を終了します。担当はこれ以上入力できなくなり、未提出・要修正の明細${notSubmitted.value}件は自動で提出されます。よろしいですか？`)) return
  act(() => $fetch(`/api/budget/rounds/${collecting.value!.round.id}/close`, { method: 'POST' }), '集約を終了しました。「査定開始」で査定を始められます。')
}
/** 査定開始 */
function startReview() {
  if (!collecting.value || !confirm('査定を始めます。要修正になった明細だけ、担当が直して出し直せます。よろしいですか？')) return
  act(() => $fetch(`/api/budget/rounds/${collecting.value!.round.id}/start-review`, { method: 'POST' }), '査定を始めました。「査定」の画面で査定できます。')
}
/** 自分の担当の未提出・要修正をまとめて提出する（担当の人。集約終了の間はできない） */
const toSubmitOf = (teamId: number) => (phase.value === 'closed' ? 0 : itemsOf(teamId).filter(i => i.status === 'draft' || i.status === 'returned').length)
function submitTeam(t: BudgetTeamView) {
  if (!confirm(`${t.team}の未提出・要修正の明細${toSubmitOf(t.id)}件を提出します。提出すると、査定が終わるまで直せません。よろしいですか？`)) return
  act(() => $fetch(`/api/budget/teams/${t.id}/submit`, { method: 'POST' }), `${t.team}の明細を提出しました。財務管理部の査定を待ってください。`)
}
function cancelRound() {
  if (!collecting.value || !confirm('集約を中止します。この集約で入力した明細はすべて消えます。よろしいですか？')) return
  act(() => $fetch(`/api/budget/rounds/${collecting.value!.round.id}`, { method: 'DELETE' }), '集約を中止しました。')
}
</script>

<template>
  <section>
    <h1>集約</h1>
    <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
    <p v-if="message" class="ok">{{ message }}</p>

    <template v-if="collecting">
      <div class="card head">
        <h2>{{ collecting.round.term }} {{ collecting.round.kind }}（{{ PHASE_LABELS[phase] }}）</h2>
        <BudgetFlow :phase="phase" :summary="summary" />
        <p class="hint">
          <template v-if="phase === 'collecting'">
            {{ collecting.round.kind === '補正予算'
              ? '確定した本予算を写しています。変える明細だけを直して提出してください（直していない明細は承認済みのままです）。'
              : '明細は空から作ります。担当の画面に、取り込んだ昨年の本予算・決算が参考として出るので、使える明細はコピーして内容を確認し、すべて提出してください。' }}
          </template>
          <template v-else-if="phase === 'closed'">集約は終了しました。担当はもう入力できません。「査定開始」で査定を始めてください。</template>
          <template v-else>査定中です。要修正になった明細だけ、担当が直して出し直せます。すべて承認したら確定してください。</template>
        </p>
        <p v-if="summary">
          支出 <strong>{{ formatYen(summary.total) }}</strong><template v-if="collecting.round.kind === '補正予算'">（もとの予算 {{ formatYen(summary.base) }}）</template>・
          収入 <strong>{{ formatYen(summary.income) }}</strong><template v-if="collecting.round.kind === '補正予算'">（もとの予算 {{ formatYen(summary.incomeBase) }}）</template>・
          収支 <strong :class="{ minus: summary.income - summary.total < 0 }">{{ formatYen(summary.income - summary.total) }}</strong>・
          未提出 {{ summary.draft }} ／ 要修正 {{ summary.returned }} ／ 査定待ち {{ summary.submitted }} ／ 承認済み {{ summary.approved }}
        </p>
        <div v-if="reviewer || arranger" class="buttons">
          <template v-if="phase === 'collecting'">
            <template v-if="arranger">
              <button :disabled="pending || !notSubmitted" @click="submitAll">すべて提出（{{ notSubmitted }}件）</button>
              <button :disabled="pending" @click="closeRound">集約終了</button>
            </template>
          </template>
          <template v-else-if="phase === 'closed'">
            <button v-if="arranger" :disabled="pending" @click="startReview">査定開始</button>
          </template>
          <template v-else>
            <template v-if="reviewer">
              <NuxtLink class="button" to="/budget/review">査定（{{ summary?.submitted ?? 0 }}件）</NuxtLink>
              <button :disabled="pending || !notApproved" @click="approveAll">すべて承認（{{ notApproved }}件）</button>
            </template>
            <button v-if="arranger" :disabled="pending || notApproved > 0" :title="notApproved ? 'すべての明細を承認すると確定できます。' : ''" @click="confirmRound">確定</button>
          </template>
          <template v-if="arranger">
            <NuxtLink class="button secondary" to="/budget/setup">局・部・担当と入力する人</NuxtLink>
            <button class="secondary" :disabled="pending" @click="cancelRound">集約の中止</button>
          </template>
        </div>
      </div>

      <div v-if="myTeams.length" class="card">
        <h2>あなたの担当</h2>
        <ul class="team-links">
          <li v-for="t in myTeams" :key="t.id">
            <NuxtLink :to="`/budget/team/${t.id}`">{{ t.bureau }} ／ {{ t.team }}</NuxtLink>
            <button v-if="phase !== 'closed'" class="submit-team" :disabled="pending || !toSubmitOf(t.id)" @click="submitTeam(t)">すべて提出（{{ toSubmitOf(t.id) }}件）</button>
          </li>
        </ul>
      </div>
      <p v-else-if="!reviewer" class="hint">明細の入力・提出はだれでもできます。下の「担当ごとの進み具合」から、入力する担当を開いてください。</p>
      <div v-if="preNotAddedAll.length" class="card pre-notice">
        <strong>明細にしていない予算前執行 {{ preNotAddedAll.length }}件</strong>
        <p class="hint">担当の画面の「明細に追加」で今年の明細にしてください。担当のカードの「予算前執行 未追加」が目印です。</p>
        <ul v-if="preNoTeam.length">
          <li v-for="p in preNoTeam" :key="p.id">{{ p.seq }} {{ p.itemName }}（{{ p.bureau }}／依頼の担当名：{{ p.team }}）：担当名がどの担当とも合わないので、同じ局の担当の画面で明細にしてください。</li>
        </ul>
      </div>

      <h2>担当ごとの進み具合</h2>
      <BureauTabs v-model="bureau" :tabs="bureauTabs" />
      <div v-if="shownCards.length > 1" class="fold-all">
        <button class="link" @click="toggleAll">{{ allOpen ? 'すべて折りたたむ' : 'すべて開く' }}</button>
      </div>
      <TeamGroup
        v-for="c in shownCards" :key="c.team.id" :bureau="c.team.bureau" :team="c.team.team" :to="`/budget/team/${c.team.id}`"
        :open="opened.has(c.team.id)" @toggle="toggle(c.team.id)"
      >
        <template #stats>
          <span class="status-pill" :class="c.status.tone">{{ c.status.label }}</span>
          <span v-if="c.mine" class="tag">あなたの担当</span>
          <span>支出 <strong>{{ formatYen(c.s.total) }}</strong></span>
          <span v-if="c.s.income">収入 <strong>{{ formatYen(c.s.income) }}</strong></span>
          <span v-if="c.preNotAdded" class="tag fill red">予算前執行 未追加 {{ c.preNotAdded }}</span>
        </template>
        <InfoCard
          :to="`/budget/team/${c.team.id}`"
          :status="c.status.label" :tone="c.status.tone"
          :meta="`${c.team.bureauNo}　入力する人 ${c.team.members.length ? `${c.team.members.length}人` : '未割り当て'}`"
          :title="`${c.team.bureau} ／ ${c.team.team}`"
          :when="c.last?.updatedAt"
          :note="c.last ? `${itemName(c.last)}${c.last.reviewComment ? `：${c.last.reviewComment}` : ''}` : ''"
        >
          <template #tags>
            <span v-if="c.mine" class="tag">あなたの担当</span>
            <span v-if="c.changed" class="tag">変更 {{ c.changed }}件</span>
            <span v-if="c.preNotAdded" class="tag fill red">予算前執行 未追加 {{ c.preNotAdded }}</span>
            <span v-if="c.s.returned" class="tag fill red">要修正 {{ c.s.returned }}</span>
            <span v-if="c.s.draft" class="tag fill">未提出 {{ c.s.draft }}</span>
            <span v-if="c.s.submitted" class="tag fill yellow">査定待ち {{ c.s.submitted }}</span>
            <span v-if="c.s.approved" class="tag fill green">承認 {{ c.s.approved }}</span>
          </template>
          支出 {{ formatYen(c.s.total) }}<span v-if="collecting.round.kind === '補正予算'" class="base">（もとの予算 {{ formatYen(c.s.base) }}）</span>
          <span v-if="c.s.income" class="base">・収入 {{ formatYen(c.s.income) }}</span>
        </InfoCard>
      </TeamGroup>

      <ReferenceImport v-if="collecting.round.kind === '本予算'" />
    </template>

    <template v-else>
      <div class="card head">
        <h2>今は集約していません</h2>
        <p v-if="!view" class="hint">
          まだ予算がありません。{{ reviewer ? '「予算」の画面で、もとにする予算（昨年の予算など）を取り込んでから始めてください。' : '財務管理部が予算を用意するまでお待ちください。' }}
        </p>
        <template v-else-if="arranger">
          <p class="hint">
            確定した予算（{{ view.round.term }} {{ view.round.kind }}）の局・担当を写して始めます。
            本予算は明細を空から作り、取り込んだ昨年の本予算・決算を参考にコピーできます（下の「昨年の本予算・決算の取り込み」）。補正予算は明細も写し、変えるものだけ直します。
            集約開始 → 集約終了 → 査定開始 → 確定の順に進めます。
          </p>
          <form class="start" @submit.prevent="startRound">
            <fieldset class="kind">
              <legend>予算の種類</legend>
              <label class="check"><input v-model="start.kind" type="radio" value="本予算" required> 本予算（新しい期）</label>
              <label class="check"><input v-model="start.kind" type="radio" value="補正予算"> 補正予算（同じ期）</label>
            </fieldset>
            <p class="hint">期：{{ BUDGET_TERM }}</p>
            <button type="submit" :disabled="pending || !start.kind">集約開始</button>
          </form>
        </template>
        <p v-else class="hint">財務局長・財務局長補佐・管理者が集約を始めると、ここから自分の担当の明細を入力できます。</p>
      </div>
      <ReferenceImport v-if="view" />
    </template>
  </section>
</template>

<style scoped>
.minus { color: var(--danger); }
.card { max-width: none; margin-bottom: 1.5rem; display: grid; gap: .6rem; }
.head h2, .card h2 { margin: 0; font-size: 1.1rem; }
h2 { font-size: 1.1rem; }
.buttons { display: flex; flex-wrap: wrap; gap: .5rem; }
.kind { display: flex; flex-wrap: wrap; gap: .4rem 1.2rem; }
.team-links { margin: 0; padding-left: 1.2rem; display: grid; gap: .4rem; }
.submit-team { margin-left: .8rem; padding: .3rem .7rem; font-size: .85rem; }
.fold-all { display: flex; justify-content: flex-end; margin-bottom: .4rem; font-size: .85rem; }
.status-pill { font-size: .75rem; font-weight: 700; padding: .15rem .6rem; border-radius: 999px; white-space: nowrap; }
.status-pill.gray { background: #ecebe8; color: #5f5a55; }
.status-pill.yellow { background: #fbf0d4; color: #8a6200; }
.status-pill.red { background: #fbe4e4; color: #b42318; }
.status-pill.green { background: #dff1e3; color: #1e6b34; }
.base { font-weight: 400; color: var(--muted); margin-left: .3rem; font-size: .85rem; }
.ok { color: var(--done); }
</style>
