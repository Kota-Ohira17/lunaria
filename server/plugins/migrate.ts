/**
 * ローカル開発（file: の SQLite）のときだけ、起動時にマイグレーションを流す。
 * 試験環境（Turso）はビルド時に `drizzle-kit migrate` で、Cloudflare の D1 は `npm run db:migrate:d1` で流す。
 */
export default defineNitroPlugin(async () => {
  if (d1Binding()) return
  const { url } = databaseConfig()
  if (!url.startsWith('file:')) return
  const [{ mkdir }, { resolve }, { migrate }] = await Promise.all([
    import('node:fs/promises'), import('node:path'), import('drizzle-orm/libsql/migrator'),
  ])
  await mkdir(resolve(url.slice('file:'.length), '..'), { recursive: true })
  await migrate(useDb(), { migrationsFolder: resolve(process.cwd(), 'server/db/migrations') })
})
