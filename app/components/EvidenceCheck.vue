<script setup lang="ts">
/**
 * 台帳で申請を開いたときの「証憑の確認」欄。
 * 対応済みで証憑が付くと確認待ちになり、財務局長・財務局長補佐・管理者が確認する（確認済み → 完了）か、理由を付けて差し戻す。
 * 差し戻した理由はだれにでも見える。証憑を付け直すと、また確認待ちになる。
 */
const props = defineProps<{
  entry: { id: number, status: string, evidenceCheckedAt: string | Date | null, evidenceReturnComment: string }
  hasEvidence: boolean
}>()
const emit = defineEmits<{ changed: [] }>()

const { can } = usePermissions()
const comment = ref('')
const errors = ref<string[]>([])
const pending = ref(false)
const checked = computed(() => !!props.entry.evidenceCheckedAt)
const returned = computed(() => !checked.value && !!props.entry.evidenceReturnComment)

async function act(action: 'confirm' | 'return' | 'undo') {
  errors.value = []
  if (action === 'return' && !comment.value.trim()) {
    errors.value = ['差し戻しの理由を書いてください。']
    return
  }
  pending.value = true
  try {
    await $fetch(`/api/entries/${props.entry.id}/evidence-check`, { method: 'POST', body: { action, comment: comment.value } })
    comment.value = ''
    emit('changed')
  }
  catch (error) {
    errors.value = toMessages(error)
  }
  finally {
    pending.value = false
  }
}
const dateTime = (d: string | Date) => new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div v-if="entry.status === 'done'" class="check">
    <strong>証憑の確認</strong>
    <p v-if="checked" class="ok">確認済み（{{ dateTime(entry.evidenceCheckedAt!) }}）</p>
    <p v-else-if="returned" class="returned">差し戻し：{{ entry.evidenceReturnComment }}<br><small>証憑を付け直すと、また確認待ちになります。</small></p>
    <p v-else-if="hasEvidence" class="hint">確認待ち（財務局長・財務局長補佐・管理者が証憑を確認します）</p>
    <p v-else class="hint">証憑が提出されると、確認待ちになります。</p>

    <div v-if="can('executeEntries') && hasEvidence" class="actions">
      <template v-if="checked">
        <button type="button" class="secondary" :disabled="pending" @click="act('undo')">確認の取り消し</button>
      </template>
      <template v-else-if="!returned">
        <input v-model="comment" class="comment" placeholder="差し戻しの理由（差し戻しのときは必須）">
        <button type="button" :disabled="pending" @click="act('confirm')">確認済み</button>
        <button type="button" class="secondary" :disabled="pending" @click="act('return')">差し戻し</button>
      </template>
    </div>
    <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
  </div>
</template>

<style scoped>
.check { display: grid; gap: .4rem; margin-bottom: 1rem; }
.check p { margin: 0; }
.ok { color: var(--done); font-weight: 600; }
.returned { color: var(--danger); font-weight: 600; white-space: pre-wrap; }
.returned small { font-weight: 400; color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.comment { flex: 1 1 16rem; }
</style>
