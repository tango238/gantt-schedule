# デプロイ手順書

Schedule を Cloudflare にデプロイして社内で使い始めるまでの手順です。Cloudflare を初めて使う人でも、上から順に実行すれば動くように書いています。

**この手順書のコマンドのうち、実際に実行して確かめたのは次のものだけです** (開発中はローカルのみで、本番へのデプロイは一度もしていません)。

- `pnpm run deploy --dry-run` (ビルド + `wrangler deploy --dry-run`)
- `wrangler d1 migrations apply schedule --local`
- ローカルでの動作 (`wrangler dev` でビルド済み成果物を起動し、CSP のもとで全画面を操作)

`wrangler login` / `wrangler d1 create` / `--remote` を付けたコマンド / `wrangler secret put` / 本番への `deploy` は未実行です。コマンドの書式は 2026-11-12 時点の Cloudflare 公式ドキュメントで確認しました (URL は各所に記載)。

## 1. 前提

- Cloudflare アカウント (無料プランで足ります)
- Google アカウント (Google Cloud でログイン用の OAuth クライアントを作るため)
- Node.js 22.13 以上、pnpm
- このリポジトリを取得して `pnpm install` 済み

Wrangler (Cloudflare の CLI) は `pnpm install` で入ります。以降は `pnpm exec wrangler ...` (または `npx wrangler ...`) で実行します。

最初に Cloudflare へログインします (ブラウザが開きます)。

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami   # ログインできたか確認
```

(`wrangler login` / `whoami` の書式: https://developers.cloudflare.com/workers/wrangler/commands/general/)

### 無料プランで動く構成と、課金について

この構成は Workers + D1 + Durable Objects (SQLite バックエンド) + 静的ファイル配信だけで、すべて無料プランの範囲で使えます。Durable Objects は無料プランでは SQLite バックエンドのものだけ作れ、このアプリは SQLite バックエンド (`new_sqlite_classes`) を使っています。

無料プランの上限 (2026-11-12 に各ページで確認):

| 対象 | 無料プランの上限 | 出典 |
| --- | --- | --- |
| Workers のリクエスト | 100,000 回/日、CPU 時間 10 ミリ秒/回 | https://developers.cloudflare.com/workers/platform/pricing/ |
| 静的ファイルの配信 | 無料・無制限 (Workers Caching を有効にしている場合を除く) | 同上 |
| D1 | 読み取り行数 500 万行/日、書き込み行数 10 万行/日、ストレージ合計 5 GB | https://developers.cloudflare.com/d1/platform/pricing/ |
| D1 の 1 データベースあたりの最大サイズ | **500 MB** (無料プラン。有料は 10 GB) | https://developers.cloudflare.com/d1/platform/limits/ |
| Durable Objects | リクエスト 100,000 回/日、実行時間 13,000 GB-s/日、SQLite の読み取り 500 万行/日・書き込み 10 万行/日、SQLite 保存 5 GB (合計) | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Workers Logs (`observability`) | ログイベント 200,000 件/日、保持 3 日。**この料金体系は 2026-12-01 までの記載で、それ以降は変わる** (同ページの注記) ので、デプロイ時に最新を確認してください | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ |

### このアプリの容量の目安 (D1 の 500 MB)

- 1 スケジュールは、本体が最大 1 MB、バージョン (手動 10 + 自動 10 = 最大 20 件、各最大 1 MB) を含めて **最大で約 21 MB** です。
- **論理削除したスケジュールとそのバージョンも、削除しても容量を使い続けます** (復元できるよう残すため。物理削除の機能はありません)。
- 通常のスケジュール (数十〜数百タスク、本体 数 KB〜数十 KB) なら、バージョンを含めても 1 件あたり数百 KB 以下で、数千個入る見込みです (見積もりで、本番では未計測)。
- 上限に達すると、書き込みが失敗します (課金はされません)。容量が心配になったら、手順 6 のバックアップを取ったうえで、有料プラン (10 GB) へ切り替えるか、不要な古いデータの整理を検討してください。

補足 (いずれも上記ページで確認):

- **無料プランで上限に達したときは、課金ではなく、その種類の操作がエラーになります** (D1 は「daily limits exceeded」のエラーを返す、Durable Objects は「further operations of that type will fail with an error」)。日次の上限は 00:00 UTC (日本時間 9:00) にリセットされます。
- 有料プラン (Workers Paid) は月額 $5 から。**無料プランのままなら課金は発生しません。** 自分で有料プランに切り替えない限り請求されません。有料プランでは含まれる量を超えた分が従量課金です (リクエストは 1,000 万回/月を含み、超過は 100 万回あたり $0.30 など)。
- Durable Objects への WebSocket の受信メッセージは 20 件で 1 リクエストとして数えられます (同ページ)。同時編集の通信量が多いと DO のリクエスト枠を消費します。

### 無料プランの CPU 時間 (10 ミリ秒/回) の制約

無料プランは Workers の CPU 時間が 1 リクエストあたり 10 ミリ秒です。このアプリの処理時間は、スケジュールのデータ (doc) の大きさにほぼ比例します。開発中に、レビュー担当者が M 系 Mac のローカル環境で実測した値は次のとおりです (本番の Cloudflare 上では未測定です)。

- 約 1.02 MB・2,800 タスクの doc で、1 コマンドの適用 (Durable Object) が 83〜87 ミリ秒、JSON インポート (Worker) が 83 ミリ秒
- doc サイズにほぼ比例するとして、100 KB では約 8 ミリ秒の見積もり

したがって、**数百タスク (100 KB 程度) までは無料プランの目安に収まる見込みです。それを超える大きなスケジュールや大きな JSON のインポートは、CPU 時間超過のエラーになり得ます。** その場合は Workers Paid (月額 $5〜) に切り替えてください。なお、Durable Object のリクエストに無料プランの 10 ミリ秒が適用されるかどうかは、上記の公式ページの記述からは確定できませんでした (適用されるものとして見積もっています)。

## 2. D1 データベースを作る

```sh
pnpm exec wrangler d1 create schedule --binding DB --update-config
```

(書式: https://developers.cloudflare.com/d1/wrangler-commands/ 。`--binding` と `--update-config` は現行 wrangler の `d1 create --help` に載っています。)

`--binding DB` を付けることで、対話の質問に答える必要がなく、`wrangler.jsonc` の既存の `DB` エントリの `database_id` が自動で書き換わります (wrangler 4.160 のソースで確認: 同じ binding 名のエントリがあれば、その内容を上書きマージします)。付けずに実行すると「設定に追加するか」「バインディング名は」と聞かれ、既定のバインディング名が DB 名 (`schedule`) なので、`DB` とは別のエントリが追加されてしまいます。

実行後、`wrangler.jsonc` の `d1_databases` が **1 エントリだけ**で、`binding` が `"DB"`、`database_id` が表示された UUID になっていることを確認してください。`migrations_dir` も残っているはずです。

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "schedule",
    "database_id": "（表示された UUID）",
    "migrations_dir": "migrations"
  }
]
```

もし `schedule` という別のエントリが増えていたら削除し、`DB` のほうの `database_id` を手で書き換えてください。`--update-config` が効かなかった場合も同様に、`d1 create schedule` の出力に表示された `database_id` を手で書き写します (質問が出たら `n` と答える)。この `--binding DB --update-config` の挙動は、実際のアカウントでは未実行です (リモートの操作のため)。

次に、本番の D1 にテーブルを作ります (マイグレーションの適用)。

```sh
pnpm run db:migrate:remote
# 中身: wrangler d1 migrations apply schedule --remote
```

適用前に確認が出るので `y` で進めます。適用後は D1 のバックアップが自動で取られます。途中で失敗したマイグレーションはロールバックされます (上記ドキュメントより)。

## 3. Google の OAuth クライアントを作る

Google Cloud Console (https://console.cloud.google.com/) で、ログイン用の OAuth クライアントを作ります。画面の名称は Google 側の変更で変わることがあります。

1. プロジェクトを作成 (または既存のものを選択) します。
2. **同意画面の設定** (「Google Auth Platform」→「ブランディング」。公式: https://developers.google.com/workspace/guides/configure-oauth-consent)
   - アプリ名、ユーザーサポートメール、連絡先メールを入力します。
   - **ユーザーの種類 (対象)** を選びます。
     - **内部**: 自分の Google Workspace 組織のアカウントだけがログインできます。
     - **外部**: どの Google アカウントでもログインできます (状態が「テスト中」だと、登録したテストユーザーだけです。本番運用では「本番環境」に公開してください)。
     - **管理画面の「例外アドレス」で Workspace 外のアカウント (個人の Gmail や他社のアドレスなど) を許可したい場合は、同意画面を「外部」にする必要があります。** 「内部」のままだと、Google 側が Workspace 外のアカウントのログインを拒否するので、例外アドレスに登録しても入れません。自社ドメインのアカウントだけで使うなら「内部」で構いません。
     - (「内部/外部」の定義と、「テスト中」のテストユーザー制限は Google のヘルプによる一般的な仕様で、この手順書の作成時には公式ページで再確認できていません。画面の説明を読んで選んでください。)
   - スコープは `openid`、`email`、`profile` だけです (これらは追加の審査が不要な基本スコープです)。
3. **OAuth クライアント ID を作成** (「クライアント」→「クライアントを作成」。公式: https://developers.google.com/identity/protocols/oauth2/web-server)
   - アプリケーションの種類: **ウェブ アプリケーション**
   - **承認済みのリダイレクト URI**: `https://<ホスト>/auth/callback`
     - `<ホスト>` はデプロイ後のホスト名です。`workers.dev` のままなら `https://schedule.<あなたのサブドメイン>.workers.dev/auth/callback`、カスタムドメインを使うなら `https://schedule.example.com/auth/callback` のようになります。ホスト名は手順 5 の後でないと分からないことがあるので、後から追加しても構いません。
     - 一致は厳密です (スキーム・大文字小文字・末尾のスラッシュまで)。ワイルドカードは使えません。
     - ローカルで試すなら `http://localhost:<ポート>/auth/callback` も追加できます (localhost だけは http が許されます)。
   - 作成後に表示される **クライアント ID** と **クライアント シークレット** を控えます (シークレットはこのときしか表示されません)。

## 4. 環境変数とシークレットを設定する

| 名前 | 種別 | 意味・書式 |
| --- | --- | --- |
| `ALLOWED_DOMAINS` | `wrangler.jsonc` の `vars` | ログインを許可するメールのドメイン。カンマ区切りで複数可 (例: `example.com,example.org`)。サブドメインは別扱い (`example.com` は `a.example.com` を含みません)。あわせて、Google が返す Workspace の組織ドメイン (`hd`) もこの一覧に含まれている必要があります (セカンダリドメインのアドレスを使う場合は、プライマリドメインとセカンダリドメインの両方を書きます)。Workspace に属さない個人の Google アカウントは、ドメインが一致しても入れません (例外アドレスで許可します)。空だとドメインでは誰も入れません。 |
| `ADMIN_EMAILS` | `wrangler.jsonc` の `vars` | 管理者のメールアドレス。カンマ区切りで複数可。管理者は管理画面を使え、ドメイン外のアドレスでもログインできます。 |
| `GOOGLE_CLIENT_ID` | シークレット | 手順 3 のクライアント ID |
| `GOOGLE_CLIENT_SECRET` | シークレット | 手順 3 のクライアント シークレット |
| `DEV_LOGIN_EMAIL` | **本番には設定しない** | ローカル開発用ログイン。`.dev.vars` にだけ書く |

`ALLOWED_DOMAINS` と `ADMIN_EMAILS` は `wrangler.jsonc` の `vars` を編集します。

```jsonc
"vars": {
  "ALLOWED_DOMAINS": "example.com",
  "ADMIN_EMAILS": "you@example.com"
}
```

(英字は小文字・大文字を区別せず、前後の空白は無視されます。)

シークレット (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) は、**次の手順 5 の最初のデプロイの後**に `wrangler secret put` で登録します (理由は手順 5)。

**`DEV_LOGIN_EMAIL` を本番に設定してはいけません。** 設定されていても localhost 系のホスト名でしか有効になりませんが (多重防御)、`wrangler.jsonc` の `vars` にも `wrangler secret put` にも書かないでください。ローカルの `.dev.vars` (git 管理外) にだけ書きます。`.dev.vars` はデプロイされません。

`wrangler.jsonc` の `observability` は有効にしてあります (手順 6 のログ参照)。無料枠の条件は 2026-12-01 から変わるので、不要なら `false` にしてください。

## 5. デプロイする

```sh
pnpm run deploy
```

`pnpm run deploy` はビルド (型検査 + Vite) のあと `wrangler deploy` を実行します (`pnpm deploy` は pnpm 自身の別コマンドなので、必ず `run` を付けます)。成功すると `https://schedule.<サブドメイン>.workers.dev` の URL が表示されます。この時点ではシークレット未設定なので、ログインを試すと「Google ログインが設定されていません。」と出ます (正常です)。初めて Workers を使うアカウントでは、`workers.dev` のサブドメインを決める案内が出ることがあります。

`migrations/` に未適用のファイルがある更新では、**デプロイの前に** `pnpm run db:migrate:remote` を実行してください (新しいコードが新しい表を使うため)。**マイグレーションがある更新は、必ず `pnpm run db:migrate:remote` → `pnpm run deploy` の順です。逆にすると、新しいコードが存在しない表を読み、一覧と各スケジュールが 500 になります**。デプロイ前から開いていた古いタブは、コメントの通知を受け取っても無視するだけで切断はされませんが、コメントや担当は表示されません。

再デプロイしたあとは、開いたままのタブを再読み込みしてください (古い画面のままだと、新しい種類のデータ (カテゴリなど) を表示できないことがあります)。

デプロイせずに確認だけしたいときは `pnpm run deploy --dry-run` です (ビルドして、アップロード内容とバインディングを表示して終了します。ここで D1 / Durable Object / ASSETS と 2 つの vars が並ぶのを確認できます)。

### シークレットの登録 (最初のデプロイの後)

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
```

値の入力を求められます (画面にも履歴にも残りません)。書式: https://developers.cloudflare.com/workers/wrangler/commands/workers/

- **デプロイの前に実行しないでください。** Worker がまだ存在しない状態で実行すると、wrangler (4.160 のソースで確認) が「"schedule" という Worker は無いようです。新しく作ってシークレットを追加しますか?」と確認します。`y` と答えれば進めますが、手順が分かりにくくなります。先にデプロイしておけば、この確認は出ません。
- `secret put` は、新しいバージョンを作ってすぐにデプロイします (公式ページの記述)。**登録のあとに再デプロイは不要**です。以降の `pnpm run deploy` でもシークレットは保持されるはずです (Cloudflare の通常の挙動ですが、この環境では未確認)。

手順 3 のリダイレクト URI を、この URL (`https://<ホスト>/auth/callback`) で登録するのを忘れずに。

### カスタムドメイン (任意)

自社のドメインを Cloudflare に登録済み (ゾーンがある) なら、`schedule.example.com` のようなホスト名で配信できます (https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

- ダッシュボード: Workers & Pages → `schedule` → Settings → Domains & Routes → Add → Custom Domain
- または `wrangler.jsonc` に追記して再デプロイ:
  ```jsonc
  "routes": [{ "pattern": "schedule.example.com", "custom_domain": true }]
  ```

そのホスト名が既に CNAME レコードで使われていると設定できません。HTTPS を強制する HSTS (Strict-Transport-Security) は、アプリのコードでは付けていません。必要なら Cloudflare のダッシュボード (対象ゾーンの SSL/TLS → Edge Certificates → HTTP Strict Transport Security) で有効にできます (設定画面の名称は未確認)。カスタムドメインにしたら、Google のリダイレクト URI もそのホスト名で追加してください。

### 初回ログインと動作確認チェックリスト

- [ ] `https://<ホスト>/` を開くと「Google でログイン」が出る (「開発用ログイン」は出ない)
- [ ] `ADMIN_EMAILS` のアカウントでログインでき、ヘッダーに「管理」が出る
- [ ] 許可ドメイン内の別アカウントでログインでき、「管理」は出ず `/admin` は「権限がありません」になる
- [ ] 許可ドメイン外のアカウントは「このアカウントではログインできません」になる
- [ ] 管理画面で、そのドメイン外アカウントを例外アドレスに追加すると、ログインできる (同意画面が「外部」であること)。例外から削除すると、次のアクセスでログアウトされる
- [ ] スケジュールを新規作成し、2 つのブラウザ (別アカウント) で同じスケジュールを開いて同時に編集すると、互いに反映される。接続中のユーザーが表示される
- [ ] 「バージョンを保存」→ 一覧に出る →「このバージョンに戻す」で戻る
- [ ] AI ペイン: 設定でキーを入れ、指示を出すと差分プレビューが出て「適用」できる
- [ ] スケジュールを削除し、管理画面の「削除済みスケジュール」から復元できる
- [ ] ブラウザの開発者ツールの Console に、`Refused to ...` (CSP 違反) が出ていない

## 6. 運用

### 許可ドメイン・管理者を変える

`wrangler.jsonc` の `vars` (`ALLOWED_DOMAINS` / `ADMIN_EMAILS`) を編集し、`pnpm run deploy` で再デプロイします。管理画面からは変えられません (管理画面には現在の値が読み取り専用で表示されます)。変更は次のアクセスから反映され、許可されなくなったユーザーはそのアクセスでログアウトされます。

### 例外アドレスの管理

管理者が `/admin` の「例外アドレス」で追加・削除します (再デプロイ不要)。追加しても、同意画面が「内部」だと Workspace 外のアカウントは Google 側で拒否されます (手順 3)。例外から消されたユーザーは、次の API アクセスで失効します。WebSocket (同時編集) 接続中のユーザーは、最大 60 秒遅れて切断されます。

### 削除済みスケジュールの復元

ユーザーが削除したスケジュールは論理削除で、データは残っています。管理者が `/admin` の「削除済みスケジュール」で「復元」すると一覧に戻ります。完全削除 (物理削除) の機能はありません。

### マイグレーションを追加するとき

1. `migrations/` に `0002_xxx.sql` のように連番でファイルを追加する (適用済みのファイルは書き換えない)
2. ローカルで確認: `pnpm db:migrate:local`
3. 本番へ: `pnpm run db:migrate:remote` (適用前に確認が出て、適用後にバックアップが取られる)
4. その後に `pnpm run deploy` (テーブルを使う新しいコードは、マイグレーションの後に出す)

Durable Object のクラスを追加・改名・削除するときは、`wrangler.jsonc` の `migrations` に新しい `tag` を追記します (既存の `v1` は変更しない)。

### 以前の版に戻すときの注意

マイルストーン (`kind: "milestone"`) を含むスケジュールは、この版より前のコードに戻すと編集できなくなります (読み込み・保存の検証で弾かれます。データは残るので、新しい版に戻せば元どおり開けます)。同様に、状態 (`status`)・担当 (`assigneeIds`)・コメントの表 (`task_comments`) は古い版では表示されません。ロールバックは、これらのデータが作られていないことを確かめてから行ってください。

### ログの見方

- リアルタイム: `pnpm exec wrangler tail` (`--format pretty`、`--status error` でエラーだけに絞れる。https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- 過去: ダッシュボードの Workers & Pages → `schedule` → Observability (Workers Logs。無料プランは 200,000 件/日・3 日保持。2026-12-01 以降の料金体系は公式ページで要確認)

### バックアップ

- **D1 のエクスポート** (SQL ファイル): 
  ```sh
  pnpm exec wrangler d1 export schedule --remote --output=./backup.sql
  ```
  エクスポート中は他のデータベースへのリクエストがブロックされます (https://developers.cloudflare.com/d1/best-practices/import-export-data/)。利用の少ない時間に実行してください。マイグレーション適用時にも自動でバックアップが取られます。
- **JSON エクスポート**: 各スケジュールを画面の「JSON エクスポート」でダウンロードできます。重要なスケジュールは定期的に取っておくと、JSON インポートで別のスケジュールとして戻せます。
- バージョン機能 (スケジュールごとに手動 10 件・自動 10 件) もスナップショットですが、同じ D1 の中にあるので、DB 全体のバックアップの代わりにはなりません。

## 7. 既知の制約と未確認事項

**未確認 (動かして確かめていないこと)**

- **Google の実ログインは、開発中に一度も実行していません。** 開発用ログインと、ID トークン検証・許可判定の単体テストでの確認のみです。最初のログインで問題が出たら、リダイレクト URI の一致・クライアント ID/シークレット・同意画面の設定を確認してください。
- **本番の Cloudflare 上での動作は未確認です。** ローカル (`vite dev` と、ビルド済み成果物の `wrangler dev`) でのみ確認しています。D1・Durable Objects・静的ファイルの上限や、無料プランの CPU 時間 (10 ミリ秒/回) が実運用で足りるかも未確認です。
- **AI は、Gemini のみ実際の API で確認しました。Anthropic と OpenAI は模擬応答 (ブラウザの通信を差し替えたテスト) での確認だけで、実 API では未確認です。**
- **無料プランの CPU 時間 (10 ミリ秒/回) が、本番の Cloudflare 上でどうなるかは未測定です** (上記の数値はローカルでの実測のみ)。
- 画面のプロフィール画像 (Google の `picture`) は、開発用ログインには無いので、CSP の `img-src` を含めて実表示を確認していません。
- Safari など Chrome 以外のブラウザでは確認していません (CSP の `connect-src 'self'` が同一オリジンの WebSocket (`wss:`) を許すかどうかは、古い Safari で挙動が違う可能性があります)。

**仕様上の制約**

- WebSocket で接続中のユーザーの権限失効 (例外アドレスの削除、許可ドメインの変更) は、最大 60 秒遅れます。
- 同時編集は「コマンド単位の到着順」です。同じ項目を同時に編集すると後から届いたほうが勝ちます (文字単位のマージはしません)。
- Undo/Redo はありません。誤操作は、バージョンへの復元で戻します。
- スケジュールのデータ上限は 1 MB です。
- 切断中は読み取り専用で、オフライン編集のキューはありません。
- 完全削除 (物理削除) はありません。
