// Application emojis: the flat white control glyphs on the Now Playing panel.
// Unicode ⏸️ renders through the platform's colorful emoji font; an app emoji
// renders the exact uploaded pixels, which is what makes the buttons read as
// UI instead of chat. Uploaded once by scripts/uploadAppEmojis.js; resolved
// here by name at boot. Every lookup carries a unicode fallback so a fresh
// application (or a failed fetch) degrades to the old look, never to a broken
// button.
import { log } from "@/lib/logger.js";

const emojis = new Map();

export async function loadAppEmojis(client) {
    try {
        const fetched = await client.application.emojis.fetch();
        for (const emoji of fetched.values()) emojis.set(emoji.name, emoji);
        if (emojis.size) log.info(`[emoji] ${emojis.size} application emojis loaded`);
    } catch (err) {
        // Fallbacks cover every call site — this is a cosmetic downgrade.
        log.warn(`[emoji] app emojis unavailable: ${err.message}`);
    }
}

// Shape accepted by ButtonBuilder#setEmoji: a custom emoji reference, or the
// unicode fallback when the name was never uploaded.
export function appEmoji(name, fallback) {
    const emoji = emojis.get(name);
    return emoji ? { id: emoji.id, name: emoji.name } : fallback;
}
