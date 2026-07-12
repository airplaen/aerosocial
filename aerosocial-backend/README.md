# AeroSocial API

Express + PostgreSQL の最小構成バックエンド。JWT認証、投稿(テキスト/フライトログ/画像)、いいね、コメントに対応しています。

## ローカルでの動作確認

```bash
npm install
cp .env.example .env   # 値を編集
npm run migrate        # schema.sql を適用
npm run dev             # nodemon で起動 (http://localhost:3000)
curl http://localhost:3000/api/health
```

## API概要

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| POST | `/api/auth/register` | - | `{ callsign, name, homeBase, bio, password }` |
| POST | `/api/auth/login` | - | `{ callsign, password }` → `{ token, user }` |
| GET  | `/api/auth/me` | 必須 | 自分のプロフィール |
| GET  | `/api/posts` | 任意 | フィード取得。`?type=flight&author=CS&before=ISO日時&limit=20` |
| POST | `/api/posts` | 必須 | `multipart/form-data`: `text`, `flight`(JSON文字列), `image`(ファイル) |
| POST | `/api/posts/:id/like` | 必須 | いいねのトグル |
| GET  | `/api/posts/:id/comments` | - | コメント一覧 |
| POST | `/api/posts/:id/comments` | 必須 | `{ text }` |
| DELETE | `/api/posts/:id` | 必須(投稿者のみ) | 投稿削除(画像も削除) |
| GET  | `/api/users/:callsign` | - | 公開プロフィールと集計フライト統計 |

認証が必要なエンドポイントは `Authorization: Bearer <token>` ヘッダーを付けてください。

---

## Ubuntu Serverへの公開手順

前提: Ubuntu Server 22.04/24.04、SSHでrootまたはsudo可能なユーザーでログイン済み、独自ドメイン(例: `api.example.com`)がサーバーのグローバルIPを指すようDNS設定済み。

### 1. システム更新とアプリ専用ユーザーの作成

```bash
sudo apt update && sudo apt upgrade -y
sudo adduser --disabled-password --gecos "" aerosocial
sudo usermod -aG sudo aerosocial   # 必要なら
```

以降の作業は `su - aerosocial` で切り替えて実行することを推奨します(アプリをrootで動かさないため)。

### 2. Node.js のインストール(NodeSource経由でLTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential
node -v   # v20.x であることを確認
```

### 3. PostgreSQL のインストールとDB作成

```bash
sudo apt install -y postgresql postgresql-contrib
sudo -u postgres psql
```

psqlプロンプト内で:

```sql
CREATE DATABASE aerosocial;
CREATE USER aerosocial_app WITH ENCRYPTED PASSWORD '強力なパスワードに置き換える';
GRANT ALL PRIVILEGES ON DATABASE aerosocial TO aerosocial_app;
\q
```

PostgreSQLはデフォルトでlocalhostのみ待ち受けるので、外部公開の設定変更は不要です(そのままが安全)。

### 4. コードをサーバーに配置

ローカルからアップロードする場合(このzipを展開したフォルダから):

```bash
scp -r aerosocial-backend aerosocial@your-server-ip:/home/aerosocial/
```

または、GitHubなどにpushしてある場合:

```bash
git clone <あなたのリポジトリURL> /home/aerosocial/aerosocial-backend
```

### 5. 依存関係のインストールと設定

```bash
cd /home/aerosocial/aerosocial-backend
npm install --omit=dev
cp .env.example .env
openssl rand -hex 32   # 出力された文字列を JWT_SECRET に使う
nano .env               # DATABASE_URL, JWT_SECRET, CORS_ORIGIN を実際の値に編集
npm run migrate         # テーブル作成
```

### 6. 動作確認

```bash
node src/index.js
# 別のターミナルから
curl http://localhost:3000/api/health
```

問題なければ `Ctrl+C` で停止し、次のステップへ。

### 7. pm2でプロセス管理・自動再起動を設定

```bash
sudo npm install -g pm2
pm2 start src/index.js --name aerosocial-api
pm2 save
pm2 startup systemd    # 表示されたコマンドをそのままコピペして実行(sudoが必要)
```

これでサーバー再起動後もAPIが自動起動します。ログは `pm2 logs aerosocial-api` で確認できます。

### 8. Nginxをリバースプロキシとして設置

```bash
sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/aerosocial
```

以下の内容を保存:

```nginx
server {
    listen 80;
    server_name api.example.com;

    client_max_body_size 10M;   # 画像アップロードのため

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

有効化:

```bash
sudo ln -s /etc/nginx/sites-available/aerosocial /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 9. ファイアウォールの設定

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

### 10. HTTPS化(Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

指示に従ってメールアドレスなどを入力すると、Nginx設定が自動更新されHTTPSが有効になります。証明書は自動更新されるsystemdタイマーが登録されます(`sudo systemctl list-timers | grep certbot` で確認可能)。

### 11. フロントエンド側の接続先変更

Reactアプリ側で `window.storage` を使っていた箇所を、このAPIへの `fetch` 呼び出しに置き換えます。例:

```js
const API_BASE = "https://api.example.com/api";

async function login(callsign, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callsign, password }),
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json(); // { token, user }
}
```

取得した `token` はブラウザの `localStorage` 等に保存し(Artifacts内ではなく実サイトなので使用可)、以降のリクエストで `Authorization: Bearer <token>` を付与してください。画像付き投稿は `FormData` で `image` フィールドにファイルを入れ、`Content-Type` ヘッダーは手動で付けずブラウザに任せます。

### 12. バックアップ

```bash
# 日次バックアップの例(cronに登録)
pg_dump -U aerosocial_app -h localhost aerosocial | gzip > /home/aerosocial/backups/aerosocial_$(date +%F).sql.gz
```

`crontab -e` で `0 3 * * * /home/aerosocial/backup.sh` のように登録し、アップロード画像ディレクトリ(`uploads/`)も別途 `rsync` などで定期バックアップすることを推奨します。

### 更新のデプロイ手順(2回目以降)

```bash
cd /home/aerosocial/aerosocial-backend
git pull            # またはscpで新しいファイルを上書き
npm install --omit=dev
npm run migrate     # スキーマ変更があれば
pm2 restart aerosocial-api
```

---

## セキュリティ上の注意

- `.env` は絶対にGit管理・公開リポジトリにコミットしない
- `JWT_SECRET` は十分に長いランダム文字列にする
- アプリはroot権限で動かさない(`aerosocial` などの専用ユーザーで実行)
- 定期的に `sudo apt update && sudo apt upgrade` でOSパッケージを更新する
- 本番では `CORS_ORIGIN` を実際のフロントエンドドメインのみに限定する
