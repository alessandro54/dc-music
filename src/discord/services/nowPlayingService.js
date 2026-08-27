import { componentPayload, nowPlayingView } from "@/discord/views/nowPlaying.js";
import { TIMEOUTS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";

// The live Now Playing panel: ONE message per guild, edited in place, rather
// than a new dashboard per command. Three jobs, and each exists for a reason
// that a plain reply cannot cover:
//
//   - it *ticks*, so the progress bar advances without anyone pressing anything
//   - it *follows the channel down*, because a panel buried under later messages
//     is a panel nobody can press
//   - it *dies with the queue*, so a stopped bot never leaves a stale dashboard
//     showing a track that is no longer playing
//
// Deliberately takes the GuildQueue as an argument instead of importing the
// registry: playbackService owns the lifecycle and calls in here, so importing
// `queues` back would make that a cycle.
//
// panels: guildId -> { channel, message, timer, stale, lastBody }
const panels = new Map();

// Start (or re-target) a guild's panel. Called on every command that touches the
// queue, so the panel follows the channel the music is actually requested from.
export function attachPanel(queue, channel) {
    const panel = panels.get(queue.guildId);
    if (panel && panel.channel.id === channel.id) return;
    // Moved channels: the old message can't be edited into the new one.
    if (panel) void remove(panel);
    panels.set(queue.guildId, { channel, message: null, timer: null, stale: false, lastBody: null });
}

// Render the current state into the panel — creating the message the first time,
// editing it afterwards, and re-posting it at the bottom once chat has moved on.
export async function refreshPanel(queue) {
    const panel = panels.get(queue.guildId);
    if (!panel) return;

    // Nothing playing: the queue lives on through its idle grace period, but a
    // panel still advertising the track that just ended — with buttons that now
    // answer "Nothing playing." — is worse than no panel. The entry stays, so
    // the next track posts a fresh one.
    if (!queue.playing || !queue.current) {
        stopTicker(panel);
        return void await remove(panel);
    }
    startTicker(queue, panel);

    const payload = componentPayload(nowPlayingView(queue));
    // Every tick would otherwise be an edit even while paused, where nothing has
    // changed. Comparing the rendered body first keeps a paused panel free.
    const body = JSON.stringify(payload.components.map((c) => c.toJSON()));
    if (!panel.stale && body === panel.lastBody) return;

    // Re-post rather than edit: the panel has been pushed up the channel and the
    // only way back to the bottom is a new message.
    if (panel.stale) await remove(panel);
    panel.stale = false;
    panel.lastBody = body;

    try {
        panel.message = panel.message ? await panel.message.edit(payload) : await panel.channel.send(payload);
    } catch (err) {
        // A panel we can't post is not worth taking playback down for — most
        // often the message was deleted by hand, in which case the next tick
        // sends a fresh one.
        log.warn(`[np ${queue.guildId}] panel: ${err.message}`);
        panel.message = null;
        panel.lastBody = null;
    }
}

// Force the panel back to the bottom of the channel — what `/np` does now that
// there is a single panel rather than a dashboard per invocation.
export async function movePanel(queue, channel) {
    attachPanel(queue, channel);
    const panel = panels.get(queue.guildId);
    if (panel) panel.stale = true;
    await refreshPanel(queue);
}

// A message landed in a panel's channel: the panel is no longer the last thing
// there. Marked rather than moved — the next tick does the work, which coalesces
// a burst of chat into one re-post instead of one per message.
export function notePanelMessage(message) {
    const panel = panels.get(message.guildId);
    if (!panel || panel.channel.id !== message.channelId) return;
    if (!panel.message || message.id === panel.message.id) return;
    panel.stale = true;
}

// The queue is gone. Leaving the panel up would leave a dashboard advertising a
// track that stopped playing, with buttons that answer "Nothing playing."
export async function clearPanel(guildId) {
    const panel = panels.get(guildId);
    if (!panel) return;
    panels.delete(guildId);
    stopTicker(panel);
    await remove(panel);
}

function startTicker(queue, panel) {
    if (panel.timer) return;
    panel.timer = setInterval(() => {
        refreshPanel(queue).catch((err) => log.warn(`[np ${queue.guildId}] tick: ${err.message}`));
    }, TIMEOUTS.NP_TICK_MS);
}

function stopTicker(panel) {
    clearInterval(panel.timer);
    panel.timer = null;
}

async function remove(panel) {
    const message = panel.message;
    panel.message = null;
    panel.lastBody = null;
    if (!message) return;
    // Already deleted by a moderator or a channel purge — nothing to do, and it
    // must not surface as an error.
    await message.delete().catch(() => {});
}
