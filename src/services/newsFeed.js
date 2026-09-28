// src/services/newsFeed.js
//
// 日本語ニュースパネル。Google NewsのRSSフィード(認証不要・無料)を定期的に
// ポーリングし、まだ見ていない記事を news_items テーブルに保存したうえで、
// 既存の /ws (src/ws.js の broadcast) を通じて全クライアントへ即座に配信する。
//
// 以前はAPITube News API(有料/APIキー必須)を使っていたが、キー未設定だと
// 機能ごと無効になってしまっていたため、キー不要のGoogle News RSSに乗り換えた。
// パイプライン(DB保存 → WebSocketブロードキャスト → フロントのnews-panel/
// 速報ポップアップ)は変更していないので、public/app.js側の変更は不要。
//
// なぜ「クライアントが直接RSSを取得」ではなくこの形にしたか:
//   - news.google.com はブラウザからのfetchにCORSヘッダーを返さないため、
//     どのみちサーバー経由が必要。
//   - ポーリングをサーバーに集約し、新着を検知した瞬間に既存のアプリ内
//     WebSocket(ws.js)でブロードキャストする。クライアントから見れば
//     「サーバーから即座にpushされる」形になる。
//
// 画像について(重要 — 過去2回の失敗を踏まえた経緯):
//   Google News RSSには記事画像が含まれない。最初はGoogle News自身の中継
//   リンク(news.google.com/rss/articles/…)をそのままfetchしてog:imageを
//   探していたが、これは配信元記事ではなくGoogleの中継ページを読んでいた
//   だけなので画像が全く取れなかった。次にGoogle内部のbatchexecute API
//   (署名付きリクエスト)を使って実URLへ解決してからog:imageを取る方式に
//   したが、本番サーバーのIPからはブロック/失敗することがあり不安定
//   だった。どちらも「Googleの非公開の内部動作に依存する」という点で
//   壊れやすかったため、今はその依存を完全にやめ、記事タイトルから
//   ざっくり分類したカテゴリに応じて LoremFlickr(https://loremflickr.com、
//   APIキー不要のタグ指定型ストックフォトサービス)の画像URLを直接組み
//   立てるだけにしている(下のbuildStockImageUrl参照)。サーバー側で
//   何かをfetchする必要が無い — 画像自体はブラウザがimg srcとして直接
//   loremflickr.comへリクエストする — ので、Google側の変更や本番IPの
//   ブロックに影響されない。ただし実際の記事写真ではなく「それっぽい」
//   雰囲気写真である点に注意(linkはRSSのGoogle Newsリンクのまま —
//   クリックすればブラウザ上で正しく配信元記事へ飛ぶ)。
//
// 必要な環境変数(すべて省略可 — APIキーは不要):
//   NEWS_POLL_INTERVAL_MS  省略可。既定120000(2分)。RSSは軽いエンドポイント
//                           だが、あまり短い間隔で叩き続けるとGoogle側から
//                           一時的にブロックされる可能性があるため、
//                           APITube時代の45秒よりは長めにしてある。
//   NEWS_LANGUAGE_CODE     省略可。既定 "ja"(Google Newsのhlパラメータ)。
//   NEWS_COUNTRY_CODE      省略可。既定 "JP"(Google Newsのglパラメータ)。
const db = require("../db");
const { broadcast } = require("../ws");

const LANGUAGE_CODE = process.env.NEWS_LANGUAGE_CODE || "ja";
const COUNTRY_CODE = process.env.NEWS_COUNTRY_CODE || "JP";
const FEED_URL = `https://news.google.com/rss?hl=${LANGUAGE_CODE}&gl=${COUNTRY_CODE}&ceid=${COUNTRY_CODE}:${LANGUAGE_CODE}`;
const POLL_INTERVAL_MS = Number(process.env.NEWS_POLL_INTERVAL_MS) || 120000;
const FETCH_TIMEOUT_MS = 10000;
// 何件たまったらDBを間引くか。無限に溜め続けないための保険。
const MAX_STORED_ITEMS = 300;

let pollTimer = null;
let polling = false;

// --- XMLエンティティのデコード ---------------------------------------
// フル機能のXMLパーサーは依存追加が必要になるため、RSS 2.0という単純で
// 固定的な構造(<item>...</item>の繰り返し、タグ内はプレーンテキストか
// CDATA)を前提に、正規表現だけで安全に抜き出す。任意のHTML/XMLではなく
// Google News自身が生成する既知の形式が入力なので、この割り切りで十分。
function decodeXmlEntities(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripHtmlTags(str) {
  return decodeXmlEntities(str)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : null;
}

// Google Newsの記事タイトルは "見出し - 出典名" の形で来るので、末尾の
// 出典部分を切り離してタイトル単体にする(出典は別途<source>タグからも
// 取れるので、重複表示を避けるため)。
function splitTitleAndSource(rawTitle, sourceFromTag) {
  const title = decodeXmlEntities(rawTitle);
  if (sourceFromTag && title.endsWith(` - ${sourceFromTag}`)) {
    return { title: title.slice(0, -(sourceFromTag.length + 3)).trim(), source: sourceFromTag };
  }
  const idx = title.lastIndexOf(" - ");
  if (idx > 0) {
    return { title: title.slice(0, idx).trim(), source: title.slice(idx + 3).trim() };
  }
  return { title, source: sourceFromTag || "Google News" };
}

// --- タイトルからざっくりカテゴリを判定し、雰囲気写真のタグ + 表示用の
// 日本語カテゴリ名に変換 -----
// 上から順に判定して最初にマッチしたものを使う(複数キーワードを含む
// タイトルでも一つに決め打ちでよい — 完璧な分類が目的ではなく、記事の
// 空気感に近い写真が出れば十分なため)。どれにも当てはまらなければ
// 汎用の "japan, newspaper" / 「総合」にフォールバックする。
// label はニュースハブのカテゴリータブ(public/app.js openNewsHubModal内)
// で「すべて / 総合 / スポーツ / …」として使われる。
const CATEGORY_RULES = [
  { pattern: /(地震|津波|噴火|土砂|豪雨|台風|暴風|警報|避難)/, tags: ["disaster", "storm"], label: "災害・気象" },
  { pattern: /(天気|気象|猛暑|寒波|降雪|梅雨|気温)/, tags: ["weather", "sky"], label: "災害・気象" },
  { pattern: /(野球|サッカー|大谷|ワールドカップ|五輪|オリンピック|バスケ|ゴルフ|テニス|相撲|柔道|マラソン|Jリーグ|プロ野球)/, tags: ["sports", "stadium"], label: "スポーツ" },
  { pattern: /(株価|円安|円高|日銀|経済|金利|物価|インフレ|決算|株式|市場|投資)/, tags: ["business", "finance"], label: "経済" },
  { pattern: /(選挙|国会|首相|大統領|政権|政府|外交|議員|与党|野党)/, tags: ["politics", "government"], label: "政治" },
  { pattern: /(AI|人工知能|IT|半導体|スマホ|アプリ|テクノロジー|ロボット|宇宙|ロケット|サイバー)/, tags: ["technology", "computer"], label: "テクノロジー" },
  { pattern: /(事件|逮捕|容疑|殺人|強盗|詐欺|裁判|警察)/, tags: ["crime", "police"], label: "事件・司法" },
  { pattern: /(事故|火災|衝突|転落|炎上)/, tags: ["accident", "emergency"], label: "事故" },
  { pattern: /(映画|音楽|ドラマ|芸能|俳優|アイドル|ライブ|コンサート)/, tags: ["entertainment", "stage"], label: "エンタメ" },
  { pattern: /(病院|感染|ウイルス|コロナ|医療|健康|ワクチン)/, tags: ["health", "medical"], label: "健康・医療" },
  { pattern: /(学校|教育|受験|大学|入試)/, tags: ["education", "school"], label: "教育" },
  { pattern: /(飛行機|空港|航空|鉄道|新幹線|列車|道路|高速道路|フライト)/, tags: ["aviation", "transportation"], label: "交通・航空" },
];
const DEFAULT_CATEGORY_LABEL = "総合";

function categorizeTitle(title) {
  const rule = CATEGORY_RULES.find((r) => r.pattern.test(title));
  return rule ? { tags: rule.tags, label: rule.label } : { tags: ["japan", "newspaper"], label: DEFAULT_CATEGORY_LABEL };
}

// 同じ記事なら(ページを再読み込みしても)毎回同じ写真になるよう、
// idから決定的なロック番号を作る(LoremFlickrの?lockパラメータ用)。
function hashToPositiveInt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 100000;
}

function buildStockImageUrl(tags, id) {
  const lock = hashToPositiveInt(id);
  return `https://loremflickr.com/640/360/${tags.map(encodeURIComponent).join(",")}?lock=${lock}`;
}

function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

  for (const block of itemBlocks) {
    const rawTitle = extractTag(block, "title");
    const link = decodeXmlEntities(extractTag(block, "link"));
    if (!rawTitle || !link) continue;

    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const sourceFromTag = sourceMatch ? decodeXmlEntities(sourceMatch[1]) : null;
    const { title, source } = splitTitleAndSource(rawTitle, sourceFromTag);

    const guid = extractTag(block, "guid");
    const pubDateRaw = extractTag(block, "pubDate");
    const descriptionRaw = extractTag(block, "description");
    const id = String(decodeXmlEntities(guid) || link);

    let publishedAt = null;
    if (pubDateRaw) {
      const d = new Date(pubDateRaw);
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    const { tags, label } = categorizeTitle(title);
    items.push({
      id,
      title,
      summary: descriptionRaw ? stripHtmlTags(descriptionRaw) : "",
      link,
      source,
      category: label,
      imageUrl: buildStockImageUrl(tags, id),
      isBreaking: false,
      publishedAt,
    });
  }

  return items;
}

async function fetchLatestArticles() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: {
        // Google側がデフォルトのfetch UAを弾くことがあるため、それらしい
        // UAを明示的に付ける(routes/animeImage.jsと同じ対策)。
        "User-Agent": "Mozilla/5.0 (compatible; AeroSocialBot/1.0; +https://aerosocial.netaoffical.net)",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
    });
    if (!res.ok) {
      throw new Error(`Google News RSS ${res.status}`);
    }
    const xml = await res.text();
    return parseRssItems(xml);
  } finally {
    clearTimeout(timeout);
  }
}

function insertIfNew(item) {
  if (!item.title || !item.link) return false;
  const result = db.raw
    .prepare(
      `INSERT OR IGNORE INTO news_items
         (id, title, summary, link, source, category, image_url, is_breaking, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      item.id,
      item.title,
      item.summary,
      item.link,
      item.source,
      item.category,
      item.imageUrl,
      item.isBreaking ? 1 : 0,
      item.publishedAt
    );
  return result.changes > 0;
}

function trimOldItems() {
  db.raw
    .prepare(
      `DELETE FROM news_items WHERE id NOT IN (
         SELECT id FROM news_items ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?
       )`
    )
    .run(MAX_STORED_ITEMS);
}

async function pollOnce() {
  if (polling) return; // 前回のポーリングがまだ終わっていなければ重複実行しない
  polling = true;
  try {
    const articles = await fetchLatestArticles();
    // RSSは新しい順で返ってくるので、broadcastの順番も時系列に揃うよう反転する。
    const ordered = articles.slice().reverse();

    for (const item of ordered) {
      const isNew = insertIfNew(item);
      if (!isNew) continue;
      broadcast("news:new", item);
    }
    trimOldItems();
  } catch (err) {
    console.error("[newsFeed] Google News RSSの取得に失敗しました:", err && err.message);
  } finally {
    polling = false;
  }
}

// カテゴリー分類(categorizeTitle)を後から追加したため、それ以前に保存
// された既存記事は category が NULL のまま残っている。ニュースハブの
// カテゴリータブ(public/app.js)が「未分類」だらけにならないよう、
// 起動時に一度だけタイトルから再分類して埋める。
function backfillMissingCategories() {
  const rows = db.raw.prepare(`SELECT id, title FROM news_items WHERE category IS NULL`).all();
  if (!rows.length) return;
  const update = db.raw.prepare(`UPDATE news_items SET category = ? WHERE id = ?`);
  const runAll = db.raw.transaction((items) => {
    for (const row of items) {
      const { label } = categorizeTitle(row.title);
      update.run(label, row.id);
    }
  });
  runAll(rows);
  console.log(`[newsFeed] 既存記事${rows.length}件のカテゴリーを分類しました。`);
}

function startNewsFeed() {
  if (pollTimer) return; // 二重起動防止
  console.log(`[newsFeed] Google News RSS (${LANGUAGE_CODE}/${COUNTRY_CODE}) のポーリングを開始します（間隔: ${POLL_INTERVAL_MS}ms）。画像はLoremFlickrのカテゴリ別ストック写真を使用。`);
  backfillMissingCategories();
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopNewsFeed() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = { startNewsFeed, stopNewsFeed };
