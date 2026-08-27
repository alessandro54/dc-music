import { AudioPlayerStatus } from "@discordjs/voice";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";

import { COLORS } from "@/lib/constants.js";
import { durationToMs, formatMs, progressBar } from "@/lib/utils.js";

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
export const componentPayload = (components) => ({
    components,
    content: null,
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
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
    const lines = [`- Added by ${who}`];
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
// `duration` is null for the first seconds of a URL play (the sidecar has not
// answered yet), so the bar has to degrade to a bare elapsed counter.
function progressLine(queue, song) {
    const elapsedMs = (queue.resource?.playbackDuration ?? 0) + queue.seekOffset * 1000;
    const totalMs = durationToMs(song.duration);
    const content = totalMs
        ? `${progressBar(elapsedMs, totalMs)}\n\`${formatMs(elapsedMs)}\` / \`${song.duration}\``
        : `\`${formatMs(elapsedMs)}\` elapsed`;
    return new TextDisplayBuilder().setContent(content);
}

export function nowPlayingControls(queue) {
    const isPaused = queue.player.state.status === AudioPlayerStatus.Paused;
    return new ActionRowBuilder().addComponents(
        // Disabled rather than hidden when there's nothing to go back to: a row
        // that changes width between renders is worse than a dead button.
        new ButtonBuilder().setCustomId("np:previous").setEmoji("⏮️").setLabel("Previous")
            .setStyle(ButtonStyle.Secondary).setDisabled(queue.played.length === 0),
        // Toggles: the button renders ▶️ Resume once paused, so a press while
        // paused means resume (see buttons.js).
        new ButtonBuilder().setCustomId("np:pause")
            .setEmoji(isPaused ? "▶️" : "⏸️").setLabel(isPaused ? "Resume" : "Pause")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("np:skip").setEmoji("⏭️").setLabel("Skip")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("np:stop").setEmoji("⏹️").setLabel("Stop")
            .setStyle(ButtonStyle.Danger),
    );
}

// The full dashboard: heading, art + credits, stats, progress, controls.
export function nowPlayingView(queue) {
    const song = queue.current;
    const container = shell("🎵 Now Playing", song, creditLines(queue, song));
    container.addTextDisplayComponents(statLine(queue, song), progressLine(queue, song));
    container.addActionRowComponents(nowPlayingControls(queue));
    return [container];
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
        .setAccentColor(COLORS.PRIMARY)
        .addTextDisplayComponents(heading(title))
        .addSeparatorComponents(rule());
    const block = titleSection(song, lines);
    if (block instanceof SectionBuilder) container.addSectionComponents(block);
    else container.addTextDisplayComponents(block);
    return container;
}
