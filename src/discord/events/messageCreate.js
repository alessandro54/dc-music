import { notePanelMessage } from "@/discord/services/nowPlayingService.js";

// The only thing this bot reads messages for: noticing that the live Now Playing
// panel is no longer the last message in its channel, so the next tick can
// re-post it at the bottom. Nothing is stored and no content is read — the
// MessageContent intent is not needed, and MessageManager stays cached at 0.
export default {
    name: "messageCreate",
    execute: (message) => notePanelMessage(message),
};
