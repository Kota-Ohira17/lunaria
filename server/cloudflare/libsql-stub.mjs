// Cloudflare Workers 向けのビルドで @libsql/client の代わりに読み込む空の部品（nuxt.config.ts の alias）。
// Workers では DB に D1 を使うので libsql は呼ばれない。呼ばれたら設定の誤りなので止める。
export function createClient() {
  throw new Error('Cloudflare Workers では libsql は使えません。D1（wrangler.jsonc の DB）を設定してください。')
}
