// services/discordNotify.js
//
// Discord Bot連携: AeroSocialに新規投稿があった時、指定チャンネルに埋め込み
// メッセージを送信する。
//
// Webhookではなくdiscord.js Botクライアントを常駐させる構成にしているのは、
// 将来的にDiscord側からのコマンド受付(例: Discordから投稿を削除/BAN操作する等)
// に拡張しやすくするため。通知専用なら本来Webhookの方が軽量だが、その場合は
// このファイルを丸ごとWebhook POSTに差し替えれば良い。
//
// レイテンシについて: このモジュールはDBをポーリングしない。投稿作成処理
// (routes/posts.js)の中で、INSERT成功直後に notifyNewPost() を呼び出す
// 「直接フック」方式なので、Discordへの通知はほぼ投稿と同時に飛ぶ。
//
// 必要な環境変数(.envに追加):
//   DISCORD_BOT_TOKEN   - Botのトークン (Discord Developer Portal > Bot > Token)
//   DISCORD_CHANNEL_ID  - 通知を送るテキストチャンネルのID(チャンネルを右クリック→IDをコピー)
//   SITE_URL            - (任意) https://your-domain.example のようなフロントエンドURL。
//                          設定すると埋め込みに投稿へのリンクが付く。
//
// 必要なBotの権限/Intent:
//   - Botをサーバーに招待する際、"Send Messages" 権限があれば送信は可能。
//   - Gateway Intentは Guilds のみで足りる(メッセージ受信までは不要)。
//   - 将来コマンドを受け付けたくなったら GatewayIntentBits.GuildMessages と
//     MessageContent Intentを追加し、client.on("messageCreate", ...) を実装する。
//
// npm install discord.js が必要です。

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

let client = null;
let ready = false;
const channelId = process.env.DISCORD_CHANNEL_ID;
const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");

// サーバー起動時(index.js)に一度だけ呼ぶ。トークン未設定なら何もせず、
// Discord通知はサイレントに無効化される(本体機能をブロックしないため)。
function initDiscordBot() {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.warn("[discord] DISCORD_BOT_TOKEN未設定のため、Discord通知は無効化されています。");
    return;
  }
  if (!channelId) {
    console.warn("[discord] DISCORD_CHANNEL_ID未設定のため、Discord通知は無効化されています。");
    return;
  }
  if (client) return; // 二重初期化防止

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", () => {
    ready = true;
    console.log(`[discord] Botとしてログインしました: ${client.user.tag}`);
  });

  client.on("error", (err) => {
    console.error("[discord] クライアントエラー:", err.message);
  });

  client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error("[discord] ログインに失敗しました:", err.message);
  });
}

// 新規投稿をDiscordチャンネルに通知する。
//
// 呼び出し側(routes/posts.js)での使い方:
//   notifyNewPost({
//     callsign: user.callsign,
//     content: post.content,
//     postId: post.id,
//     imageUrls: post.imageUrls.map((p) => `${process.env.SITE_URL}${p}`),
//   }); // ← await しない(fire-and-forget)。投稿レスポンスをDiscord送信待ちで
//         遅らせないため。失敗しても投稿自体は成功として扱う。
//
// 画像が複数枚ある場合: Discordの埋め込みは1つのEmbedにつき画像1枚までしか
// 表示できないが、「同じurlを持つ複数のEmbed」を1メッセージ内に並べると、
// Discordクライアント側がそれを1つの画像ギャラリーとしてまとめて表示する
// (これは公式に文書化された仕様ではなく観測されている挙動だが、広く使われ
// ている手法)。そのため1枚目のEmbedに本文・投稿者などの情報を載せ、2枚目
// 以降は画像だけを持つEmbedとして追加し、全EmbedのURLを同じ値に揃えている。
// 1メッセージに載せられるEmbed数はDiscord側の上限(10個)があるため、画像は
// 最大9枚(本文用の1枚+画像用の最大9枚)までに制限している。
//
// Bot未接続(トークン未設定・起動直後でまだreadyでない等)の場合は何もせず
// 即座に返る。
async function notifyNewPost({ callsign, content, postId, imageUrls } = {}) {
  if (!ready) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;

    const linkUrl = siteUrl && postId ? `${siteUrl}/posts/${postId}` : undefined;
    const images = (imageUrls || []).filter(Boolean).slice(0, 9);

    const mainEmbed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setAuthor({ name: callsign || "unknown" })
      .setTimestamp(new Date());
    // Discordの埋め込みdescriptionは1文字以上でなければならず、空文字列
    // ("")を渡すとバリデーションエラーになる。画像のみ/フライトログのみ
    // の投稿ではcontentが空になり得るため、値がある時だけ設定する。
    if (content) mainEmbed.setDescription(content.slice(0, 400));
    if (linkUrl) mainEmbed.setURL(linkUrl);
    if (images[0]) mainEmbed.setImage(images[0]);

    const galleryEmbeds = images.slice(1).map((url) => {
      const e = new EmbedBuilder().setImage(url);
      if (linkUrl) e.setURL(linkUrl); // ギャラリーとしてまとめるには同一urlが必須
      return e;
    });

    await channel.send({ embeds: [mainEmbed, ...galleryEmbeds] });
  } catch (err) {
    // Discord側の障害・権限不足などでAeroSocial本体の投稿機能を落とさない。
    // err.messageだけだと「Received one or more errors」のような概要しか
    // 出ないことがあるため、discord.jsのDiscordAPIErrorが持つrawError
    // (Discord側が返した詳細なバリデーションエラー、例: 不正なURL)も
    // あわせて出力する。
    console.error("[discord] 通知送信に失敗:", err.message);
    if (err.rawError) console.error("[discord] 詳細:", JSON.stringify(err.rawError));
  }
}

// 新規イベントをDiscordチャンネルに通知する(イベント作成者が「Discordに
// 通知する」をONにした場合のみ、routes/events.jsのINSERT成功直後に呼ばれる。
// notifyNewPostと同様、fire-and-forgetで呼ばれる想定 — 失敗してもイベント
// 作成自体は成功として扱う)。
//
// 呼び出し側(routes/events.js)での使い方:
//   notifyNewEvent({
//     callsign: user.callsign,
//     title: event.title,
//     description: event.description,
//     startsAt: event.starts_at,
//     eventId: event.id,
//   });
async function notifyNewEvent({ callsign, title, description, startsAt, eventId } = {}) {
  if (!ready) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;

    const linkUrl = siteUrl && eventId ? `${siteUrl}/events/${eventId}` : undefined;
    const startsAtLabel = startsAt
      ? new Date(startsAt).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" })
      : "未定";

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setAuthor({ name: `${callsign || "unknown"} が新しいイベントを作成しました` })
      .setTitle(title || "無題のイベント")
      .addFields({ name: "開催日時", value: startsAtLabel })
      .setTimestamp(new Date());
    if (description) embed.setDescription(description.slice(0, 400));
    if (linkUrl) embed.setURL(linkUrl);

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("[discord] イベント通知の送信に失敗:", err.message);
    if (err.rawError) console.error("[discord] 詳細:", JSON.stringify(err.rawError));
  }
}

module.exports = { initDiscordBot, notifyNewPost, notifyNewEvent };
