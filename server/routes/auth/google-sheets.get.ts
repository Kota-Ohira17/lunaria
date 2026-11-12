/**
 * 決算シートをスプレッドシートに書き出すための Google の許可（財務局長・財務局長補佐・管理者）。
 * アプリに登録しているメールアドレスの Google アカウントで、スプレッドシートへの書き込みを許可してもらい、
 * アクセストークンをセッションの secure（サーバーだけが読める）に覚えて台帳に戻る。
 * Google Cloud の OAuth クライアントに、リダイレクト URI <origin>/auth/google-sheets を足しておく。
 */
export default defineEventHandler(async (event) => {
  const me = await requirePermission(event, 'exportSettlement')
  if (!sheetsOAuthConfigured()) {
    throw createError({ statusCode: 500, message: 'Google の OAuth が設定されていません（README の「決算シートをスプレッドシートに出力」参照）。' })
  }

  return defineOAuthGoogleEventHandler({
    config: {
      scope: ['email', 'https://www.googleapis.com/auth/spreadsheets'],
      // 登録しているメールアドレスのアカウントを選んだ状態で開く
      authorizationParams: { login_hint: me.email, hd: serverConfig().allowedEmailDomain },
    },
    async onSuccess(event, { user, tokens }) {
      if (String(user.email ?? '').toLowerCase() !== me.email) {
        return sendRedirect(event, '/entries?sheets=wrong-account')
      }
      const { loggedInAt } = await getUserSession(event)
      await setUserSession(event, {
        loggedInAt,
        secure: { googleSheets: { accessToken: tokens.access_token, expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000 } },
      })
      return sendRedirect(event, '/entries?sheets=connected')
    },
    onError(event, error) {
      console.error('[auth/google-sheets]', error)
      return sendRedirect(event, '/entries?sheets=error')
    },
  })(event)
})
