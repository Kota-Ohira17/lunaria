<script setup lang="ts">
/**
 * 台帳で申請を開いたときの「証憑」欄。付けた証憑の一覧と、証憑を付けるフォーム。
 * 証憑は誰でも、どの申請にも付けられる。外せるのは付けた本人と財務局長・財務局長補佐・管理者。
 */
import { EVIDENCE_KINDS, REFUND_TIMINGS } from '#shared/constants'

type Evidence = { id: number, kind: string, amount: number | null, date: string | null, uploadedBy: string, fileName: string }
const props = defineProps<{
  entry: { id: number, type: string, kind: string, amount: number | null, applicantEmail: string, details: unknown, executedAt: string | Date | null, evidences: Evidence[] }
}>()
const emit = defineEmits<{ changed: [] }>()

const { user, can } = usePermissions()
const canDelete = (e: Evidence) => e.uploadedBy === user.value?.email || can('executeEntries')
const isAdvance = computed(() => props.entry.type === '立替')
const refundTiming = computed(() => String((props.entry.details as { refundTiming?: string } | null)?.refundTiming ?? ''))

const { submit, errors, pending } = useSubmit(`/api/entries/${props.entry.id}/evidences`)
/** 立替以外は ZAI が執行済みのはずなので、執行日を日付の初期値にする（日本時間の YYYY-MM-DD） */
const executedDate = computed(() => (props.entry.executedAt
  ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(props.entry.executedAt))
  : ''))
const defaultDate = () => (isAdvance.value ? '' : executedDate.value)
const form = reactive({ kind: '領収書', amount: '', date: defaultDate(), refundTiming: refundTiming.value || '委員返金と同時' })
const file = ref<File | null>(null)
const fileInput = ref<HTMLInputElement>()
const done = ref(false)

async function onUpload() {
  done.value = false
  if (!file.value) {
    errors.value = ['証憑ファイルを選んでください。']
    return
  }
  const body = { ...form, refundTiming: isAdvance.value ? form.refundTiming : '' }
  const result = await submit(body, file.value)
  if (!result) return
  file.value = null
  if (fileInput.value) fileInput.value.value = ''
  form.amount = ''
  form.date = defaultDate()
  done.value = true
  emit('changed')
}

async function remove(e: Evidence) {
  if (!confirm(`証憑「${e.fileName}」を外します。よろしいですか？`)) return
  errors.value = []
  try {
    await $fetch(`/api/entries/${props.entry.id}/evidences/${e.id}`, { method: 'DELETE' })
    emit('changed')
  }
  catch (error) {
    errors.value = toMessages(error)
  }
}

const yen = (n: number | null) => (n == null ? '' : `¥${n.toLocaleString('ja-JP')}`)
</script>

<template>
  <div class="evidence">
    <strong>証憑（{{ entry.evidences.length }}件）</strong>
    <ul v-if="entry.evidences.length" class="files">
      <li v-for="e in entry.evidences" :key="e.id">
        <a :href="`/api/entries/${entry.id}/evidences/${e.id}`" target="_blank" rel="noopener">{{ e.fileName }}</a>
        <small class="muted">{{ e.kind }}{{ e.amount != null ? `・${yen(e.amount)}` : '' }}{{ e.date ? `・${e.date}` : '' }}</small>
        <button v-if="canDelete(e)" type="button" class="link" @click="remove(e)">外す</button>
      </li>
    </ul>
    <p v-else class="hint missing">まだ証憑が提出されていません。</p>
    <p v-if="isAdvance && refundTiming" class="hint">返金時期の希望：{{ refundTiming }}</p>

    <form class="upload" @submit.prevent="onUpload">
      <span class="block-label">証憑を提出する</span>
      <p class="hint">ファイルはPDF・JPEG・PNGのどれかで、4MBまでにしてください。<br>立替以外の場合、執行日にはZAIが執行した日付が入力されています。</p>
      <div class="fields">
        <label>種類
          <select v-model="form.kind" class="fit"><option v-for="k in EVIDENCE_KINDS" :key="k">{{ k }}</option></select>
        </label>
        <label>金額（円）<YenInput v-model="form.amount" placeholder="例：1000" /></label>
        <label>{{ isAdvance ? '立替日' : '執行日' }}<input v-model="form.date" type="date"></label>
        <label v-if="isAdvance">返金時期
          <select v-model="form.refundTiming" class="fit"><option v-for="t in REFUND_TIMINGS" :key="t">{{ t }}</option></select>
        </label>
      </div>
      <label><span>ファイル<span class="req">*</span></span>
        <input ref="fileInput" type="file" accept="application/pdf,image/jpeg,image/png" required @change="file = ($event.target as HTMLInputElement).files?.[0] ?? null">
      </label>
      <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
      <p v-if="done" class="ok">証憑を提出しました。</p>
      <button type="submit" :disabled="pending">{{ pending ? '送信中…' : '証憑を提出する' }}</button>
    </form>
  </div>
</template>

<style scoped>
.evidence { display: grid; gap: .4rem; margin-bottom: .9rem; }
.files { margin: 0; padding-left: 1.2rem; display: grid; gap: .2rem; }
.files li small { margin-left: .5rem; }
.files .link { margin-left: .6rem; font-size: .82rem; }
.missing { color: var(--danger); }
.upload { display: grid; gap: .5rem; padding: .7rem .8rem; border: 1px dashed var(--accent); border-radius: 8px; background: var(--surface); max-width: 44rem; }
.fields { display: flex; flex-wrap: wrap; gap: .6rem 1rem; align-items: end; }
.fields label { min-width: 9rem; }
.block-label { font-weight: 600; font-size: .9rem; }
.ok { color: var(--done); margin: 0; }
</style>
