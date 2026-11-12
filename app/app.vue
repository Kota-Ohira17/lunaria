<script setup lang="ts">
import { useMenu } from '~/composables/useMenu'

const { loggedIn, clear, fetch: refreshSession } = useUserSession()
const { user, can, roleLabel, entriesTitle } = usePermissions()
const { public: { envLabel } } = useRuntimeConfig()

// 管理者が権限を変えたときに、メニューの表示も追いつくようページ移動のたびに取り直す
const router = useRouter()
router.afterEach(() => {
  if (loggedIn.value) refreshSession().catch(() => {})
})

/** 左のメニュー（権限に応じて出し分ける）。ホームのカードも同じ一覧を使う */
const menu = useMenu()
const route = useRoute()

async function logout() {
  await clear()
  await navigateTo('/login')
}

const menuGroups = computed(() => groupMenu(menu.value))
/** いま開いている画面のメニュー（下の画面も含む。もっと長く一致するメニューがあればそちら。例：/budget/review は「査定」） */
function isActive(to: string) {
  const path = route.path
  const under = (t: string) => (t === '/' ? path === '/' : path === t || path.startsWith(`${t}/`))
  const hits = menu.value.flatMap(m => [m.to, ...(m.matches ?? [])].filter(under).map(t => ({ to: m.to, len: t.length })))
  return hits.length > 0 && to === hits.reduce((a, b) => (b.len > a.len ? b : a)).to
}
</script>

<template>
  <div class="app">
    <div v-if="envLabel" class="env-banner" role="note">
      {{ envLabel }}：本物の口座情報や個人情報は入力しないでください。
    </div>

    <header class="topbar">
      <NuxtLink to="/" class="brand">財務管理システム</NuxtLink>
      <span v-if="loggedIn" class="role-badge">{{ roleLabel }}</span>
      <div v-if="loggedIn" class="me">
        <!-- 名前・アイコンから自分の通知設定を開く -->
        <NuxtLink to="/settings" class="me-link" title="通知設定">
          <span class="me-name">{{ user?.name }}</span>
          <span class="avatar" aria-hidden="true">{{ user?.name?.slice(0, 1) }}</span>
        </NuxtLink>
        <button type="button" class="icon-button" title="ログアウト" aria-label="ログアウト" @click="logout">
          <AppIcon name="log-out" />
        </button>
      </div>
    </header>

    <div v-if="loggedIn" class="layout">
      <nav class="sidebar" aria-label="メニュー">
        <template v-for="g in menuGroups" :key="g.name">
          <span v-if="g.name" class="side-group">{{ g.name }}</span>
          <NuxtLink
            v-for="m in g.items"
            :key="m.to"
            :to="m.to"
            class="side-link"
            :class="{ active: isActive(m.to) }"
          >
            <AppIcon :name="m.icon" />
            <span>{{ m.to === '/entries' ? entriesTitle : m.label }}</span>
          </NuxtLink>
        </template>
      </nav>
      <main class="content">
        <NuxtPage />
      </main>
    </div>
    <main v-else class="content solo">
      <NuxtPage />
    </main>
  </div>
</template>
