import { AudioPlayerStatus } from "@discordjs/voice";
import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";

import { appEmoji, appEmojiText } from "@/discord/services/appEmojiService.js";
import { COLORS } from "@/lib/constants.js";
import { renderProgressBar } from "@/lib/progressImage.js";
import { durationToMs, formatMs } from "@/lib/utils.js";

// The Now Playing "dashboard": a Components V2 container, not an embed. The
// accent bar down the left, the rule under the heading and the album art sitting
// beside the text (rather than floating in an embed's thumbnail slot) are all
// container/section features — an EmbedBuilder cannot produce this layout.
//
// Components V2 is all-or-nothing per message: a payload carrying the
// IsComponentsV2 flag may not also carry `content` or `embeds`, which is why
// `componentPayload` below is the only way these are sent.

const SOURCE_LABELS = {
    youtube: "YouTube",
    spotify: "Spotify",
    soundcloud: "SoundCloud",
};

// Every payload here goes out with mentions suppressed. Unlike embed text, a
// mention inside a TextDisplay *does* ping — so rendering the requester as
// `<@id>` (which is what makes it a chip rather than a raw tag) would notify
// them on every render, including every button press.
// `content`/`embeds` are cleared explicitly rather than left off: /play may have
// already answered with a plain "🔍 Searching…" message, and turning that into a
// Components V2 message on edit is only legal once its content is gone.
export const componentPayload = (components, { ephemeral = false } = {}) => ({
    components,
    content: null,
    embeds: [],
    flags: ephemeral ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
});

const heading = (text) => new TextDisplayBuilder().setContent(`### ${text}`);

const rule = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

// Title + the bullet list under it, with the album art as the section accessory.
// A section needs at least one text display and the thumbnail needs a real URL,
// so a song with no artwork falls back to a bare text display.
function titleSection(song, lines) {
    const title = song.url ? `**[${song.title}](${song.url})**` : `**${song.title}**`;
    const text = new TextDisplayBuilder().setContent([title, ...lines].join("\n"));
    if (!song.thumbnail) return text;
    return new SectionBuilder()
        .addTextDisplayComponents(text)
        .setThumbnailAccessory(
            new ThumbnailBuilder().setURL(song.thumbnail).setDescription("Album art"),
        );
}

// "Added by" reads as a mention chip rather than a plain tag, and the voice
// channel as `<#id>` — Discord renders that with the speaker icon itself, so the
// view never has to look a channel name up.
function creditLines(queue, song) {
    const who = song.requestedById ? `<@${song.requestedById}>` : song.requestedBy;
    // The requester's standing on /leaderboard's DJ board, stamped on the song
    // by the queue (GuildQueue._absorbLookups). Absent until it resolves — and
    // absent for a first-ever pick, which has no rank to show yet. The glyph is
    // the same white set as the buttons; the rank number carries the standing.
    const badge = song.djRank ? ` · ${appEmojiText("np_dj", "🎧")} DJ #${song.djRank}` : "";
    const lines = [`- Added by ${who}${badge}`];
    const channelId = queue?.connection?.joinConfig?.channelId;
    if (channelId) lines.push(`- <#${channelId}>`);
    return lines;
}

// The stat strip. Inline code makes each value a chip the way FlaviBot's does;
// only stats this bot actually has are shown — there is no volume or loop
// control, and a chip that always reads "Off" would be decoration.
function statLine(queue, song) {
    const upcoming = Math.max(queue.songs.length - 1, 0);
    const stats = [`Queue Size: \`${upcoming}\``];
    const source = SOURCE_LABELS[song.source];
    if (source) stats.push(`Source: \`${source}\``);
    stats.push(`Length: \`${song.duration ?? "—"}\``);
    return new TextDisplayBuilder().setContent(stats.join(" · "));
}

// Elapsed is the resource's own playback clock plus whatever a seek skipped.
const elapsedMsOf = (queue) => (queue.resource?.playbackDuration ?? 0) + queue.seekOffset * 1000;

// The bar is an image: a text bar's rendered width depends on the viewer's
// window and font, while a media-gallery image stretches to the container on
// every client — the only way "fill the panel" can actually be promised.
const BAR_FILE = "progress.png";

function progressGallery() {
    return new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${BAR_FILE}`).setDescription("Progress"),
    );
}

function timeLine(queue, song) {
    const elapsedMs = elapsedMsOf(queue);
    const content = song.duration
        ? `\`${formatMs(elapsedMs)}\` / \`${song.duration}\``
        : `\`${formatMs(elapsedMs)}\` elapsed`;
    return new TextDisplayBuilder().setContent(content);
}

// Buttons carry application emojis (flat white glyphs, see appEmojiService)
// with the unicode set as fallback for a fresh application.
export function nowPlayingControls(queue, { seekOpen = false, canSeek = false } = {}) {
    const isPaused = queue.player.state.status === AudioPlayerStatus.Paused;
    return new ActionRowBuilder().addComponents(
        // Disabled rather than hidden when there's nothing to go back to: a row
        // that changes width between renders is worse than a dead button.
        new ButtonBuilder().setCustomId("np:previous").setEmoji(appEmoji("np_previous", "⏮️"))
            .setLabel("Previous").setStyle(ButtonStyle.Secondary)
            .setDisabled(queue.played.length === 0),
        // Toggles: the button renders ▶ Resume once paused, so a press while
        // paused means resume (see buttons.js).
        new ButtonBuilder().setCustomId("np:pause")
            .setEmoji(isPaused ? appEmoji("np_play", "▶️") : appEmoji("np_pause", "⏸️"))
            .setLabel(isPaused ? "Resume" : "Pause")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("np:skip").setEmoji(appEmoji("np_skip", "⏭️")).setLabel("Skip")
            .setStyle(ButtonStyle.Secondary),
        // The digit rows fold in and out behind this — Primary while open, so
        // the button itself shows the state. Disabled until the duration is
        // known, since the digits are fractions of it.
        new ButtonBuilder().setCustomId("np:seektoggle").setEmoji(appEmoji("np_seek", "⏩"))
            .setLabel("Seek").setStyle(seekOpen ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(!canSeek),
        new ButtonBuilder().setCustomId("np:stop").setEmoji(appEmoji("np_stop", "⏹️")).setLabel("Stop")
            .setStyle(ButtonStyle.Danger),
    );
}

// Discord has no slider, so seeking is YouTube's number-row instead: 0–9 jump
// to that tenth of the track, exactly like the player hotkeys. Two rows of
// five buttons, each wearing a seven-segment digit glyph from the same white
// set as the controls. The value is the *fraction*, resolved against the
// duration at press time — a duration that arrives late doesn't strand the
// buttons with stale seconds.
const SEEK_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function seekRows() {
    const button = (d) =>
        new ButtonBuilder()
            .setCustomId(`np:seekpct:${d}`)
            .setEmoji(appEmoji(`np_d${d}`, `${d}\uFE0F\u20E3`))
            .setStyle(ButtonStyle.Secondary);
    return [
        new ActionRowBuilder().addComponents(SEEK_DIGITS.slice(0, 5).map(button)),
        new ActionRowBuilder().addComponents(SEEK_DIGITS.slice(5).map(button)),
    ];
}

// The full dashboard: heading, art + credits, stats, bar image, times, seek,
// controls. Returns the payload halves — the bar rides as an attachment the
// container's media gallery references, so the caller must send `files` with
// the components (nowPlayingService is the one consumer).
export function nowPlayingPanel(queue, { seekOpen = false } = {}) {
    const song = queue.current;
    const container = shell(`${appEmojiText("np_note", "🎵")} Now Playing`, song, creditLines(queue, song));
    container.addTextDisplayComponents(statLine(queue, song));

    const totalMs = durationToMs(song.duration);
    const files = [];
    if (totalMs) {
        container.addMediaGalleryComponents(progressGallery());
        files.push(
            new AttachmentBuilder(renderProgressBar(elapsedMsOf(queue) / totalMs), {
                name: BAR_FILE,
            }),
        );
    }
    container.addTextDisplayComponents(timeLine(queue, song));
    // The digit rows live behind the Seek toggle — panel UI state, owned by
    // nowPlayingService, threaded through per render.
    if (totalMs && seekOpen) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent("-# Seek to"));
        container.addActionRowComponents(...seekRows());
    }
    container.addActionRowComponents(nowPlayingControls(queue, { seekOpen, canSeek: Boolean(totalMs) }));
    return { components: [container], files };
}

// Same container, no progress bar or controls — the track isn't playing yet, so
// a bar frozen at 0:00 and a Pause button would both be lying.
export function queuedView(song, position, queue, { next = false } = {}) {
    const lines = [...creditLines(queue, song), `- Position: \`#${position}\``];
    const container = shell(next ? "⏭️ Playing Next" : "➕ Added to Queue", song, lines);
    container.addTextDisplayComponents(statLine(queue, song));
    return [container];
}

// Heading, rule, then the title block — which is a *section* when there is
// artwork to hang off it and a plain text display when there isn't. The
// container's add* methods are typed per component, so that branch has to be
// resolved here rather than by passing one value around.
function shell(title, song, lines) {
    const container = new ContainerBuilder()
        .setAccentColor(COLORS.ICE)
        .addTextDisplayComponents(heading(title))
        .addSeparatorComponents(rule());
    const block = titleSection(song, lines);
    if (block instanceof SectionBuilder) container.addSectionComponents(block);
    else container.addTextDisplayComponents(block);
    return container;
}
