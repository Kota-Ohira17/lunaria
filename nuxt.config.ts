export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  modules: ['nuxt-auth-utils'],
  css: ['~/assets/main.css'],
  app: {
    head: {
      title: 'lunaria',
      htmlAttrs: { lang: 'ja' },
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  $development: {
    // ローカルは http なので、Secure 属性付きの Cookie を捨てるブラウザ（Safari など）でもログインできるようにする
    // @ts-expect-error password は環境変数 NUXT_SESSION_PASSWORD から入るので、ここでは cookie だけ上書きする
    runtimeConfig: { session: { cookie: { secure: false } } },
    // スマホ確認用の一時URL（Cloudflare のクイックトンネル）からのアクセスを通す
    vite: { server: { allowedHosts: ['.trycloudflare.com'] } },
  },
  runtimeConfig: {
    // 環境変数 NUXT_DATABASE_URL などで上書きする（.env.example 参照）
    databaseUrl: 'file:.data/app.db',
    databaseAuthToken: '',
    adminEmails: '',
    allowedEmailDomain: 'g.ecc.u-tokyo.ac.jp',
    n8nWebhookUrl: '',
    n8nWebhookSecret: '',
    /** 期限切れリマインド（/api/cron/overdue-reminder）を呼ぶときの合言葉。Vercel の Cron なら CRON_SECRET でもよい */
    cronSecret: '',
    // テスト用ログインの合言葉（テスター用と、NUXT_ADMIN_EMAILS の管理者用）
    testLoginCode: '',
    testAdminCode: '',
    oauth: {
      google: { clientId: '', clientSecret: '' },
    },
    /**
     * 添付ファイルを置く Google ドライブ（委員会の共有ドライブのフォルダ）。サービスアカウントで読み書きする。
     * 3つとも入れたときだけドライブに置き、空なら DB に置く（手元の開発など）。
     */
    googleDrive: {
      /** 置き先のフォルダ ID（共有ドライブの中のフォルダ。サービスアカウントを「コンテンツ管理者」で追加しておく） */
      folderId: '',
      /** サービスアカウントのメールアドレス（client_email） */
      serviceAccountEmail: '',
      /** サービスアカウントの秘密鍵（private_key。改行は 
 のままでよい） */
      serviceAccountKey: '',
    },
    public: {
      /** ローカル開発用。合言葉なしで任意のメールでログインできる */
      devLogin: false,
      /** テスト公開用。ECC メール＋合言葉でログインできる */
      testLogin: false,
      /** Google ログインのボタンを出すか（OAuth を設定したら true） */
      googleLogin: false,
      /** 画面上部に出す環境名（例: テスト環境）。空なら出さない */
      envLabel: '',
      /** 振込を対応済みにするとき、選んだ口座の横に出す銀行サイトへのリンク */
      bankLinkSmbc: 'https://www.smbc.co.jp/',
      bankLinkYucho: 'https://www.jp-bank.japanpost.jp/',
    },
  },
})
