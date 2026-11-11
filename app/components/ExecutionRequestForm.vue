<script setup lang="ts">
/**
 * 執行依頼のフォーム。Google フォーム「予算執行依頼フォーム」と同じ質問・選択肢・説明文にそろえている。
 * pre（予算前執行）のときは、本予算が確定する前なので予算の表から選ばず、支出項目名だけ書く。ほかは同じ。
 */
import {
  ACCOUNT_TYPES, budgetChangeOfItems, changedItems, LARGE_INCREASE, DELIVERY_PLACES, METHOD_GROUPS, ONLINE_SITES, OTHER_METHODS, PAPER_RECEIPT,
} from '#shared/constants'
const props = defineProps<{ pre?: boolean }>()
const { user } = useUserSession()
/** 予算の変更を申請したときの結果（申請した項目番号と、申請できなかった項目番号と理由） */
type BudgetChangeResult = { created: string[], skipped: { itemNumber: string, reason: string }[] } | null
const { submit, errors, pending } = useSubmit<{ seq: string, budgetChangeRequests: BudgetChangeResult }>('/api/entries')

const form = reactive({
  applicantName: user.value?.name ?? '',
  department: '',
  inCharge: '',
  budgetLineKeys: [] as string[],
  itemAmounts: {} as Record<string, number | ''>,
  itemQuantities: {} as Record<string, string>,
  itemVendors: {} as Record<string, string>,
  itemNumber: '',
  budgetPath: { kan: '', kou: '', moku: '', setsu: '' },
  itemName: '',
  budgetCommitteeApproved: false,
  /** 金額が予算額と違う明細があるとき、予算の変更も申請するか（任意。初めはしない） */
  requestBudgetChange: false,
  budgetChangeReason: '',
  preExecutionReason: '',
  remark: '',
  amount: '',
  // 振込
  transferDeadline: '',
  bank: { bankName: '', branchName: '', accountType: '', accountNumber: '', accountName: '' },
  // 発注
  site: '',
  url: '',
  quantity: '',
  neededBy: '',
  deliveryPlace: '',
  // 立替
  purchase: '',
  paperReceipt: '',
  payPlanDate: '',
  // 現金執行・カード決済・その他
  otherChoice: '',
  executeAt: '',
  details: '',
})
const methodGroup = ref('')
const file = ref<File | null>(null)
const confirmed = ref(false)
const done = ref<string>()
const changeResult = ref<BudgetChangeResult>(null)

const onAmountInput = useTotalFromItems(toRef(form, 'itemAmounts'), toRef(form, 'amount'))

const { data: budgetLines } = useBudgetLines()
const budgetKind = useBudgetKind()
/** 予算の明細を選んでいるか（選んでいれば、金額・数量・取引先は形態ごとの欄で明細ごとに入力する） */
const hasItems = computed(() => form.budgetLineKeys.length > 0)
/** 明細ごとの欄に出す列。発注の取引先は通販サイト、立替は購入先なので出さない */
const itemFields = computed(() => (methodGroup.value === '発注' || methodGroup.value === '立替'
  ? ['quantity', 'amount'] as const
  : ['quantity', 'vendor', 'amount'] as const))

// 明細ごとに入れた金額の合計・数量を、申請の金額・数量にする（同じことを2回入力させない）
const itemsQuantity = useQuantityOfItems(toRef(form, 'budgetLineKeys'), toRef(form, 'itemQuantities'))
watch([() => form.itemAmounts, hasItems], () => {
  if (!hasItems.value) return
  const values = form.budgetLineKeys.map(k => form.itemAmounts[k]).filter(v => typeof v === 'number') as number[]
  form.amount = values.length ? String(values.reduce((s, v) => s + v, 0)) : ''
}, { deep: true })
watch([itemsQuantity, hasItems], () => { if (hasItems.value) form.quantity = itemsQuantity.value })

// 発注・立替では、明細の取引先を通販サイト・購入先にそろえる。ほかの形態に切り替えたら予算の取引先に戻す
let vendorSource = ''
watch([methodGroup, () => form.site, () => form.purchase, () => form.budgetLineKeys], () => {
  const source = methodGroup.value === '発注' ? form.site : methodGroup.value === '立替' ? form.purchase : ''
  const byKey = new Map(budgetLines.value.map(l => [l.key, l]))
  const next = { ...form.itemVendors }
  for (const k of form.budgetLineKeys) {
    if (source) next[k] = source
    else if (vendorSource && next[k] === vendorSource) next[k] = byKey.get(k)?.vendor ?? ''
  }
  vendorSource = source
  form.itemVendors = next
})

// 表から推測できる項目（購入先・通販サイト）は、選んだ明細の予算の値から初期値を入れておく
/** 選んだ明細の、予算の表にある取引先（重複なし） */
const budgetVendors = computed(() => {
  const byKey = new Map(budgetLines.value.map(l => [l.key, l]))
  return [...new Set(form.budgetLineKeys.map(k => byKey.get(k)?.vendor ?? '').filter(Boolean))]
})
useAutoFill(toRef(form, 'purchase'), computed(() => budgetVendors.value.join('、')))
useAutoFill(toRef(form, 'site'), computed(() => (budgetVendors.value.length === 1 ? siteOfVendor(budgetVendors.value[0]!) : '')))

/** 予算からの変更（選んだ明細の予算額と、明細ごとに入力した金額から決める。表示だけで申請者は選ばない） */
const budgetSummary = computed(() => {
  if (!hasItems.value) return null
  const byKey = new Map(budgetLines.value.map(l => [l.key, l]))
  const lines = form.budgetLineKeys.map(k => byKey.get(k)).filter(l => l != null)
  return budgetChangeOfItems(lines, form.itemAmounts)
})
const diffYen = computed(() => {
  const d = (budgetSummary.value?.actual ?? 0) - (budgetSummary.value?.budget ?? 0)
  return `${d > 0 ? '+' : d < 0 ? '-' : '±'}¥${Math.abs(d).toLocaleString('ja-JP')}`
})
/** 金額が予算額と違う明細（「予算の変更も申請する」を出す） */
const changedLines = computed(() => {
  if (!hasItems.value) return []
  const byKey = new Map(budgetLines.value.map(l => [l.key, l]))
  return changedItems(form.budgetLineKeys.map(k => byKey.get(k)).filter(l => l != null), form.itemAmounts)
})
/** 1万円以上の増額なのに、役員会の承認にチェックがない */
const needsApproval = computed(() => budgetSummary.value?.change === LARGE_INCREASE && !form.budgetCommitteeApproved)

/** 2段目の執行形態（現金執行 / カード決済 / その他） */
const otherType = computed(() => OTHER_METHODS.find(m => m.label === form.otherChoice)?.type ?? (form.otherChoice ? 'その他' : ''))
const OTHER_LABELS = OTHER_METHODS.filter(m => m.type !== 'その他').map(m => m.label)

/** 選んだ形態に関係する項目だけ送る */
function buildPayload() {
  const common = {
    applicantName: form.applicantName,
    department: form.department,
    inCharge: form.inCharge,
    budgetLineKeys: form.budgetLineKeys,
    itemAmounts: filledAmounts(form.itemAmounts),
    itemQuantities: form.itemQuantities,
    itemVendors: form.itemVendors,
    itemNumber: form.itemNumber,
    budgetPath: form.budgetPath,
    itemName: form.itemName,
    budgetCommitteeApproved: budgetSummary.value?.change === LARGE_INCREASE && form.budgetCommitteeApproved,
    requestBudgetChange: changedLines.value.length > 0,
    budgetChangeReason: changedLines.value.length ? form.budgetChangeReason : '',
    remark: form.remark,
    preExecution: !!props.pre,
    preExecutionReason: props.pre ? form.preExecutionReason : '',
  }
  switch (methodGroup.value) {
    case '振込': return { ...common, type: '振込', amount: form.amount, deadline: form.transferDeadline, bank: form.bank }
    case '発注': return { ...common, type: '発注', amount: form.amount, site: form.site, url: form.url, quantity: form.quantity, deadline: form.neededBy, deliveryPlace: form.deliveryPlace }
    case '立替': return { ...common, type: '立替', amount: form.amount, purchase: form.purchase, paperReceipt: form.paperReceipt, deadline: form.payPlanDate }
    default: return {
      ...common,
      type: otherType.value,
      otherMethod: otherType.value === 'その他' ? form.otherChoice : '',
      amount: form.amount,
      deadline: form.executeAt,
      details: form.details,
    }
  }
}

async function onSubmit() {
  const result = await submit(buildPayload(), methodGroup.value === '振込' ? file.value : null)
  if (result) {
    done.value = result.seq
    changeResult.value = result.budgetChangeRequests
  }
}
</script>

<template>
  <section class="page">
    <h1>{{ pre ? '予算前執行依頼フォーム' : '予算執行依頼フォーム' }}</h1>

    <div v-if="done" class="success">
      <p>受け付けました（受付番号 {{ done }}）。</p>
      <template v-if="changeResult">
        <p v-if="changeResult.created.length">
          予算の変更も申請しました（{{ changeResult.created.join('・') }}）。ZAI の zas が承認すると予算に反映されます。進み具合は「<NuxtLink to="/budget/changes">予算の変更</NuxtLink>」で見られます。
        </p>
        <div v-if="changeResult.skipped.length" class="error">
          <p>次の項目は予算の変更を申請できませんでした。必要なら「予算の変更」から申請してください。</p>
          <ul><li v-for="s in changeResult.skipped" :key="s.itemNumber">{{ s.itemNumber }}：{{ s.reason }}</li></ul>
        </div>
      </template>
      <NuxtLink to="/entries">申請一覧へ</NuxtLink>
    </div>

    <form v-else @submit.prevent="onSubmit">
      <div class="intro">
        <p v-if="pre">
          本予算が確定する前に、ZAIに予算執行（予算前執行）を依頼するフォームです。<br>
          予算の項目はまだないので、支出項目名を書いてください。本予算が確定すると、同じ担当・同じ名前の項目に付け替えます。
        </p>
        <p>{{ pre ? '' : 'ZAIに予算執行を依頼するフォームです。' }}<br v-if="!pre">予算執行には、主に以下の方法が存在します。</p>
        <ul>
          <li>振込</li>
          <li>発注（ASKUL、モノタロウ、Amazon、楽天、アースダンボールなど）</li>
          <li>立替</li>
          <li>現金執行</li>
          <li>引き落とし（クレジットカード登録）/その他</li>
        </ul>
        <p class="warn">不正防止のため回答後の編集はできません、注意してください。</p>
      </div>

      <fieldset>
        <legend>{{ pre ? '予算前執行依頼フォーム' : '予算執行依頼フォーム' }}</legend>
        <label><span>申請者氏名<span class="req">*</span></span><input v-model="form.applicantName" class="w-m" placeholder="例：こまばたろう" required></label>
        <div v-if="pre" class="row">
          <BureauField v-model="form.department" all />
          <label><span>担当名<span class="req">*</span></span><input v-model="form.inCharge" placeholder="例：zas" required></label>
        </div>

        <label v-if="pre"><span>支出項目名<span class="req">*</span></span>
          <span class="hint">本予算で入る予定の項目の名前（款・項・目・節のどれか）を書いてください。本予算が確定すると、同じ担当・同じ名前の項目に付け替えます。</span>
          <input v-model="form.itemName" required>
        </label>
        <label v-if="pre"><span>予算前執行が必要な理由<span class="req">*</span></span>
          <span class="hint">本予算の確定を待てない理由を書いてください。</span>
          <textarea v-model="form.preExecutionReason" rows="3" required />
        </label>
        <div v-else class="block">
          <span class="block-label">項目番号・支出項目名<span class="req">*</span></span>
          <p class="hint">{{ budgetKind === "補正予算" ? "補正予算総会にて承認された補正予算" : budgetKind === "本予算" ? "総会にて承認された本予算" : "承認された予算" }}から選んでください。款でまとめて申請する場合は、款の見出しのチェックボックスで款ごと選べます。</p>
          <ExpenseItemsField
            v-model:keys="form.budgetLineKeys"
            v-model:amounts="form.itemAmounts"
          v-model:quantities="form.itemQuantities"
          v-model:vendors="form.itemVendors"
            v-model:item-number="form.itemNumber"
            v-model:item-name="form.itemName"
            v-model:path="form.budgetPath"
            :bureau="form.department"
            :team="form.inCharge"
            item-name-label="支出項目名"
          >
            <template #manual>
              <div class="row">
                <BureauField v-model="form.department" />
                <label><span>担当名<span class="req">*</span></span><input v-model="form.inCharge" placeholder="例：zas" required></label>
              </div>
            </template>
          </ExpenseItemsField>
          <p class="hint">支出項目名は、どの項目に対応するかが分かれば正式名称でなくても大丈夫です。</p>
        </div>

        <RadioWithOther v-model="methodGroup" label="執行形態" :options="METHOD_GROUPS" required />
      </fieldset>

      <fieldset v-if="methodGroup === '振込'">
        <legend>振込</legend>
        <p class="section-desc">ZAIが取引先の口座に直接振り込みます。</p>
        <label>（ある場合は）請求書<input type="file" accept="application/pdf,image/jpeg,image/png" @change="file = ($event.target as HTMLInputElement).files?.[0] ?? null"></label>
        <label><span>振込期限<span class="req">*</span></span><input v-model="form.transferDeadline" type="date" required></label>
        <ItemDetailsInputs
          v-if="hasItems"
          v-model:amounts="form.itemAmounts"
          v-model:quantities="form.itemQuantities"
          v-model:vendors="form.itemVendors"
          :keys="form.budgetLineKeys"
          :fields="itemFields"
          :require-quantity="methodGroup === '発注'"
          amount-label="振込金額"
        />
        <label v-else><span>振込金額<span class="req">*</span></span>
          <span class="hint">絶対に間違えないでください。「円」は入れないでください。</span>
          <YenInput v-model="form.amount" placeholder="例：10000" required @input="onAmountInput" />
        </label>
        <div class="row">
          <label><span>金融機関名<span class="req">*</span></span><input v-model="form.bank.bankName" placeholder="例：ゆうちょ銀行" required></label>
          <label><span>支店名・出張所名<span class="req">*</span></span><input v-model="form.bank.branchName" placeholder="例：渋谷支店" required></label>
        </div>
        <RadioWithOther v-model="form.bank.accountType" label="振込先の口座種別" :options="ACCOUNT_TYPES" other required />
        <div class="row account">
          <label><span>振込先の口座番号<span class="req">*</span></span><input v-model="form.bank.accountNumber" inputmode="numeric" pattern="\d{1,8}" required></label>
          <label><span>振込先の口座名義<span class="req">*</span></span><input v-model="form.bank.accountName" required></label>
        </div>
        <p class="hint">口座情報は財務局長・財務局長補佐・管理者だけが閲覧でき、Slack通知には含まれません。</p>
        <label>備考<textarea v-model="form.remark" rows="3" /></label>
      </fieldset>

      <fieldset v-else-if="methodGroup === '発注'">
        <legend>発注</legend>
        <p class="section-desc">ZAIが五月祭常任委員会の各種アカウントで発注を行います。</p>
        <RadioWithOther v-model="form.site" label="通販サイト" :options="ONLINE_SITES" other required />
        <label><span>商品ページのリンク<span class="req">*</span></span>
          <textarea v-model="form.url" rows="3" placeholder="複数ある場合は改行して入力してください。" required />
        </label>
        <ItemDetailsInputs
          v-if="hasItems"
          v-model:amounts="form.itemAmounts"
          v-model:quantities="form.itemQuantities"
          v-model:vendors="form.itemVendors"
          :keys="form.budgetLineKeys"
          :fields="itemFields"
          :require-quantity="methodGroup === '発注'"
          require-amount
          amount-label="金額（税込）"
        />
        <template v-else>
          <label><span>金額（税込）<span class="req">*</span></span>
            <YenInput v-model="form.amount" placeholder="例：3000" required @input="onAmountInput" />
          </label>
          <label><span>数量<span class="req">*</span></span><input v-model="form.quantity" class="w-m" required></label>
        </template>
        <p class="hint">金額は送料を除いた商品の税込金額を入れてください。同じサイトの発注とまとめて送料無料になるかの判断に使います。</p>
        <label><span>いつまでに必要ですか？<span class="req">*</span></span><input v-model="form.neededBy" type="date" required></label>
        <RadioWithOther v-model="form.deliveryPlace" label="配達場所" :options="DELIVERY_PLACES" other required />
        <label>備考<input v-model="form.remark"></label>
      </fieldset>

      <fieldset v-else-if="methodGroup === '立替'">
        <legend>立替</legend>
        <p class="section-desc">
          委員が一度私費で支払いを行い、後日ZAIが精算を行います。<br>
          領収書といった証憑は、購入後に<NuxtLink to="/entries">台帳</NuxtLink>でこの申請を開いて提出してください。<br>
          清算の時期の希望も、証憑を提出するときに選んでください。
        </p>
        <label><span>購入先<span class="req">*</span></span><input v-model="form.purchase" required></label>
        <ItemDetailsInputs
          v-if="hasItems"
          v-model:amounts="form.itemAmounts"
          v-model:quantities="form.itemQuantities"
          v-model:vendors="form.itemVendors"
          :keys="form.budgetLineKeys"
          :fields="itemFields"
          :require-quantity="methodGroup === '発注'"
          amount-label="金額"
        />
        <label v-else><span>立替合計金額<span class="req">*</span></span>
          <span class="hint">「円」は入れないでください。</span>
          <YenInput v-model="form.amount" placeholder="例：10000" required @input="onAmountInput" />
        </label>
        <RadioWithOther
          v-model="form.paperReceipt"
          label="紙媒体の領収証の有無"
          :options="PAPER_RECEIPT"
          required
          hint="ある場合、購入後すぐに台帳から証憑として提出してください。また、清算の際に忘れずに持参してください。"
        />
        <label><span>立替予定日<span class="req">*</span></span><input v-model="form.payPlanDate" type="date" required></label>
        <label>備考<textarea v-model="form.remark" rows="3" /></label>
      </fieldset>

      <fieldset v-else-if="methodGroup">
        <legend>現金執行・カード決済（デビットカード）・その他</legend>
        <p class="section-desc">カード決済にはカードの登録も含みます。</p>
        <RadioWithOther v-model="form.otherChoice" label="執行形態" :options="OTHER_LABELS" other required />
        <ItemDetailsInputs
          v-if="hasItems"
          v-model:amounts="form.itemAmounts"
          v-model:quantities="form.itemQuantities"
          v-model:vendors="form.itemVendors"
          :keys="form.budgetLineKeys"
          :fields="itemFields"
          :require-quantity="methodGroup === '発注'"
          amount-label="金額"
        />
        <label v-else><span>金額<span class="req">*</span></span>
          <span class="hint">「円」は入れないでください。</span>
          <YenInput v-model="form.amount" placeholder="例：10000" required @input="onAmountInput" />
        </label>
        <label><span>執行希望日時<span class="req">*</span></span>
          <span class="hint">ZAIの都合が合わない場合はこちらから連絡します。</span>
          <input v-model="form.executeAt" type="datetime-local" required>
        </label>
        <label><span>詳細<span class="req">*</span></span>
          <span class="hint">以下に詳細に記入してください。こちらから後日連絡します。</span>
          <textarea v-model="form.details" rows="3" required />
        </label>
        <label>備考<textarea v-model="form.remark" rows="3" /></label>
      </fieldset>

      <template v-if="methodGroup">
        <div v-if="budgetSummary" class="budget-change" :class="{ large: budgetSummary.change === LARGE_INCREASE }">
          <span class="block-label">{{ budgetKind }}からの変更</span>
          <p class="change">
            <strong>{{ budgetSummary.change }}</strong>
            <span class="muted">（予算額 {{ formatYen(budgetSummary.budget) }} → 執行額 {{ formatYen(budgetSummary.actual) }}、差額 {{ diffYen }}）</span>
          </p>
          <p class="hint">選んだ明細の予算額と、明細ごとに入力した金額から自動で決まります。増額の場合は、必ずZAIに相談してください。</p>
          <label v-if="budgetSummary.change === LARGE_INCREASE" class="check approval">
            <input v-model="form.budgetCommitteeApproved" type="checkbox" required>
            役員会の承認を得ました<span class="req">*</span>
          </label>
          <p v-if="budgetSummary.change === LARGE_INCREASE" class="hint">1万円以上の増額は、役員会の承認を得てから申請してください。</p>

          <div v-if="changedLines.length" class="change-request">
            <span class="block-label">予算の変更<span class="req">*</span></span>
            <p class="hint">次の明細は、金額が予算額と違います。この執行依頼と一緒に、予算の金額を執行額に直す予算の変更を申請します（ZAI の zas が承認すると予算に反映されます）。</p>
            <ul class="changed-lines">
              <li v-for="c in changedLines" :key="c.line.key">
                <span class="muted">{{ c.line.itemNumber }}</span> {{ c.line.label }}：{{ formatYen(c.line.budgetAmount) }} → {{ formatYen(c.actual) }}
              </li>
            </ul>
            <label>変更の理由<span class="req">*</span>
              <textarea v-model.trim="form.budgetChangeReason" rows="2" required placeholder="例：見積もりより値上がりしたため" />
            </label>
          </div>
        </div>
        <div class="confirm">
          <span class="block-label">以上の内容に誤りがないことを確認しましたか？<span class="req">*</span></span>
          <p class="hint">送信後の編集はできません。</p>
          <label class="check"><input v-model="confirmed" type="checkbox"> はい</label>
        </div>
        <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
        <button type="submit" :disabled="!confirmed || pending || needsApproval">{{ pending ? '送信中…' : '送信' }}</button>
      </template>
    </form>
  </section>
</template>

<style scoped>
.change-request { display: grid; gap: .4rem; margin-top: .8rem; padding-top: .8rem; border-top: 1px dashed var(--border); }
.changed-lines { margin: 0; padding-left: 1.2rem; font-size: .88rem; }
.intro { border-left: 4px solid var(--accent); padding: .5rem .9rem; font-size: .9rem; background: var(--sub); border-radius: 0 6px 6px 0; }
.intro p { margin: .3rem 0; }
.intro ul { margin: .2rem 0; padding-left: 1.4rem; }
.warn { color: var(--danger); font-weight: 600; }
.req { color: var(--danger); margin-left: .15rem; }
.section-desc { margin: 0; font-size: .9rem; color: var(--muted); }
.block { display: grid; gap: .4rem; }
.block-label { font-size: .9rem; }
.confirm { display: grid; gap: .25rem; }
.budget-change { display: grid; gap: .3rem; padding: .7rem .9rem; border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 6px; background: var(--surface); }
.budget-change.large { border-left-color: var(--danger); }
.budget-change .change { margin: 0; }
.budget-change .approval { font-weight: 600; }
label .hint { display: block; }
</style>
