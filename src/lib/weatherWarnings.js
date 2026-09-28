// src/lib/weatherWarnings.js
//
// 気象庁の気象警報・注意報データまわりの共通処理。
// src/routes/weather.js (GET /api/weather/warnings, ブラウザからの表示用)
// と scripts/weather-warning-push-bridge.js (定期ポーリング → push通知)
// の両方から使うので、地域リストとJMAのJSONを解釈するロジックをここに
// 1箇所だけ持つ。
//
// 気象庁は2026年5月29日から警報・注意報のシステムを大きく作り直した
// (河川氾濫・大雨・土砂災害・高潮の4種は 注意報→警報→危険警報→特別警報
// の4段階に、JSONの構造も旧来の areaTypes[].areas[].warnings から
// warning.class20Items[].kinds のような形に変わった)。この新形式は
// 気象庁自身が正式なAPIとして案内しているものではなく、コミュニティが
// まだ構造を追いきれていない段階(2026年5月時点の解説記事でも「情報の
// 抽出には一部修正が必要」「かなりカオスな状況」と書かれている)なので、
// 個々の警報種別(大雨/暴風/...)をコード表から確実に判定するのは避け、
// 気象庁が発表文にそのまま含めている headlineText（見出し文）を素直に
// 表示する方針にしている。headlineTextが見つからない場合でも「解析に
// 失敗した」と「本当に警報・注意報が無い」を無理に区別しようとせず、
// どちらの場合も気象庁サイトへのリンクを添えて案内する。
const WARNING_AREAS = [
  { code: "011000", name: "宗谷地方" }, { code: "012000", name: "上川・留萌地方" },
  { code: "013000", name: "網走・北見・紋別地方" }, { code: "014030", name: "十勝地方" },
  { code: "014100", name: "釧路・根室地方" }, { code: "015000", name: "胆振・日高地方" },
  { code: "016000", name: "石狩・空知・後志地方" }, { code: "017000", name: "渡島・檜山地方" },
  { code: "020000", name: "青森県" }, { code: "030000", name: "岩手県" },
  { code: "040000", name: "宮城県" }, { code: "050000", name: "秋田県" },
  { code: "060000", name: "山形県" }, { code: "070000", name: "福島県" },
  { code: "080000", name: "茨城県" }, { code: "090000", name: "栃木県" },
  { code: "100000", name: "群馬県" }, { code: "110000", name: "埼玉県" },
  { code: "120000", name: "千葉県" }, { code: "130000", name: "東京都" },
  { code: "140000", name: "神奈川県" }, { code: "150000", name: "新潟県" },
  { code: "160000", name: "富山県" }, { code: "170000", name: "石川県" },
  { code: "180000", name: "福井県" }, { code: "190000", name: "山梨県" },
  { code: "200000", name: "長野県" }, { code: "210000", name: "岐阜県" },
  { code: "220000", name: "静岡県" }, { code: "230000", name: "愛知県" },
  { code: "240000", name: "三重県" }, { code: "250000", name: "滋賀県" },
  { code: "260000", name: "京都府" }, { code: "270000", name: "大阪府" },
  { code: "280000", name: "兵庫県" }, { code: "290000", name: "奈良県" },
  { code: "300000", name: "和歌山県" }, { code: "310000", name: "鳥取県" },
  { code: "320000", name: "島根県" }, { code: "330000", name: "岡山県" },
  { code: "340000", name: "広島県" }, { code: "350000", name: "山口県" },
  { code: "360000", name: "徳島県" }, { code: "370000", name: "香川県" },
  { code: "380000", name: "愛媛県" }, { code: "390000", name: "高知県" },
  { code: "400000", name: "福岡県" }, { code: "410000", name: "佐賀県" },
  { code: "420000", name: "長崎県" }, { code: "430000", name: "熊本県" },
  { code: "440000", name: "大分県" }, { code: "450000", name: "宮崎県" },
  { code: "460040", name: "奄美地方" }, { code: "460100", name: "鹿児島県（奄美地方除く）" },
  { code: "471000", name: "沖縄本島地方" }, { code: "472000", name: "大東島地方" },
  { code: "473000", name: "宮古島地方" }, { code: "474000", name: "八重山地方" },
];
const WARNING_AREA_NAMES = Object.fromEntries(WARNING_AREAS.map((a) => [a.code, a.name]));

function officialWarningUrl(areaCode) {
  return `https://www.jma.go.jp/bosai/warning/#area_type=offices&area_code=${areaCode}&lang=ja`;
}

// 見出し文をできるだけ素直に拾う。新形式(2026/5/29~)はレポートが配列で
// 複数種別(暴風・大雨・...)が並んで返ってくることがあるため、配列/単一
// オブジェクトどちらでも動くようにしている。見つかった非空の見出しを
// 全部集めて返す(同じ内容が複数種別にまたがることがあるので重複除去)。
function extractWarningHeadlines(raw) {
  const reports = Array.isArray(raw) ? raw : [raw];
  const headlines = [];
  let reportDatetime = null;
  let publishingOffice = null;

  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    const candidates = [
      report.headlineText,
      report.warning?.headlineText,
      report.Report?.headlineText,
    ];
    const headline = candidates.find((t) => typeof t === "string" && t.trim());
    if (headline && !headlines.includes(headline.trim())) headlines.push(headline.trim());
    reportDatetime = reportDatetime || report.reportDatetime || report.warning?.reportDatetime || null;
    publishingOffice = publishingOffice || report.publishingOffice || report.warning?.publishingOffice || null;
  }

  return { headlines, reportDatetime, publishingOffice };
}

// 指定した地域コードの現在の警報・注意報を取得して整形する。成功/失敗
// いずれでもofficialUrlは必ず入れて返す(呼び出し側が常にリンクを出せる
// ようにするため)。
async function fetchWarningSummary(areaCode) {
  const areaName = WARNING_AREA_NAMES[areaCode];
  const officialUrl = officialWarningUrl(areaCode);
  if (!areaName) return { areaCode, areaName: null, headlines: null, officialUrl, invalidArea: true };

  try {
    const r = await fetch(`https://www.jma.go.jp/bosai/warning/data/r8/${areaCode}.json`);
    if (!r.ok) throw new Error(`jma warning request failed: ${r.status}`);
    const raw = await r.json();
    const { headlines, reportDatetime, publishingOffice } = extractWarningHeadlines(raw);
    return {
      areaCode,
      areaName,
      publishingOffice,
      reportDatetime,
      headlines: headlines.length ? headlines : null,
      officialUrl,
    };
  } catch (err) {
    return {
      areaCode,
      areaName,
      publishingOffice: null,
      reportDatetime: null,
      headlines: null,
      officialUrl,
      fetchError: true,
      fetchErrorMessage: err.message,
    };
  }
}

module.exports = { WARNING_AREAS, WARNING_AREA_NAMES, fetchWarningSummary };
