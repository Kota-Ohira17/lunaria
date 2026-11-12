export default defineOAuthGoogleEventHandler({
  config: {
    // Google のアカウント選択画面で ECC アカウントを優先表示する（検証はサーバー側で行う）
    authorizationParams: { hd: serverConfig().allowedEmailDomain },
  },
  async onSuccess(event, { user }) {
    if (!user.email_verified || !isAllowedEmail(user.email)) {
      throw createError({ statusCode: 403, message: '許可されたドメインのアカウントでログインしてください。' })
    }
    await loginAs(event, user.email, user.name ?? user.email)
    return sendRedirect(event, '/')
  },
  onError(event, error) {
    console.error('[auth/google]', error)
    return sendRedirect(event, '/login?error=1')
  },
})
