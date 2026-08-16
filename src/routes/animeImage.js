// 好きなアニメカード用: Wikipediaに紹介画像(サムネイル)が無かった場合の
// フォールバックとして、AniList API (GraphQL、APIキー不要、無料) から
// カバー画像を1件取ってくるためのプロキシ。
//
// Google Custom Searchの「ウェブ全体を検索」が2026年1月以降、新規に作った
// 検索エンジンでは使えなくなった(検索対象を最大50ドメインに限定する必要が
// ある)ため、そもそも汎用の画像検索より「アニメタイトル→カバー画像」に
// 特化したこちらの方が相性が良く、APIキーの発行も不要になる。
//
// 以前はJikan(MyAnimeListの非公式API)を使っていたが、Jikan公式リポジトリ
// でも報告されている既知の不具合(アニメ系エンドポイントで断続的に504が
// 出る、特にマイナーなタイトルほど起きやすい)が解消しなかったため、
// AniListに切り替えた。AniListは自前のDBを持つGraphQL APIで、Jikanのように
// リクエストの都度MyAnimeList本体へライブアクセスしにいく構造ではないため、
// 同種の不安定さが原理的に起きにくい。網羅性もMAL/Jikanと同等以上。
//
// なぜサーバー経由が必要か: ブラウザから直接AniListを叩くことも技術的には
// 可能(CORS対応)だが、リクエスト元をこちらのバックエンドに集約しておく
// ことで、AniListのレート制限をこちら側のrate-limiterで一括して守れる
// (routes/weather.js, routes/youtube.jsと同じ「外部APIをサーバー側で叩く」
// パターン)。
//
// 提供するエンドポイント:
//   GET /api/anime-image?q=<アニメタイトル>
//     -> AniListの検索結果1件目のカバー画像を { image: "https://..." } で
//        返す。ヒット無し/取得失敗は404/502でエラーを返す。
const express = require("express");
const pool = require("../db");
const router = express.Router();

const ANILIST_URL = "https://graphql.anilist.co";
const FETCH_TIMEOUT_MS = 8000;

// title(romaji/english/native)・coverImage(extraLarge > large > medium)・
// siteUrlだけを取ってくる最小限のクエリ。日本語(native)タイトルでの検索も
// 問題なくヒットする。type: ANIME固定。
const SEARCH_QUERY = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      siteUrl
      title {
        romaji
        english
        native
      }
      coverImage {
        extraLarge
        large
        medium
      }
    }
  }
`;

// 万一の断続的な障害に備えて1回だけ再試行する(遭遇頻度はJikanよりずっと
// 低い想定だが、外部APIである以上ゼロにはならないため)。429(レート制限)
// は待っても状況が変わらない可能性が高いのでリトライしない。
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeQueryKey(q) {
  return q.trim().toLowerCase();
}

// AniListに1回だけ問い合わせる。戻り値:
//   { retryable: false, status: 200, image, sourcePage, matchedTitle }  … 成功
//   { retryable: false, status: 404, message }                          … 該当なし
//   { retryable: false, status: 429, message }                          … レート制限
//   { retryable: true,  status, message }                               … 再試行する価値があるエラー(5xx/タイムアウト/network)
async function fetchFromAniList(q) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const r = await fetch(ANILIST_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: q } }),
    });

    // レスポンスがJSONでない場合(メンテナンスページなど)にr.json()が
    // そのまま例外を投げると詳細不明のエラーになるため、まずtext()で
    // 受けてから自前でJSON.parseし、失敗時は本文の先頭だけログに残して
    // 原因を追いやすくする。
    const rawBody = await r.text();
    let data = null;
    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch (parseErr) {
      console.error(
        `anime-image (anilist) non-JSON response, status=${r.status}, body head=`,
        rawBody.slice(0, 300)
      );
      return { retryable: true, status: 502, message: "AniList APIから予期しない形式のレスポンスが返されました。" };
    }

    if (r.status === 429) {
      const retryAfter = r.headers.get("retry-after");
      console.error(`anime-image (anilist) rate limited, retry-after=${retryAfter || "unknown"}`);
      return { retryable: false, status: 429, message: "AniList APIのレート制限に達しました。時間をおいて再度お試しください。" };
    }

    // AniListは検索結果が0件のとき、HTTPステータス自体を404にしてくる
    // ことがある(GraphQLのerrorsに"Not Found."が入る形)。これは取得失敗
    // ではなく単なる「該当なし」なので、他の非2xxのようにリトライ対象には
    // しない。
    if (r.status === 404) {
      return { retryable: false, status: 404, message: "画像が見つかりませんでした。" };
    }

    if (!r.ok) {
      const message = data?.errors?.[0]?.message || `AniList APIの取得に失敗しました (${r.status})`;
      console.error(`anime-image (anilist) request failed: status=${r.status} message=${message}`);
      return { retryable: true, status: 502, message };
    }

    const media = data?.data?.Media;
    if (!media) {
      return { retryable: false, status: 404, message: "画像が見つかりませんでした。" };
    }

    const image = media.coverImage?.extraLarge || media.coverImage?.large || media.coverImage?.medium || null;
    if (!image) {
      return { retryable: false, status: 404, message: "画像が見つかりませんでした。" };
    }

    const matchedTitle = media.title?.native || media.title?.romaji || media.title?.english || null;

    return {
      retryable: false,
      status: 200,
      image,
      sourcePage: media.siteUrl || null,
      matchedTitle,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("anime-image (anilist) timed out");
      return { retryable: true, status: 504, message: "AniList APIの取得がタイムアウトしました。" };
    }
    // ネットワーク自体に出られない(DNS失敗/接続拒否/サーバーのアウトバウンド
    // 制限など)場合はここに来る。err.codeにENOTFOUND/ECONNREFUSED等が入る
    // ので、サーバーのログでそれを確認すれば原因の切り分けができる。
    console.error("anime-image (anilist) error:", err.code || err.name, err.message);
    return { retryable: true, status: 502, message: "画像検索に失敗しました。時間をおいて再度お試しください。" };
  } finally {
    clearTimeout(timeout);
  }
}

// GET /api/anime-image?q=タイトル
router.get("/", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "検索キーワード(q)を指定してください。" });

  const queryKey = normalizeQueryKey(q);

  // まずキャッシュを見る。ヒットすればAniListには一切問い合わせない。
  try {
    const cached = await pool.query(
      "SELECT image, source_page, matched_title FROM anime_image_cache WHERE query_key = $1",
      [queryKey]
    );
    if (cached.rows[0]) {
      const row = cached.rows[0];
      return res.json({ image: row.image, sourcePage: row.source_page, matchedTitle: row.matched_title, cached: true });
    }
  } catch (err) {
    // キャッシュ参照に失敗してもAniListへのフォールバックは続行する(致命的
    // ではない)。
    console.error("anime-image cache lookup error:", err.message);
  }

  let result = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result = await fetchFromAniList(q);
    if (!result.retryable || attempt === MAX_ATTEMPTS) break;
    console.error(`anime-image (anilist) attempt ${attempt} failed (status=${result.status}), retrying...`);
    await sleep(RETRY_DELAY_MS);
  }

  if (result.status === 200) {
    // 成功時のみキャッシュする。失敗結果をキャッシュすると、AniList側が
    // 復旧した後もずっとエラーを返し続けてしまうため。
    try {
      await pool.query(
        `INSERT INTO anime_image_cache (query_key, image, source_page, matched_title)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (query_key) DO UPDATE SET
           image = excluded.image,
           source_page = excluded.source_page,
           matched_title = excluded.matched_title,
           created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        [queryKey, result.image, result.sourcePage, result.matchedTitle]
      );
    } catch (err) {
      console.error("anime-image cache write error:", err.message);
    }
    return res.json({ image: result.image, sourcePage: result.sourcePage, matchedTitle: result.matchedTitle });
  }

  res.status(result.status).json({ error: result.message });
});

module.exports = router;
