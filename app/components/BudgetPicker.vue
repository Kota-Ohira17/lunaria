<script setup lang="ts">
import { bureauNameOf } from '#shared/constants'

/**
 * 予算明細をスプレッドシートと同じ形の表から複数選ぶ。v-model は明細の key の配列。
 * flow="income" なら収入の明細を出す（収入の記録。見出しでまとめても選べる）。single なら1件だけ選ぶ（別の明細を押すと入れ替わる。見出しでまとめては選べない）。
 * v-model:amounts / quantities / vendors は明細ごとの実際の執行額・数量・取引先。
 * ここでは選んだときに予算の値を入れておくだけで、直すのは執行形態ごとの入力欄（ItemDetailsInputs）。
 */
const selected = defineModel<string[]>({ required: true })
const amounts = defineModel<Record<string, number | ''>>('amounts', { default: () => ({}) })
const quantities = defineModel<Record<string, string>>('quantities', { default: () => ({}) })
const vendors = defineModel<Record<string, string>>('vendors', { default: () => ({}) })
/** 開く局（フォームで局を選んだときの略称。例: ZAI）。変わるたびにその局のタブへ移動する */
const props = defineProps<{ preferredBureau?: string, flow?: 'income' | 'expense', single?: boolean }>()
const { data: lines } = await (props.flow === 'income' ? useIncomeLines() : useBudgetLines())

const query = ref('')
const bureaus = computed(() => [...new Set(lines.value.map(l => l.bureau).filter(Boolean))])

/** 表示中の局のタブ（'' はすべて）。最初は「すべて」 */
const bureau = ref('')
watch(() => props.preferredBureau, (code) => {
  const name = code ? bureauNameOf(code) : ''
  if (name && bureaus.value.includes(name)) bureau.value = name
})
function openTab(name: string) {
  bureau.value = name
}

// 親への反映（v-model）は次の描画まで遅れるので、素早く続けて押しても取りこぼさないよう手元にも持つ
const current = ref<string[]>([...selected.value])
watch(selected, (v) => { current.value = [...v] })

const currentAmounts = ref<Record<string, number | ''>>({ ...amounts.value })
watch(amounts, (v) => { currentAmounts.value = { ...v } })
const currentQuantities = ref<Record<string, string>>({ ...quantities.value })
watch(quantities, (v) => { currentQuantities.value = { ...v } })
const currentVendors = ref<Record<string, string>>({ ...vendors.value })
watch(vendors, (v) => { currentVendors.value = { ...v } })

const byKey = computed(() => new Map(lines.value.map(l => [l.key, l])))
const selectedLines = computed(() => current.value.map(k => byKey.value.get(k)).filter(l => l != null))
const selectedTotal = computed(() => selectedLines.value.reduce((s, l) => s + l.budgetAmount, 0))

/** 選択の変化に合わせて執行額・数量・取引先をそろえる（新しく選んだ明細には予算の値を入れておく） */
function syncAmounts() {
  const next: Record<string, number | ''> = {}
  const nextQuantities: Record<string, string> = {}
  const nextVendors: Record<string, string> = {}
  for (const k of current.value) {
    const line = byKey.value.get(k)
    next[k] = k in currentAmounts.value ? currentAmounts.value[k]! : (line?.budgetAmount ?? '')
    nextQuantities[k] = k in currentQuantities.value ? currentQuantities.value[k]! : (line?.quantity ?? '')
    nextVendors[k] = k in currentVendors.value ? currentVendors.value[k]! : (line?.vendor ?? '')
  }
  currentQuantities.value = nextQuantities
  quantities.value = nextQuantities
  currentVendors.value = nextVendors
  vendors.value = nextVendors
  currentAmounts.value = next
  amounts.value = next
}

/**
 * 選択中の明細を款ごとにまとめ、款の下の階層（項 › 目）を添えて表示する。
 * 款でまとめて選んだのか、項・目の一部を選んだのかが分かるように。
 */
const selectedByKan = computed(() => {
  const groups = Map.groupBy(
    [...selectedLines.value].sort((a, b) => a.sortOrder - b.sortOrder),
    l => `${l.kanNo}|${l.kan}`,
  )
  return [...groups.values()].map((items) => {
    const first = items[0]!
    const inKan = lines.value.filter(l => l.kanNo === first.kanNo && l.kan === first.kan).length
    return {
      key: `${first.kanNo}|${first.kan}`,
      kanNo: first.kanNo,
      kan: first.kan || first.label.split(' / ')[0],
      whole: items.length === inKan,
      inKan,
      total: items.reduce((s, l) => s + l.budgetAmount, 0),
      items: items.map((l) => {
        const parts = l.label.split(' / ')
        // ラベルの先頭は「項（なければ款）」。款は見出しに出すので重ねない
        const trail = parts.slice(0, -1).filter(p => p !== first.kan)
        return { line: l, trail, name: parts.at(-1)! }
      }),
    }
  })
})

/** 絞り込み語に合う明細（局のタブに関係なく） */
const matched = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return lines.value
  return lines.value.filter((l) => {
    const text = `${l.itemNumber} ${l.label} ${l.kan} ${l.team} ${l.vendor} ${l.quantity}`.toLowerCase()
    return words.every(w => text.includes(w))
  })
})
const filtered = computed(() => matched.value.filter(l => !bureau.value || l.bureau === bureau.value))

/** タブに出す件数（絞り込み中は該当件数）と、その局で選んでいる件数 */
const tabs = computed(() => {
  const picked = new Set(current.value)
  const all = [{ name: '', label: 'すべて', count: matched.value.length, picked: current.value.length }]
  return all.concat(bureaus.value.map(name => ({
    name,
    label: name,
    count: matched.value.filter(l => l.bureau === name).length,
    picked: lines.value.filter(l => l.bureau === name && picked.has(l.key)).length,
  })))
})

function toggle(key: string) {
  current.value = current.value.includes(key)
    ? current.value.filter(k => k !== key)
    : props.single ? [key] : [...current.value, key]
  selected.value = current.value
  syncAmounts()
}

function toggleMany(keys: string[], on: boolean) {
  if (props.single && on) return
  current.value = on
    ? [...current.value, ...keys.filter(k => !current.value.includes(k))]
    : current.value.filter(k => !keys.includes(k))
  selected.value = current.value
  syncAmounts()
}
</script>

<template>
  <div class="picker">
    <div v-if="selectedLines.length" class="picked">
      <div class="picked-head">
        <strong>選択中 {{ selectedLines.length }}件</strong>
        <span>予算額 {{ formatYen(selectedTotal) }}</span>
      </div>
      <p v-if="!single" class="hint">{{ flow === 'income' ? '実際に入った金額は、このあとの入力欄で明細ごとに入力します。' : '実際の金額・数量・取引先は、このあとの入力欄で明細ごとに入力します。' }}</p>
      <section v-for="g in selectedByKan" :key="g.key" class="kan-group">
        <header class="kan-head">
          <span class="kan-title">
            <span class="lv-badge kan">款</span>
            <span class="num">{{ g.kanNo }}</span>
            <strong class="kan-name">{{ g.kan }}</strong>
            <span class="scope" :class="{ whole: g.whole }">{{ g.whole ? `款ごと（全${g.inKan}件）` : `${g.items.length} / ${g.inKan}件` }}</span>
          </span>
          <span class="yen">{{ formatYen(g.total) }}</span>
          <button type="button" class="link" :aria-label="`款「${g.kan}」の選択をすべて外す`" @click="toggleMany(g.items.map(i => i.line.key), false)">まとめて外す</button>
        </header>
        <ul>
          <li v-for="i in g.items" :key="i.line.key">
            <span class="label">
              <span class="num">{{ i.line.itemNumber }}</span>
              <span v-if="i.trail.length" class="trail">{{ i.trail.join(' › ') }} › </span>
              <span class="name">{{ i.name }}</span>
            </span>
            <span class="yen">{{ formatYen(i.line.budgetAmount) }}</span>
            <button type="button" class="link" :aria-label="`${i.line.label} を外す`" @click="toggle(i.line.key)">外す</button>
          </li>
        </ul>
      </section>
    </div>

    <label class="search">絞り込み<input v-model="query" type="search" :placeholder="flow === 'income' ? '例: 協賛 / in01-01' : '例: インク / out-03-02 / ASKUL'"></label>

    <div class="bureau-tabs" role="tablist" aria-label="局">
      <button
        v-for="t in tabs"
        :key="t.name"
        type="button"
        role="tab"
        :aria-selected="bureau === t.name"
        :class="{ active: bureau === t.name, empty: !t.count }"
        @click="openTab(t.name)"
      >
        {{ t.label }}
        <span class="tab-count">{{ t.count }}</span>
        <span v-if="t.picked" class="tab-picked" :title="`この局で選択中 ${t.picked}件`">✓{{ t.picked }}</span>
      </button>
    </div>

    <div class="legend" aria-label="階層の見方">
      <span>階層：</span>
      <span class="legend-item"><span class="lv-badge kan">款</span></span>
      <span class="sep">›</span>
      <span class="legend-item"><span class="lv-badge kou">項</span></span>
      <span class="sep">›</span>
      <span class="legend-item"><span class="lv-badge moku">目</span></span>
      <span class="sep">›</span>
      <span class="legend-item"><span class="lv-badge setsu">節</span></span>
      <span class="sep">›</span>
      <span class="legend-item"><span class="leaf-swatch" />明細（金額のある行）</span>
    </div>

    <BudgetTable v-if="filtered.length" :lines="filtered" :selected="current" fixed-height :no-group-pick="single" @toggle="toggle" @toggle-many="toggleMany" />
    <p v-else class="hint">{{ query ? 'この局には該当する明細がありません。ほかの局のタブ（件数つき）を見てください。' : '該当する明細がありません。' }}</p>
    <p v-if="single" class="hint">明細の行をクリックすると選べます（1件だけ。別の行を押すと入れ替わります）。</p>
    <p v-else class="hint">
      明細の行をクリックすると1件ずつ選べます。款・項・目・節の見出しのチェックボックスは、その下の明細をすべてまとめて選択・解除します
      （横の数字が対象の件数。マウスを乗せると対象の明細が色付きで表示されます）。
    </p>
  </div>
</template>

<style scoped>
.picker { display: grid; gap: .75rem; min-width: 0; }
.picker {
  /* 本予算「支出」シートと同じ色（款: 青。項・目・節は白） */
  --fill-kan: #c9daf8;
}
.picked { border: 1px solid var(--accent); border-radius: 6px; padding: .5rem .75rem; display: grid; gap: .5rem; background: var(--sub); }
.picked-head { display: flex; justify-content: space-between; gap: 1rem; font-size: .9rem; }
/* 名前 | 予算額 | 操作 の3列をそろえる */
.kan-head, .picked li { display: grid; grid-template-columns: minmax(10rem, 1fr) 6rem 5rem; gap: .5rem; align-items: baseline; }
.kan-group { border-left: 4px solid var(--fill-kan); padding-left: .6rem; }
.kan-head { font-size: .88rem; padding: .15rem 0; }
.kan-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: .4rem; min-width: 0; }
.scope { font-size: .75rem; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 .5em; }
.scope.whole { color: var(--text); background: var(--accent-bg); border-color: var(--accent); font-weight: 600; }
.picked ul { list-style: none; margin: 0; padding: 0 0 0 .4rem; display: grid; gap: .15rem; border-left: 1px dashed var(--border); }
.picked li { font-size: .85rem; padding-left: .5rem; }
.trail { color: var(--muted); }
.name { font-weight: 500; }
.num { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; margin-right: .3rem; }
.label { min-width: 0; overflow-wrap: anywhere; }
.yen { font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }

.lv-badge {
  display: inline-block; min-width: 1.4em; padding: 0 .3em; border-radius: 3px; text-align: center;
  font-size: .72rem; font-weight: 700; line-height: 1.5; color: #333; background: var(--fill-kan); border: 1px solid #a4bfee;
}
.lv-badge.kou, .lv-badge.moku, .lv-badge.setsu { background: #fff; border-color: #ccc; }
.search { max-width: 28rem; }
.bureau-tabs { display: flex; flex-wrap: wrap; gap: .3rem; border-bottom: 2px solid var(--accent); padding-bottom: .4rem; }
.bureau-tabs button {
  display: inline-flex; align-items: center; gap: .35rem; padding: .3rem .7rem; font-size: .85rem;
  background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px 6px 0 0;
}
.bureau-tabs button.active { background: var(--accent-bg); color: var(--accent-text); border-color: var(--accent); font-weight: 700; }
.bureau-tabs button.empty:not(.active) { opacity: .5; }
.tab-count { font-size: .72rem; opacity: .75; font-variant-numeric: tabular-nums; }
.tab-picked { font-size: .72rem; font-weight: 700; padding: 0 .35em; border-radius: 999px; background: var(--done); color: #fff; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; font-size: .78rem; color: var(--muted); }
.legend-item { display: inline-flex; align-items: center; gap: .3rem; }
.sep { color: var(--border); }
.leaf-swatch { display: inline-block; width: 1.4em; height: 1em; border: 1px solid var(--border); background: var(--surface); border-radius: 2px; }
</style>
