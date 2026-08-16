// 天気予報API (OpenWeatherMap) のサーバーサイド・プロキシ。
//
// APIキーをフロントエンド(app.js)に埋め込むとブラウザから丸見えになり、
// 第三者に使い放題で叩かれてしまう(SimBrief/YouTube連携と同じ理由で
// server-side proxyにしている — routes/simbrief.js, routes/youtube.js
// 参照)。.envに OPENWEATHER_API_KEY を設定して使う。
//
// 提供するエンドポイント:
//   GET /api/weather/search?q=<地域名>
//     -> OpenWeatherMapのGeocoding APIで地域名から緯度経度候補を検索する。
//   GET /api/weather/summary?lat=<lat>&lon=<lon>
//     -> 現在の天気 + 今日/明日のサマリー + 詳細モーダル用の3時間ごと
//        予報をまとめて返す。
const express = require("express");
const router = express.Router();

const OWM_API_KEY = process.env.OPENWEATHER_API_KEY;
const GEO_URL = "https://api.openweathermap.org/geo/1.0/direct";
const CURRENT_WEATHER_URL = "https://api.openweathermap.org/data/2.5/weather";
const FORECAST_URL = "https://api.openweathermap.org/data/2.5/forecast";

function ensureApiKey(res) {
  if (!OWM_API_KEY) {
    res.status(500).json({ error: "サーバーにOPENWEATHER_API_KEYが設定されていません。" });
    return false;
  }
  return true;
}

// GET /api/weather/search?q=地域名
// 地名から緯度経度の候補を最大5件返す。同名の地域が複数の国/州に
// またがることがあるため、フロント側で候補を選ばせられるよう複数件
// 返す(1件しかヒットしなければフロントが自動選択する)。
router.get("/search", async (req, res) => {
  if (!ensureApiKey(res)) return;
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "検索キーワードを入力してください。" });

  try {
    const url = `${GEO_URL}?q=${encodeURIComponent(q)}&limit=5&appid=${OWM_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`geocoding request failed: ${r.status}`);
    const raw = await r.json();

    const results = (Array.isArray(raw) ? raw : []).map((d) => ({
      name: d.name,
      // 日本語ローカル名があれば優先表示、無ければ元の(英語)名にフォールバック。
      displayName: (d.local_names && d.local_names.ja) || d.name,
      state: d.state || "",
      country: d.country || "",
      lat: d.lat,
      lon: d.lon,
    }));
    res.json({ results });
  } catch (err) {
    console.error("weather search error:", err);
    res.status(502).json({ error: "地域の検索に失敗しました。時間をおいて再度お試しください。" });
  }
});

// 予報リスト(3時間刻み)を「その地域のタイムゾーンでの日付」でグループ
// 化するためのヘルパー。timezoneOffsetSecはOpenWeatherMapが返す
// city.timezone(UTCからのオフセット秒)で、サーバー/閲覧者のローカル
// タイムゾーンではなく検索対象地域を基準に「今日」「明日」を判定する
// ために使う。
function localDateStr(unixSec, timezoneOffsetSec) {
  return new Date((unixSec + timezoneOffsetSec) * 1000).toISOString().slice(0, 10);
}

// 1日分の3時間刻みエントリから、当日の最高/最低気温と代表的な天気
// (正午に最も近い時間帯のものを採用)をまとめる。
function summarizeDay(entries) {
  if (!entries.length) return null;
  const temps = entries.map((e) => e.main.temp);
  const noonEntry = entries.reduce((best, e) => {
    const hour = Number(e.dt_txt.slice(11, 13));
    const bestHour = Number(best.dt_txt.slice(11, 13));
    return Math.abs(hour - 12) < Math.abs(bestHour - 12) ? e : best;
  }, entries[0]);
  return {
    tempMin: Math.round(Math.min(...temps)),
    tempMax: Math.round(Math.max(...temps)),
    weather: noonEntry.weather[0]?.description || "",
    icon: noonEntry.weather[0]?.icon || "",
    pop: Math.round(Math.max(...entries.map((e) => e.pop || 0)) * 100),
  };
}

// GET /api/weather/summary?lat=..&lon=..
// 現在の天気・今日/明日のサマリー・詳細モーダル用の3時間ごと予報を
// まとめて1リクエストで返す(フロントはカード表示と詳細モーダルの
// 両方をこれ1回でまかなえる)。
router.get("/summary", async (req, res) => {
  if (!ensureApiKey(res)) return;
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "緯度・経度が不正です。" });
  }

  try {
    const [currentRes, forecastRes] = await Promise.all([
      fetch(`${CURRENT_WEATHER_URL}?lat=${lat}&lon=${lon}&units=metric&lang=ja&appid=${OWM_API_KEY}`),
      fetch(`${FORECAST_URL}?lat=${lat}&lon=${lon}&units=metric&lang=ja&appid=${OWM_API_KEY}`),
    ]);
    if (!currentRes.ok) throw new Error(`current weather request failed: ${currentRes.status}`);
    if (!forecastRes.ok) throw new Error(`forecast request failed: ${forecastRes.status}`);

    const current = await currentRes.json();
    const forecast = await forecastRes.json();

    const tzOffsetSec = forecast.city?.timezone ?? 0;
    const todayStr = localDateStr(Math.floor(Date.now() / 1000), tzOffsetSec);
    const tomorrowDate = new Date(`${todayStr}T00:00:00Z`);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

    const byDate = {};
    for (const item of forecast.list || []) {
      const dateStr = localDateStr(item.dt, tzOffsetSec);
      (byDate[dateStr] ||= []).push(item);
    }

    res.json({
      city: {
        name: current.name || forecast.city?.name || "",
        country: current.sys?.country || forecast.city?.country || "",
        timezone: tzOffsetSec,
        sunrise: current.sys?.sunrise || null,
        sunset: current.sys?.sunset || null,
      },
      current: {
        temp: current.main ? Math.round(current.main.temp) : null,
        feelsLike: current.main ? Math.round(current.main.feels_like) : null,
        humidity: current.main?.humidity ?? null,
        pressure: current.main?.pressure ?? null,
        windSpeed: current.wind?.speed ?? null,
        weather: current.weather?.[0]?.description || "",
        icon: current.weather?.[0]?.icon || "",
      },
      today: summarizeDay(byDate[todayStr] || []),
      tomorrow: summarizeDay(byDate[tomorrowStr] || []),
      // 詳細モーダル用: 当日・翌日ぶんの3時間刻みデータ。
      hourly: [...(byDate[todayStr] || []), ...(byDate[tomorrowStr] || [])].map((e) => ({
        dt: e.dt,
        dtText: e.dt_txt,
        temp: Math.round(e.main.temp),
        feelsLike: Math.round(e.main.feels_like),
        humidity: e.main.humidity,
        weather: e.weather[0]?.description || "",
        icon: e.weather[0]?.icon || "",
        wind: e.wind?.speed,
        pop: Math.round((e.pop || 0) * 100),
      })),
    });
  } catch (err) {
    console.error("weather summary error:", err);
    res.status(502).json({ error: "天気情報の取得に失敗しました。時間をおいて再度お試しください。" });
  }
});

module.exports = router;
