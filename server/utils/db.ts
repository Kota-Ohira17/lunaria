import { createClient } from '@libsql/client'
import { drizzle as drizzleD1 } from 'drizzle-orm/d1'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from '../db/schema'

let db: ReturnType<typeof createDb> | undefined

/**
 * DB の場所と鍵。NUXT_DATABASE_URL / _AUTH_TOKEN がなければ、Vercel で Turso を追加したときに入る
 * TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を使う（どちらもなければローカルの file:）。
 * Cloudflare Workers に載せたときは、これは使わず D1（バインディング DB）につなぐ（d1Binding）。
 */
export function databaseConfig() {
  const { databaseUrl, databaseAuthToken } = serverConfig()
  const fromTurso = databaseUrl.startsWith('file:') && process.env.TURSO_DATABASE_URL
  return fromTurso
    ? { url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN || undefined }
    : { url: databaseUrl, authToken: databaseAuthToken || undefined }
}

/** Cloudflare Workers の D1（wrangler.jsonc の d1_databases の binding "DB"）。Workers の外では undefined */
export function d1Binding() {
  return (globalThis as { __env__?: { DB?: Parameters<typeof drizzleD1>[0] } }).__env__?.DB
}

function createDb() {
  const d1 = d1Binding()
  // D1 と libsql はどちらも SQLite で、drizzle の書き方は同じ。型は libsql のものにそろえる
  if (d1) return drizzleD1(d1, { schema }) as unknown as ReturnType<typeof drizzle<typeof schema>>
  return drizzle(createClient(databaseConfig()), { schema })
}

export function useDb() {
  db ??= createDb()
  return db
}

export { schema }
