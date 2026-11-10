<script setup lang="ts">
/**
 * 局・部・担当と、入力する人（集約の段取り。財務局長・財務局長補佐・管理者だけ）。局の中に部、部の中に担当を持つ（部に入らない局の直属の担当もある）。
 * 局ごとに、局の名前・局の番号を直し（局の中の担当すべてに反映）、部を足す・直す・消す（消すと中の担当は局の直属に戻る）、
 * 担当を足す・直す・部に入れる、各担当に明細を入力する人を割り当てる（1人が持てる担当は1つ）。局そのものも足せる。
 */
const { data: access } = await useFetch('/api/budget/access', { default: () => ({ canArrange: false }) })
if (!access.value.canArrange) await navigateTo('/budget/collect')
const { data: view, refresh } = await useBudgetRound()
const { data: people, refresh: refreshPeople } = await useFetch('/api/budget/people', { default: () => [] })

const collecting = computed(() => !!view.value && view.value.round.status !== 'confirmed')
type Dept = NonNullable<typeof view.value>['departments'][number]
/** 局ごとに、局の直属の担当と、部ごとの担当（予算の表の順） */
const groups = computed(() => (view.value?.bureaus ?? []).map((b) => {
  const teams = (view.value?.teams ?? []).filter(t => t.bureauId === b.id)
  const depts = (view.value?.departments ?? []).filter(d => d.bureauId === b.id)
  return {
    bureau: b,
    count: teams.length,
    depts,
    sections: [
      { key: `${b.id}-0`, dept: null as Dept | null, teams: teams.filter(t => !t.departmentId) },
      ...depts.map(d => ({ key: `${b.id}-${d.id}`, dept: d as Dept | null, teams: teams.filter(t => t.departmentId === d.id) })),
    ],
  }
}))

/** 編集中の値（局・部・担当） */
const bureauDrafts = reactive<Record<number, { bureauNo: string, name: string }>>({})
const deptDrafts = reactive<Record<number, { code: string, nameJa: string }>>({})
const teamDrafts = reactive<Record<number, { team: string, nameJa: string }>>({})
const adding = reactive<Record<number, string>>({})
const newTeams = reactive<Record<string, { team: string, nameJa: string }>>({})
const newDepts = reactive<Record<number, { code: string, nameJa: string }>>({})
watchEffect(() => {
  for (const b of view.value?.bureaus ?? []) {
    bureauDrafts[b.id] ??= { bureauNo: b.bureauNo, name: b.name }
    newDepts[b.id] ??= { code: '', nameJa: '' }
  }
  for (const d of view.value?.departments ?? []) deptDrafts[d.id] ??= { code: d.code, nameJa: d.nameJa }
  for (const t of view.value?.teams ?? []) {
    teamDrafts[t.id] ??= { team: t.team, nameJa: t.nameJa }
    // 「＋人の追加」が選ばれた状態で出す
    adding[t.id] ??= ''
  }
  for (const g of groups.value) for (const s of g.sections) newTeams[s.key] ??= { team: '', nameJa: '' }
})
const bureauChanged = (b: { id: number, bureauNo: string, name: string }) => !!bureauDrafts[b.id] && (bureauDrafts[b.id]!.bureauNo !== b.bureauNo || bureauDrafts[b.id]!.name !== b.name)
const deptChanged = (d: Dept) => !!deptDrafts[d.id] && (deptDrafts[d.id]!.code !== d.code || deptDrafts[d.id]!.nameJa !== d.nameJa)
const teamChanged = (t: BudgetTeamView) => !!teamDrafts[t.id] && (teamDrafts[t.id]!.team !== t.team || teamDrafts[t.id]!.nameJa !== t.nameJa)

const messages = reactive<Record<string, { ok: boolean, text: string }>>({})
const busy = ref(false)

async function run(key: string, task: () => Promise<unknown>, done: string) {
  busy.value = true
  delete messages[key]
  try {
    await task()
    await Promise.all([refresh(), refreshPeople()])
    messages[key] = { ok: true, text: done }
  }
  catch (error) {
    messages[key] = { ok: false, text: toMessages(error).join(' / ') }
  }
  finally {
    busy.value = false
  }
}
const saveBureau = (id: number) => run(`b${id}`, () => $fetch(`/api/budget/bureaus/${id}`, { method: 'PATCH', body: bureauDrafts[id] }), '局を保存しました（中の担当にも反映しました）。')
const saveDept = (d: Dept) => run(`d${d.id}`, () => $fetch(`/api/budget/departments/${d.id}`, { method: 'PATCH', body: deptDrafts[d.id] }), '部を保存しました。')
function removeDept(d: Dept) {
  if (!confirm(`部「${d.code}」を消します。中の担当は消えず、局の直属に戻ります。よろしいですか？`)) return
  run(`b${d.bureauId}`, () => $fetch(`/api/budget/departments/${d.id}`, { method: 'DELETE' }), '部を消しました（中の担当は局の直属に戻しました）。')
}
const addDept = (bureauId: number) => run(`b${bureauId}`, async () => {
  await $fetch('/api/budget/departments', { method: 'POST', body: { bureauId, ...newDepts[bureauId] } })
  newDepts[bureauId] = { code: '', nameJa: '' }
}, '部を足しました。担当を部に入れるには、担当の「部」を選んでください。')
const saveTeam = (id: number) => run(`t${id}`, () => $fetch(`/api/budget/teams/${id}`, { method: 'PATCH', body: teamDrafts[id] }), '保存しました。')
const moveTeam = (t: BudgetTeamView, value: string) => run(`t${t.id}`, () => $fetch(`/api/budget/teams/${t.id}/department`, { method: 'PUT', body: { departmentId: value ? Number(value) : null } }), '部を変えました。')
const setMembers = (id: number, emails: string[]) => run(`t${id}`, () => $fetch(`/api/budget/teams/${id}/members`, { method: 'PUT', body: { emails } }), '割り当てを保存しました。')
function addMember(t: BudgetTeamView) {
  const email = adding[t.id]
  if (!email) return
  const other = people.value.find(p => p.email === email && p.team)
  if (other && !confirm(`${other.name} は今「${other.bureau} ／ ${other.team}」の担当です。この担当に付け替えますか？`)) return
  adding[t.id] = ''
  setMembers(t.id, [...t.members.map(m => m.email), email])
}
const addTeam = (bureauId: number, dept: Dept | null, key: string) => run(`b${bureauId}`, async () => {
  await $fetch('/api/budget/teams', { method: 'POST', body: { bureauId, departmentId: dept?.id ?? null, ...newTeams[key] } })
  newTeams[key] = { team: '', nameJa: '' }
}, '担当を足しました。')

const newBureau = reactive({ name: '', bureauNo: '' })
const addBureau = () => run('new', async () => {
  await $fetch('/api/budget/bureaus', { method: 'POST', body: newBureau })
  Object.assign(newBureau, { name: '', bureauNo: '' })
}, '局を足しました。続けて、局の中に部と担当を足してください。')
</script>

<template>
  <section>
    <p><NuxtLink to="/budget/collect">← 集約</NuxtLink></p>
    <h1>局・部・担当と入力する人</h1>
    <p v-if="!collecting" class="card">確定していない集約がありません。「集約」の画面で集約を始めてから設定してください。</p>
    <template v-else>
      <p class="hint">
        局の中に部、部の中に担当を持ちます（部に入らない局の直属の担当もあります）。担当ごとに、明細を入力する人を割り当ててください。割り当てられた人は、自分の担当の明細だけを直して提出できます。
        局の番号（例：out01）は項目番号の頭になります（変えると、これから足す明細から新しい番号になります）。割り当てる人は、先に「ユーザー」に登録されている必要があります。
      </p>

      <section v-for="g in groups" :key="g.bureau.id" class="bureau">
        <header class="bureau-head">
          <template v-if="bureauDrafts[g.bureau.id]">
            <label>局の番号<input v-model.trim="bureauDrafts[g.bureau.id]!.bureauNo" class="w-xs"></label>
            <label>局<input v-model.trim="bureauDrafts[g.bureau.id]!.name" class="w-s"></label>
            <button :disabled="busy || !bureauChanged(g.bureau)" @click="saveBureau(g.bureau.id)">局を保存</button>
          </template>
          <span class="muted count">部 {{ g.depts.length }} ／ 担当 {{ g.count }}</span>
          <small v-if="messages[`b${g.bureau.id}`]" :class="messages[`b${g.bureau.id}`]!.ok ? 'ok' : 'error'">{{ messages[`b${g.bureau.id}`]!.text }}</small>
        </header>

        <div v-for="s in g.sections" :key="s.key" class="section" :class="{ dept: s.dept }">
          <div v-if="s.dept && deptDrafts[s.dept.id]" class="dept-head">
            <label>部（英語）<input v-model.trim="deptDrafts[s.dept.id]!.code" class="w-xs"></label>
            <label>日本語名<input v-model.trim="deptDrafts[s.dept.id]!.nameJa" class="w-s"></label>
            <button class="secondary" :disabled="busy || !deptChanged(s.dept)" @click="saveDept(s.dept)">部を保存</button>
            <button class="link" :disabled="busy" @click="removeDept(s.dept)">部を消す</button>
            <small v-if="messages[`d${s.dept.id}`]" :class="messages[`d${s.dept.id}`]!.ok ? 'ok' : 'error'">{{ messages[`d${s.dept.id}`]!.text }}</small>
          </div>
          <p v-else-if="!s.dept && g.depts.length" class="section-title">局の直属</p>

          <div v-if="s.teams.length" class="table-wrap">
            <table class="teams">
              <thead><tr><th>担当（英語・日本語名）</th><th>部</th><th>入力する人</th></tr></thead>
              <tbody>
                <tr v-for="t in s.teams" :key="t.id">
                  <td>
                    <div class="team">
                      <template v-if="teamDrafts[t.id]">
                        <input v-model.trim="teamDrafts[t.id]!.team" class="w-xs" :aria-label="`${t.team} の英語名`">
                        <input v-model.trim="teamDrafts[t.id]!.nameJa" class="w-s" placeholder="日本語名" :aria-label="`${t.team} の日本語名`">
                      </template>
                      <button class="secondary" :disabled="busy || !teamChanged(t)" @click="saveTeam(t.id)">保存</button>
                    </div>
                  </td>
                  <td>
                    <select class="w-xs" :value="t.departmentId ?? ''" :disabled="busy" :aria-label="`${t.team} の部`" @change="moveTeam(t, ($event.target as HTMLSelectElement).value)">
                      <option value="">局の直属</option>
                      <option v-for="d in g.depts" :key="d.id" :value="d.id">{{ d.code }}</option>
                    </select>
                  </td>
                  <td>
                    <div class="members">
                      <span v-for="m in t.members" :key="m.email" class="chip">
                        {{ m.name }}
                        <button class="link" :title="`${m.name} を外す`" :disabled="busy" @click="setMembers(t.id, t.members.filter(x => x.email !== m.email).map(x => x.email))">×</button>
                      </span>
                      <select v-model="adding[t.id]" class="w-s" :disabled="busy" @change="addMember(t)">
                        <option value="">＋人の追加</option>
                        <option v-for="p in people.filter(p => !t.members.some(m => m.email === p.email))" :key="p.email" :value="p.email">
                          {{ p.name }}（{{ p.email }}）{{ p.team ? `・今は${p.team}` : '' }}
                        </option>
                      </select>
                      <small v-if="messages[`t${t.id}`]" :class="messages[`t${t.id}`]!.ok ? 'ok' : 'error'">{{ messages[`t${t.id}`]!.text }}</small>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="muted empty">{{ s.dept ? 'まだ担当がありません。' : '局の直属の担当はありません。' }}</p>

          <form class="add-team" @submit.prevent="addTeam(g.bureau.id, s.dept, s.key)">
            <template v-if="newTeams[s.key]">
              <input v-model.trim="newTeams[s.key]!.team" class="w-xs" required placeholder="英語名" aria-label="足す担当の英語名">
              <input v-model.trim="newTeams[s.key]!.nameJa" class="w-s" placeholder="日本語名" aria-label="足す担当の日本語名">
            </template>
            <button type="submit" class="secondary" :disabled="busy || !newTeams[s.key]?.team">＋ {{ s.dept ? `${s.dept.code} に担当を追加` : '局の直属に担当を追加' }}</button>
          </form>
        </div>

        <form class="add-dept" @submit.prevent="addDept(g.bureau.id)">
          <template v-if="newDepts[g.bureau.id]">
            <input v-model.trim="newDepts[g.bureau.id]!.code" class="w-xs" required placeholder="部（英語）" aria-label="足す部の英語名">
            <input v-model.trim="newDepts[g.bureau.id]!.nameJa" class="w-s" placeholder="日本語名" aria-label="足す部の日本語名">
          </template>
          <button type="submit" :disabled="busy || !newDepts[g.bureau.id]?.code">＋ この局に部を追加</button>
        </form>
      </section>

      <form class="card add" @submit.prevent="addBureau">
        <h2>局の追加</h2>
        <div class="fields">
          <label><span>局<span class="req">*</span></span><input v-model.trim="newBureau.name" required></label>
          <label><span>局の番号<span class="req">*</span></span><input v-model.trim="newBureau.bureauNo" class="w-xs" required></label>
        </div>
        <p v-if="messages.new" :class="messages.new.ok ? 'ok' : 'error'">{{ messages.new.text }}</p>
        <button type="submit" :disabled="busy">局を追加</button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.card { max-width: none; margin: 1rem 0; }
/* 局ごとの枠：見出しの帯に局の番号・局の名前。中に局の直属の担当と、部ごとの枠 */
.bureau { margin: 1rem 0; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); overflow: hidden; }
.bureau-head { display: flex; flex-wrap: wrap; align-items: end; gap: .5rem 1rem; padding: .7rem 1rem; background: var(--accent-bg); border-left: 5px solid var(--accent); border-bottom: 1px solid var(--border); }
.bureau-head label, .dept-head label { font-size: .78rem; }
.bureau-head .count { align-self: center; font-size: .85rem; }
.section { padding: .4rem .8rem 0; }
/* 部の枠：局の枠の中に、細い線で囲む */
.section.dept { margin: .7rem .8rem 0; padding: 0; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); overflow: hidden; }
.dept-head { display: flex; flex-wrap: wrap; align-items: end; gap: .4rem .8rem; padding: .5rem .8rem; background: var(--bg); border-bottom: 1px solid var(--border); border-left: 3px solid var(--accent); }
.section-title { margin: .3rem 0 .2rem; font-size: .8rem; color: var(--muted); font-weight: 700; }
.section.dept .table-wrap { padding: .3rem .6rem 0; }
.table-wrap { overflow-x: auto; }
.teams { border-collapse: collapse; width: 100%; min-width: 46rem; background: var(--surface); border-radius: 8px; }
.teams th, .teams td { padding: .4rem .5rem; border-bottom: 1px solid var(--border); text-align: left; font-size: .88rem; vertical-align: top; }
.team { display: flex; gap: .4rem; align-items: center; white-space: nowrap; }
.w-xs { max-width: 6.5rem; }
.w-s { max-width: 11rem; }
.members { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; min-width: 18rem; }
.chip { display: inline-flex; align-items: center; gap: .3rem; padding: .1rem .5rem; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); font-size: .82rem; }
.empty { margin: .3rem .6rem; font-size: .85rem; }
.add-team { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; padding: .5rem .6rem .7rem; }
.add-dept { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; padding: .8rem; }
.add h2 { margin: 0 0 .5rem; font-size: 1.05rem; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: .5rem .9rem; margin-bottom: .6rem; }
.ok { color: var(--done); }
</style>
