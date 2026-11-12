<script setup lang="ts">
/**
 * DB にある添付ファイルを Google ドライブに移す（管理者だけに出す）。少しずつ移すので、なくなるまで繰り返し呼ぶ。
 */
const { data, refresh } = await useFetch('/api/attachments/drive', { default: () => ({ driveEnabled: false, inDb: 0 }) })
const moving = ref(false)
const error = ref('')
async function move() {
  if (!confirm(`DB にある添付ファイル ${data.value.inDb} 件を Google ドライブに移します。よろしいですか？`)) return
  moving.value = true
  error.value = ''
  try {
    let remaining = data.value.inDb
    while (remaining > 0) {
      const res = await $fetch<{ moved: number, remaining: number }>('/api/attachments/move-to-drive', { method: 'POST' })
      remaining = res.remaining
      data.value = { ...data.value, inDb: remaining }
      if (!res.moved) break
    }
  }
  catch (e) {
    error.value = toMessages(e).join(' / ')
  }
  finally {
    moving.value = false
    await refresh()
  }
}
</script>

<template>
  <div class="card">
    <h2>添付ファイルの置き場所</h2>
    <p v-if="!data.driveEnabled" class="hint">Google ドライブの設定（NUXT_GOOGLE_DRIVE_*）がないので、添付ファイルは DB に保存しています。</p>
    <template v-else>
      <p class="hint">新しく付けた添付ファイルは、委員会の共有ドライブのフォルダに置きます。DB に残っている添付：{{ data.inDb }}件</p>
      <ul v-if="error" class="error"><li>{{ error }}</li></ul>
      <button v-if="data.inDb" :disabled="moving" @click="move">{{ moving ? `移行中…（残り${data.inDb}件）` : 'ドライブに移行' }}</button>
    </template>
  </div>
</template>
