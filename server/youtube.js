const { google } = require('googleapis');

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

/**
 * ユーザーが入力した文字列(チャンネルID/@ハンドル/チャンネルURL/動画URL)から
 * YouTubeチャンネルの基本情報を取得する。
 */
async function resolveChannel(input) {
  const raw = input.trim();
  let handle = null;
  let channelId = null;

  // URL形式ならパスから抜き出す
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0]?.startsWith('@')) {
      handle = parts[0];
    } else if (parts[0] === 'channel' && parts[1]) {
      channelId = parts[1];
    } else if (parts[0] === 'c' || parts[0] === 'user') {
      handle = '@' + parts[1];
    }
  } catch {
    // URLでない場合はそのまま扱う
    if (raw.startsWith('@')) {
      handle = raw;
    } else if (raw.startsWith('UC') && raw.length >= 20) {
      channelId = raw;
    } else {
      handle = raw.startsWith('@') ? raw : '@' + raw;
    }
  }

  let res;
  if (channelId) {
    res = await youtube.channels.list({
      part: ['snippet', 'contentDetails'],
      id: [channelId],
    });
  } else {
    res = await youtube.channels.list({
      part: ['snippet', 'contentDetails'],
      forHandle: handle,
    });
  }

  const item = res.data.items?.[0];
  if (!item) return null;

  return {
    id: item.id,
    handle: item.snippet.customUrl || handle,
    title: item.snippet.title,
    avatarUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null,
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
  };
}

const OFFLINE_STATUS = {
  status: 'offline',
  videoId: null,
  videoTitle: null,
  videoDescription: null,
  thumbnailUrl: null,
  scheduledStart: null,
  actualStart: null,
};

/**
 * search.list(eventType: 'live'/'upcoming') はクォータ消費が非常に大きい(100ユニット/回)。
 * チャンネル1件・5分間隔でポーリングするだけでも1日の消費が
 *   100ユニット × 2(live+upcoming) × (24時間 / 5分) = 57,600ユニット
 * となり、無料クォータ(1日10,000ユニット)をチャンネル1件だけで軽く超えてしまう。
 * クォータ切れになると以後のポーリングが全て失敗し、DBに保存済みの古いステータス
 * (「配信中」のまま等)が更新されずに残り続けてしまうのが、
 * 「配信していないのに配信中と表示される」「配信開始したのに反映されない」の主因だった。
 *
 * そのため、まず YouTube の「/channel/{id}/live」への直接アクセス(HTMLの<link rel="canonical">
 * から動画IDを読み取るだけ)でクォータを一切消費せずに「今何か配信/配信直前のものがあるか」を判定し、
 * 見つかった場合だけ videos.list(1ユニット)で裏取りする。これにより1回のチェックが
 * 実質0〜1ユニットまで下がり、短い間隔で頻繁にポーリングしても枯渇しない。
 */
async function fetchLiveCandidateVideoId(channelId) {
  const res = await fetch(`https://www.youtube.com/channel/${channelId}/live?hl=ja`, {
    redirect: 'follow',
    headers: {
      // 素のUAだとYouTube側が簡易ページを返すことがあるため、通常ブラウザのUAを付与する
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})">/.exec(html);
  return m ? m[1] : null;
}

/**
 * 指定チャンネルの「現在ライブ中」または「まもなく/待機中の配信」を確認する。
 * クォータを消費しない /live リダイレクトの裏取りを videos.list(1ユニット)で行うのが基本経路。
 */
async function checkChannelBroadcasts(channelId) {
  // /live ページの取得に失敗した場合(一時的なネットワーク不調など)は、ここで「offline」と
  // 決めつけずに例外を投げ、呼び出し側(index.js)の既存のエラーハンドリングに委ねる。
  // そうすることで、DBの前回のステータス(例:配信中)を上書きせずに次回のポーリングまで保持でき、
  // 一時的な取得失敗のたびに「配信中→オフライン→配信中」と表示が揺れ動くのを防げる。
  const candidateVideoId = await fetchLiveCandidateVideoId(channelId);

  if (!candidateVideoId) {
    return OFFLINE_STATUS;
  }

  const detailsRes = await youtube.videos.list({
    part: ['snippet', 'liveStreamingDetails'],
    id: [candidateVideoId],
  });
  const videoItem = detailsRes.data.items?.[0];
  if (!videoItem) return OFFLINE_STATUS;

  const details = videoItem.liveStreamingDetails || {};
  const liveBroadcastContent = videoItem.snippet?.liveBroadcastContent; // 'live' | 'upcoming' | 'none'

  let status;
  if (liveBroadcastContent === 'live' && !details.actualEndTime) {
    status = 'live';
  } else if (liveBroadcastContent === 'upcoming' && !details.actualStartTime) {
    status = 'upcoming';
  } else {
    // /live は配信直後や終了直後の古いキャッシュを指すことがあるため、
    // videos.list側の実際の状態(liveBroadcastContent / actualEndTime)を正としてオフラインに戻す
    return OFFLINE_STATUS;
  }

  return {
    status,
    videoId: candidateVideoId,
    videoTitle: videoItem.snippet?.title || null,
    videoDescription: videoItem.snippet?.description || null,
    thumbnailUrl: videoItem.snippet?.thumbnails?.medium?.url || videoItem.snippet?.thumbnails?.default?.url || null,
    scheduledStart: details.scheduledStartTime || null,
    actualStart: details.actualStartTime || null,
  };
}

/**
 * まだ /live に出てこない「数日先などの先の配信予定」を search.list で確認する低頻度な補助チェック。
 * quota消費が大きいので、呼び出し頻度は UPCOMING_POLL_INTERVAL_MS で十分に長い間隔にすること。
 * すでに live/upcoming が確定しているチャンネルには適用しない(呼び出し側で判断)。
 */
async function checkUpcomingViaSearch(channelId) {
  const upcomingRes = await youtube.search.list({
    part: ['snippet'],
    channelId,
    eventType: 'upcoming',
    type: ['video'],
    maxResults: 1,
    order: 'date',
  });

  const upcomingItem = upcomingRes.data.items?.[0];
  if (!upcomingItem) return OFFLINE_STATUS;

  const videoId = upcomingItem.id.videoId;
  const detailsRes = await youtube.videos.list({
    part: ['snippet', 'liveStreamingDetails'],
    id: [videoId],
  });
  const videoItem = detailsRes.data.items?.[0];
  const details = videoItem?.liveStreamingDetails || {};
  const liveBroadcastContent = videoItem?.snippet?.liveBroadcastContent;

  if (liveBroadcastContent !== 'upcoming' || details.actualStartTime) {
    // 検索結果が古く、既に開始/終了/キャンセルされている場合はオフライン扱い
    return OFFLINE_STATUS;
  }

  return {
    status: 'upcoming',
    videoId,
    videoTitle: upcomingItem.snippet.title || null,
    videoDescription: videoItem?.snippet?.description || null,
    thumbnailUrl: upcomingItem.snippet.thumbnails?.medium?.url || null,
    scheduledStart: details.scheduledStartTime || null,
    actualStart: null,
  };
}

/**
 * ISO8601形式の動画時間 (例: "PT1H2M3S") を秒数に変換する。
 */
function parseIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return null;
  const hours = Number(m[1] || 0);
  const minutes = Number(m[2] || 0);
  const seconds = Number(m[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * 指定チャンネルの「アップロード済み動画」プレイリストから直近の動画を取得する。
 * 配信していない時間帯に流す過去配信のローテーション用。
 * quota消費: playlistItems.list(1) + videos.list(1) = 2ユニット/チャンネル と軽量なので、
 * ライブ確認(search.list)よりずっと長い間隔でポーリングして良い。
 */
async function fetchRecentUploads(channelId, uploadsPlaylistId, maxResults = 15) {
  if (!uploadsPlaylistId) return [];

  const playlistRes = await youtube.playlistItems.list({
    part: ['snippet', 'contentDetails'],
    playlistId: uploadsPlaylistId,
    maxResults,
  });

  const items = (playlistRes.data.items || []).filter((it) => it.contentDetails?.videoId);
  if (items.length === 0) return [];

  const videoIds = items.map((it) => it.contentDetails.videoId);
  const videosRes = await youtube.videos.list({
    part: ['contentDetails', 'snippet'],
    id: videoIds,
  });

  const durationById = new Map();
  const descriptionById = new Map();
  for (const v of videosRes.data.items || []) {
    durationById.set(v.id, parseIsoDuration(v.contentDetails?.duration));
    descriptionById.set(v.id, v.snippet?.description || null);
  }

  // 以前はここで liveBroadcastContent !== 'none' の動画(配信中/配信予定)を除外していたが、
  // YouTube側でアーカイブ済みのライブ配信の liveBroadcastContent が配信終了後も
  // 'live' のまま更新されない/戻るのが遅いことがある。アップロードのほとんどが
  // ライブアーカイブというVTuberチャンネルではこれで「過去配信が実質すべて除外される」
  // ことがあったため、この絞り込みはやめた(現在ライブ中かどうかは checkChannelBroadcasts 側で
  // 別途判定しており、ここで重複表示されても番組表の描画側で時間帯の重なりを吸収している)。
  return items.map((it) => {
    const videoId = it.contentDetails.videoId;
    return {
      videoId,
      title: it.snippet?.title || '(タイトル不明)',
      description: descriptionById.get(videoId) ?? null,
      thumbnailUrl:
        it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || null,
      publishedAt: it.contentDetails.videoPublishedAt || it.snippet?.publishedAt || null,
      durationSeconds: durationById.get(videoId) ?? null,
    };
  });
}

module.exports = { resolveChannel, checkChannelBroadcasts, checkUpcomingViaSearch, fetchRecentUploads };
