// Generate the Now Playing control glyphs and upload them as *application*
// emojis — the flat white icons FlaviBot-style buttons use instead of the
// platform's colorful unicode emoji font. App emojis belong to the bot
// application (2000 slots), work in every guild, and cost no guild slots.
//
// Idempotent: an emoji whose name already exists is kept as-is. Run manually
// (deno run --allow-all --env-file=.env scripts/uploadAppEmojis.js); the bot
// resolves them by name at boot and falls back to unicode when absent, so this
// script is a nicety, never a dependency.
import { PNG } from "pngjs";

const SIZE = 128;
const C = SIZE / 2;

// Each glyph paints white pixels via a predicate over (x, y). Geometry is
// proportional so SIZE can change freely.
const GLYPHS = {
    // ⏮ bar + leftward triangle
    np_previous: (x, y) => bar(x, 0.16, 0.26) && v(y) || triLeft(x, y, 0.34, 0.86),
    // ⏸ two bars
    np_pause: (x, y) => (bar(x, 0.22, 0.40) || bar(x, 0.60, 0.78)) && v(y),
    // ▶ rightward triangle
    np_play: (x, y) => triRight(x, y, 0.24, 0.82),
    // ⏭ rightward triangle + bar
    np_skip: (x, y) => triRight(x, y, 0.14, 0.66) || (bar(x, 0.74, 0.84) && v(y)),
    // ⏹ square
    np_stop: (x, y) => bar(x, 0.24, 0.76) && bar(y, 0.24, 0.76),
};

const f = (r) => Math.round(r * SIZE);
const bar = (p, from, to) => p >= f(from) && p < f(to);
const v = (y) => y >= f(0.18) && y < f(0.82); // shared vertical extent for bars
// Triangle spanning x∈[from,to], apex at `to` (right) or `from` (left), full
// height at the base tapering linearly to the apex.
function triRight(x, y, from, to) {
    if (x < f(from) || x >= f(to)) return false;
    const t = (x - f(from)) / (f(to) - f(from));
    const half = (1 - t) * 0.32 * SIZE;
    return Math.abs(y - C) <= half;
}
function triLeft(x, y, from, to) {
    if (x < f(from) || x >= f(to)) return false;
    const t = (f(to) - x) / (f(to) - f(from));
    const half = (1 - t) * 0.32 * SIZE;
    return Math.abs(y - C) <= half;
}

function render(paint) {
    const png = new PNG({ width: SIZE, height: SIZE });
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const i = (y * SIZE + x) * 4;
            const on = paint(x, y);
            png.data[i] = 255;
            png.data[i + 1] = 255;
            png.data[i + 2] = 255;
            png.data[i + 3] = on ? 255 : 0;
        }
    }
    return PNG.sync.write(png);
}

const token = Deno.env.get("BOT_TOKEN");
if (!token) throw new Error("BOT_TOKEN not set");
// An app id IS its bot user's id — same resolution deployCommands uses. The
// token's first segment is base64 of the id *string*; JSON.parse would hand
// back a Number and snowflakes exceed 2^53, so the digits must stay a string.
const appId = atob(token.split(".")[0]);

const api = (path, init = {}) =>
    fetch(`https://discord.com/api/v10/applications/${appId}${path}`, {
        ...init,
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    });

const existing = await (await api("/emojis")).json();
const have = new Set((existing.items ?? []).map((e) => e.name));

for (const [name, paint] of Object.entries(GLYPHS)) {
    if (have.has(name)) {
        console.log(`= ${name} (already uploaded)`);
        continue;
    }
    const image = `data:image/png;base64,${btoa(String.fromCharCode(...render(paint)))}`;
    const res = await api("/emojis", { method: "POST", body: JSON.stringify({ name, image }) });
    if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
    console.log(`+ ${name} uploaded (${(await res.json()).id})`);
}
console.log("done");
