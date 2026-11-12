/**
 * サーバーの設定（runtimeConfig）。リクエストの中なら、そのリクエストの環境変数から読む。
 * Cloudflare Workers では、秘密の値（wrangler secret）は起動時の設定には入らず、リクエストの中でしか読めないため。
 * サーバーでは useRuntimeConfig() ではなく、これを使う。
 */
export function serverConfig() {
  let event
  try {
    event = useEvent()
  }
  catch {
    event = undefined
  }
  return useRuntimeConfig(event)
}
