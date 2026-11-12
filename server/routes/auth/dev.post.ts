import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('メールアドレスの形式で入力してください。')),
  name: z.string().trim().min(1, '氏名を入力してください。'),
  code: z.string().default(''),
})

function sameCode(input: string, expected: string) {
  const a = createHash('sha256').update(input).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * 開発・テスト用のログイン。
 * - NUXT_PUBLIC_DEV_LOGIN=true: ローカル開発用。任意のメールで入れる
 * - NUXT_PUBLIC_TEST_LOGIN=true: テスト公開用。ECC メール＋合言葉が必要。
 *   - 管理者用の合言葉（NUXT_TEST_ADMIN_CODE）で入ると、どのメールでも管理者になる
 *   - 一般用の合言葉（NUXT_TEST_LOGIN_CODE）では、今の権限のまま（初回は一般）。NUXT_ADMIN_EMAILS のメールは一般用では入れない
 * 両方 true のときはテスト公開用の制限がかかる。
 */
export default defineEventHandler(async (event) => {
  const { testLoginCode, testAdminCode, public: { devLogin, testLogin } } = serverConfig()
  if (!devLogin && !testLogin) throw createError({ statusCode: 404 })

  const { email, name, code } = parseOr400(bodySchema.safeParse(await readBody(event)))

  if (testLogin) {
    if (!isAllowedEmail(email)) {
      throw createError({ statusCode: 400, message: `@${serverConfig().allowedEmailDomain} のメールアドレスで入ってください。` })
    }
    // 合言葉が未設定のまま公開されても、誰も入れないようにする
    const asAdmin = !!testAdminCode && sameCode(code, testAdminCode)
    const asMember = !!testLoginCode && sameCode(code, testLoginCode) && !isBootstrapAdmin(email)
    if (!asAdmin && !asMember) {
      await new Promise(r => setTimeout(r, 1000)) // 総当たりを遅らせる
      throw createError({ statusCode: 401, message: '合言葉が違います。' })
    }
    await loginAs(event, email, name, { admin: asAdmin })
    return { ok: true }
  }

  await loginAs(event, email, name)
  return { ok: true }
})
