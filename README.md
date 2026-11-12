# lunaria（財務管理システム）

五月祭常任委員会の財務管理システム lunaria（リポジトリ名: expenditure）。スプレッドシート「予算執行」＋ GAS（formSubmit.gs / onEdit.gs / constant.gs）で行っていた
執行依頼・証憑提出・台帳管理を Nuxt で置き換える試作です。

## 旧GASとの対応

| 旧（GAS / スプレッドシート） | 新（このアプリ） |
| --- | --- |
| 執行依頼フォーム → `onFormSubmit` | `/requests/new` → `POST /api/entries` |
| 証憑管理フォーム → `onFormSubmit`（`e.values[11][0] == "h"` で判定） | `/evidences/new` → `POST /api/evidences`（エンドポイントを分離） |
| 形態別シート・番号順・申請順に**同じ行をコピー** | `entries` テーブル1つ。一覧は `/entries?view=number\|time\|振込\|…` で切り替え |
| A列チェック → `onChange` がタイムスタンプで他シートの行を探して書き戻し | 「対応済みにする」ボタン → `POST /api/entries/:id/execute`（行は1つなので同期不要） |
| `folderTable`（Drive フォルダIDのハードコード） | 添付ファイルは委員会の共有ドライブの1つのフォルダに置き、`attachments` テーブルにリンクを持つ。フォルダIDは環境変数で1つだけ |
| `ScriptProperties` の連番（ロックなし） | `counters` テーブルを `INSERT … ON CONFLICT DO UPDATE` で原子的に採番 |
| n8n Webhook（口座情報も送信） | n8n Webhook（**口座情報は除外**、`X-Webhook-Secret` ヘッダ付き） |
| `e.values[n]`（列番号依存） | zod スキーマで設問名ベースに検証 |

### 旧GASで直っている問題
- 3か所コピーの同期ずれ（行の手修正・並べ替えでずれる）
- onEdit で対象行が見つからないと `findIndex(-1) + 2 = 1` で**見出し行を上書き**する
- 同時送信時の行の上書き・連番の重複
- フォームの設問追加で全項目がずれる

## 権限

全員がすべての申請を閲覧できます。財務局長・財務局長補佐・管理者はできることが同じで、肩書きだけが違います。財務管理部は予算の集約・査定だけができます。それ以外の委員はすべて「一般」です。

| | 一般 | 財務管理部 | 財務局長補佐 | 財務局長 | 管理者 |
| --- | :-: | :-: | :-: | :-: | :-: |
| 申請 | ○ | ○ | ○ | ○ | ○ |
| 全申請の閲覧（台帳・添付ファイル） | ○ | ○ | ○ | ○ | ○ |
| 予算の明細の入力・提出 | 割り当てられた担当 | ○ | ○ | ○ | ○ |
| 予算の集約・査定・確定 | | ○ | ○ | ○ | ○ |
| 集約の段取り | | | ○ | ○ | ○ |
| 昨年の本予算・決算の取り込み（管理者と、予算を入力する担当が ZAI の zas の人） | zas なら○ | zas なら○ | zas なら○ | zas なら○ | ○ |
| 口座情報の閲覧 | | | ○ | ○ | ○ |
| 対応済み操作・執行額などの修正 | | | ○ | ○ | ○ |
| 決算シートの出力 | | | ○ | ○ | ○ |
| 委員の登録・権限変更 | | | ○ | ○ | ○ |

- 権限の定義は `shared/roles.ts` の1か所だけ。サーバー（`requirePermission`）も画面（`usePermissions`）もここを見る。
  役割を増やしたり、財務局長・財務局長補佐・管理者でできることを分けたりするときもここを直せばよい
- 財務局長・財務局長補佐・管理者が「ユーザー」画面で、委員をメールアドレスで先に登録したり権限を変えたりする。
  登録していない人は初回ログインで「一般」として登録される。変更は再ログインなしで次の操作から効く
- `NUXT_ADMIN_EMAILS` のユーザーはログインのたびに管理者になる（最初の管理者用。画面からは変更不可）
- 財務局長・財務局長補佐・管理者が1人もいなくなる変更はできない
- 口座情報は申請後は本人にも返さない

### ログイン方式の差し替え
ログインの入口は `server/utils/auth.ts` の `loginAs(event, email, name)` だけです。
委員会のログイン制度につなぐときは、本人確認ができたところで `loginAs` を呼ぶルートを `server/routes/auth/` に追加すれば、
権限管理はそのまま使えます（今は Google OAuth と開発用ログインがこれを呼んでいます）。

## 予算の集約と査定

予算は「最新の確定した予算を写して直す」形で、このシステムの中で作る（本予算・補正予算とも）。

1. 財務管理部が「集約」で集約開始（種類と期を選ぶ）。最新の確定した予算がまるごと写る
2. 財務管理部が「局・担当と入力する人」で、各担当に入力する人を割り当てる
3. 各担当が自分の担当の明細を直す・足す・消して「提出」。財務管理部が「集約終了」で入力を締め切る（未提出は自動で提出）
4. 財務管理部が「査定開始」のあと「査定」で明細ごとに承認、または理由を付けて要修正にする（要修正だけ担当が直して出し直す）
5. すべて承認したら「確定」。予算明細が入れ替わり、執行依頼ではこの予算から選べる

本予算は写した明細を全部提出し直す。補正予算は直した明細だけが査定に回る。
CSV の取り込みは、予算が1つもないとき（公開したばかりの環境など）に最初の予算を入れるためだけに使う。

## 執行額と決算シート
- 申請時に、選んだ予算明細ごとに**実際の数量・取引先・執行額**を入れる（初期値は予算の値）。執行額の合計は申請の金額欄に自動で入る
- 財務局長・財務局長補佐・管理者は台帳の詳細で明細ごとの数量・取引先・執行額を直せる（`PATCH /api/entries/:id/items`）。全明細に執行額が入っていれば申請の金額も合計にそろう
- 台帳の「決算シートを出力（Excel）」（`GET /api/settlement.xlsx`）で、**対応済み**の申請をまとめて出力する
  - 「支出詳細」「証憑（支出）」: 決算総会に出す決算シート（MF99_決算）と同じ形（見出し・色・書式・列幅。フィルタなし）。執行した明細だけを局・担当・款ごとに並べる
  - 「執行一覧」: 対応済みの申請を明細ごとに1行ずつ
  - 仕様等は予算の取り込み時に保存した「支出」シートの行から拾う。担当者の氏名は持たないので、「担当者」の列は空になる
  - 明細が複数ある申請で執行額が未入力の明細は集計できないので、備考に「執行額未入力 n件」と出る（明細が1件なら申請の金額を使う）

### 決算シートをスプレッドシートに出力
台帳の「決算シートをスプレッドシートに出力」で、指定したスプレッドシートの「支出詳細」「証憑（支出）」「執行一覧」シートを書き直す（なければ追加。ほかのシートには触らない）。
「証憑（支出）」シートの領収書・その他証憑の列と「執行一覧」シートの証憑の列には、請求書・領収書を開くリンク（アプリへのログインが必要）が入る。Excel でのダウンロードも同じ内容。

アプリは、**出力する人自身の Google アカウント**（アプリに登録しているメールアドレス）で書き込む。
初めて書き出すとき（と、許可が切れた約1時間後）は Google の画面に移り、スプレッドシートへの書き込みを許可すると、台帳に戻って続きを書き出す。
登録しているメールアドレスと違うアカウントで許可した場合は書き込まない。出力先は、その人が編集できるスプレッドシートならどれでもよい（共有の手順は要らない）。

設定（Google ログインと同じ OAuth クライアントを使う）:

1. Google Cloud Console のプロジェクトで「Google Sheets API」を有効にする
2. 「OAuth 同意画面」のスコープに `https://www.googleapis.com/auth/spreadsheets` を足す
3. OAuth クライアントの「承認済みのリダイレクト URI」に `https://<ドメイン>/auth/google-sheets`（ローカルは `http://localhost:3000/auth/google-sheets`）を足す
4. `.env` の `NUXT_OAUTH_GOOGLE_CLIENT_ID` / `NUXT_OAUTH_GOOGLE_CLIENT_SECRET` を設定する（Google ログインを使わない場合も、スプレッドシート出力にはこの2つが要る）

OAuth 同意画面が「テスト中」のままなら、書き出す人を「テストユーザー」に足しておく。

## ローカルで動かす

Node.js 22.21 以上（または 24.11 以上）が必要です。

```bash
npm install
cp .env.example .env   # NUXT_SESSION_PASSWORD を32文字以上で設定
npm run dev
```

Google OAuth を用意していない場合は `.env` で `NUXT_PUBLIC_DEV_LOGIN=true` にすると、
ログイン画面に任意のメールでログインできるフォームが出ます（**本番では絶対に有効にしない**）。
`NUXT_ADMIN_EMAILS` に入れたメールでログインすると会計担当として扱われます。

ローカルの DB（`file:` の SQLite）は初回起動時に `server/db/migrations` から自動で作成されます（既定は `.data/app.db`）。
スキーマを変えたら `npm run db:generate` でマイグレーションを追加してください。

## Vercel + Turso へのデプロイ

1. **Turso** でデータベースを作り、URL（`libsql://…`）とトークンを用意する。Vercel のプロジェクトの「Storage」から Turso を追加してもよい（そのとき入る `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` もそのまま読むので、下の `NUXT_DATABASE_*` は要らない）
2. **Vercel** で GitHub リポジトリをインポートし、環境変数を設定する

   | 変数 | 値 |
   | --- | --- |
   | `NUXT_SESSION_PASSWORD` | 32文字以上のランダム文字列 |
   | `NUXT_DATABASE_URL` / `NUXT_DATABASE_AUTH_TOKEN` | Turso の URL / トークン |
   | `NUXT_ADMIN_EMAILS` | 最初の管理者のメール（カンマ区切り） |
   | `NUXT_N8N_WEBHOOK_URL` / `NUXT_N8N_WEBHOOK_SECRET` | 任意 |

   ログイン方法はどちらか（または両方）を設定する。

   | ログイン方法 | 変数 |
   | --- | --- |
   | テスト用（ECC メール＋合言葉） | `NUXT_PUBLIC_TEST_LOGIN=true`、`NUXT_TEST_LOGIN_CODE`（テスター用）、`NUXT_TEST_ADMIN_CODE`（管理者用）、`NUXT_PUBLIC_ENV_LABEL=テスト環境` |
   | Google（ECC アカウント） | `NUXT_PUBLIC_GOOGLE_LOGIN=true`、`NUXT_OAUTH_GOOGLE_CLIENT_ID` / `NUXT_OAUTH_GOOGLE_CLIENT_SECRET`（リダイレクト URI: `https://<ドメイン>/auth/google`） |

   `NUXT_PUBLIC_DEV_LOGIN` は**設定しない**こと（誰でも任意のメールで入れてしまう）。
3. デプロイ。ビルド時に `drizzle-kit migrate` が Turso にテーブルを作る（`vercel.json` → `npm run build:vercel`）
   - サーバーの処理は東京（`vercel.json` の `regions: ["hnd1"]`）で動かす。Turso も東京にあるので、DB とのやりとりが速い

### テスト用ログインの注意
合言葉を知っている人は、他人の ECC メールでも入れます。管理者用の合言葉で入ると、どのメールでも管理者になります（`NUXT_ADMIN_EMAILS` のメールは管理者用の合言葉でしか入れません）。
本人確認が必要な運用に入る前に、Google ログインか委員会のログイン制度に切り替えてください。

### Slack 通知（n8n）
`NUXT_N8N_WEBHOOK_URL` に、申請の受付（`created`）と対応済み（`executed`）のたびに次の JSON を POST します。

```json
{
  "event": "created",
  "entry": { "seq": "E-028", "type": "振込", "itemName": "…", "amount": 1000, "details": { … }, "items": [ … ] },
  "dm": { "email": "xxxx@g.ecc.u-tokyo.ac.jp", "text": "執行依頼を受け付けました（受付番号 E-028）。\n支出項目：…" }
}
```

- `entry`：チャンネル投稿用。口座情報と申請者のメールは含みません。
- `dm`：申請者本人への DM 用。`text` はそのまま送れる本文です（受付の控え／対応済みのお知らせ。口座情報は含みません）。
  `email` は本人が「通知設定」（ヘッダーの名前から開く）で入力した、Slack に登録しているメールです（まだ入力していない人は ECC のメール）。
  本人がその DM を受け取らない設定にしているときは `dm` が `null` になるので、n8n 側では `dm` があるときだけ DM を送ってください（IF ノード）。

n8n のワークフローには、チャンネル投稿とは別に次の2ステップを足してください。

1. **メールから Slack のユーザーを探す**：HTTP Request ノードで `GET https://slack.com/api/users.lookupByEmail?email={{$json.body.dm.email}}`（Slack アプリに `users:read.email` スコープが必要）
2. **DM を送る**：Slack ノードの「Send Message」で、送り先を **User**、ユーザーに 1. の `user.id`、本文に `{{$json.body.dm.text}}`（Slack アプリに `chat:write` スコープが必要）

メールで Slack のユーザーが見つからないこともあるので、そのノードは「On Error: Continue」にして、DM が送れなくてもチャンネル投稿は止まらないようにしてください。

### 期限切れのリマインド
`/api/cron/overdue-reminder` を1日1回呼ぶと、期限を過ぎても未対応の執行依頼を n8n の Webhook に送ります（1件もなければ送りません）。

```json
{ "event": "overdue", "text": "期限を過ぎた未対応の申請が1件あります。\n・E-024 …（振込／期限 2026-10-15・2日超過／…）\n台帳（未対応）: https://…/entries?view=pending", "overdue": [ … ], "url": "…" }
```

n8n では `event` が `overdue` のとき、`text` をそのまま Slack のチャンネルに投稿してください。

呼び出し方は次のどちらかです。合言葉が設定されていないと使えません。
- **n8n のスケジュール**：Schedule Trigger（毎朝9時など）→ HTTP Request で `GET https://<ドメイン>/api/cron/overdue-reminder`、ヘッダー `X-Cron-Secret: <NUXT_CRON_SECRET の値>`
- **Vercel の Cron**：`vercel.json` に毎日 9:00（日本時間）で設定済み。Vercel の環境変数 `CRON_SECRET` を設定すると有効になる

`?dryRun=1` を付けると、Slack には送らず送る予定の内容だけを返します（設定の確認用）。

### 添付ファイルについて
Vercel の関数は 4.5MB までしかリクエストを受け取れないため、添付は **4MB まで**。
スマホ写真は送信前にブラウザで長辺 2000px の JPEG に縮小しています（`app/composables/useSubmit.ts`）。
ファイルは委員会の共有ドライブ（Google ドライブ）のフォルダに置き、`attachments` テーブルにはファイル ID とリンクだけを持ちます。

**Google ドライブの設定**（環境変数 `NUXT_GOOGLE_DRIVE_*`。3つとも入れたときだけドライブに置き、空なら今までどおり DB に保存）
1. Google Cloud でプロジェクトを作り、Google Drive API を有効にする。
2. サービスアカウントを作り、鍵（JSON）を作る。JSON の `client_email` を `NUXT_GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL`、`private_key` を `NUXT_GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY` に入れる（改行は `
` のままでよい）。
3. 委員会の**共有ドライブ**にフォルダを作り、共有ドライブのメンバーにサービスアカウントのメールを「コンテンツ管理者」で足す（サービスアカウントは自分のドライブに容量がないので、共有ドライブでないと上げられない）。
4. フォルダの URL の末尾の ID を `NUXT_GOOGLE_DRIVE_FOLDER_ID` に入れる。
5. 前から DB にある添付は、管理者が「ユーザー」画面の「ドライブに移行」で移す。

画面からはアプリを通して開く（申請を見られる人だけ）。共有ドライブのメンバーは、証憑の横の「ドライブ」リンクからドライブで直接開ける。

## 本番に向けて残っていること
- **既存データの移行**: スプレッドシートの「執行依頼」「証憑管理」シートから `entries` への取り込みスクリプト
- **n8n 側**: 受け取る JSON の形が変わる（`{ event, entry }`）ので Slack 投稿ワークフローの修正が必要
- Nuxt は 4.5 系に固定しています（4.6.0 は Windows でビルドすると SSR の precomputed が空になり 500 になるため）
