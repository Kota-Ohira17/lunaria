<script setup lang="ts">
/**
 * 決算シートの出力（財務局長・財務局長補佐・管理者）。Google スプレッドシートへの書き出しと Excel のダウンロード。
 * スプレッドシートには、出力する人自身の Google アカウント（登録しているメールアドレス）で書き込む。
 * まだ Google の許可がなければ /auth/google-sheets で許可をもらい、戻ってきたら続けて書き出す。
 * 書き出し先の URL はこのブラウザに覚えておく。
 */
const STORAGE_KEY = 'settlement-spreadsheet-url'
/** Google の許可をもらいに行く前に立てておき、戻ってきたら書き出しを続ける */
const PENDING_KEY = 'settlement-export-pending'

const route = useRoute()
const router = useRouter()
const open = ref(false)
const url = ref('')
const pending = ref(false)
const errors = ref<string[]>([])
const result = ref<{ url: string, sheets: { name: string, rows: number }[] }>()
const { data: config } = await useFetch('/api/settlement/sheets-config', { lazy: true })

const storage = {
  get: (key: string) => { try { return localStorage.getItem(key) } catch { return null } },
  set: (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* 保存できない環境では毎回入力 */ } },
  remove: (key: string) => { try { localStorage.removeItem(key) } catch { /* 同上 */ } },
}

onMounted(() => {
  url.value = storage.get(STORAGE_KEY) ?? ''
  // Google の許可の画面から戻ってきたとき
  const back = route.query.sheets
  if (!back) return
  open.value = true
  const resume = storage.get(PENDING_KEY) === '1'
  storage.remove(PENDING_KEY)
  router.replace({ query: { ...route.query, sheets: undefined } })
  if (back === 'wrong-account') errors.value = [`登録しているメールアドレス（${config.value?.email ?? ''}）の Google アカウントで許可してください。`]
  else if (back === 'error') errors.value = ['Google の許可をもらえませんでした。もう一度試してください。']
  else if (back === 'connected' && resume && url.value) exportToSheets({ afterAuth: true })
})

/** afterAuth: Google の許可から戻った直後（ここでまた許可を求められたら、行ったり来たりしないよう止める） */
async function exportToSheets({ afterAuth = false } = {}) {
  errors.value = []
  result.value = undefined
  pending.value = true
  storage.set(STORAGE_KEY, url.value)
  try {
    result.value = await $fetch<{ url: string, sheets: { name: string, rows: number }[] }>('/api/settlement/sheets', {
      method: 'POST',
      body: { spreadsheetUrl: url.value },
    })
  }
  catch (error) {
    // Google の許可がない・切れたときは、許可の画面に移る（戻ってきたら続きを書き出す）
    if (!afterAuth && (error as { data?: { data?: { needsGoogleAuth?: boolean } } }).data?.data?.needsGoogleAuth) {
      storage.set(PENDING_KEY, '1')
      window.location.href = '/auth/google-sheets'
      return
    }
    errors.value = toMessages(error)
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="export">
    <div class="buttons">
      <button type="button" @click="open = !open">決算シートをスプレッドシートに出力</button>
      <a class="button secondary" href="/api/settlement.xlsx" download>Excelでダウンロード</a>
    </div>

    <form v-if="open" class="card panel" @submit.prevent="exportToSheets()">
      <p class="hint">
        対応済みの申請と確認済みの収入をまとめて、指定したスプレッドシートの「支出詳細」「証憑（支出）」「執行一覧」「収入詳細」シートに書き出します（なければ追加、あれば書き直し。ほかのシートはそのまま）。
        「支出詳細」「証憑（支出）」は、決算総会に出す決算シートと同じ形です。「証憑（支出）」シートから、明細ごとの領収書などを開けます。
      </p>
      <template v-if="config && !config.configured">
        <p class="error">スプレッドシートに書き出すための Google の設定がされていません。</p>
      </template>
      <template v-else-if="config">
        <p class="share">
          あなたの Google アカウント（<code>{{ config.email }}</code>）で書き込みます。このアカウントで編集できるスプレッドシートを指定してください。
          <template v-if="!config.connected">初めて書き出すときや、しばらく時間がたったときは、Google の画面で書き込みを許可してください。</template>
        </p>
        <label>出力先のスプレッドシートの URL
          <input v-model.trim="url" type="url" placeholder="https://docs.google.com/spreadsheets/d/…" required>
        </label>
        <ul v-if="errors.length" class="error"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
        <p v-if="result" class="ok">
          書き出しました（{{ result.sheets.map(s => `${s.name} ${s.rows}行`).join('、') }}）。
          <a :href="result.url" target="_blank" rel="noopener">スプレッドシートを開く</a>
        </p>
        <button type="submit" :disabled="pending || !url">{{ pending ? '書き出し中…' : '書き出す' }}</button>
      </template>
    </form>
  </div>
</template>

<style scoped>
.export { display: grid; gap: .5rem; justify-items: end; }
.buttons { display: flex; flex-wrap: wrap; gap: .5rem; justify-content: flex-end; }
.panel { max-width: 40rem; width: 100%; display: grid; gap: .6rem; justify-items: stretch; }
.panel p { margin: 0; }
.share code { font-size: .85em; background: var(--bg); padding: .3em; border-radius: 3px; overflow-wrap: anywhere; }
.ok { color: var(--done); }
</style>
