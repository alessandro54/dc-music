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
    // ⏩ fast-forward — two right triangles (the Seek toggle)
    np_seek: (x, y) => triRight(x, y, 0.12, 0.54) || triRight(x, y, 0.50, 0.92),
    // 🎧 headphones — top band arc + two ear pads
    np_dj: (x, y) =>
        (ring(x, y, 0.5, 0.56, 0.26, 0.36) && y < f(0.56)) ||
        disc(x, y, 0.19, 0.62, 0.115) || disc(x, y, 0.81, 0.62, 0.115),
    // 🎵 beamed eighth notes — two heads, two stems, a slanted beam
    np_note: (x, y) =>
        disc(x, y, 0.30, 0.74, 0.115) || disc(x, y, 0.68, 0.66, 0.115) ||
        (bar(x, 0.365, 0.425) && y >= slant(x) && y < f(0.74)) ||
        (bar(x, 0.745, 0.805) && y >= slant(x) && y < f(0.66)) ||
        (x >= f(0.365) && x < f(0.805) && y >= slant(x) && y < slant(x) + f(0.10)),
};

const disc = (x, y, cx, cy, r) => (x - f(cx)) ** 2 + (y - f(cy)) ** 2 <= f(r) ** 2;
const ring = (x, y, cx, cy, r1, r2) => {
    const d = (x - f(cx)) ** 2 + (y - f(cy)) ** 2;
    return d >= f(r1) ** 2 && d <= f(r2) ** 2;
};
// The beam's top edge, sloping up left→right like a real beam.
const slant = (x) => f(0.30) - (x - f(0.365)) * 0.18;

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

// A painter returns falsy (transparent), true (the set's flat white), or an
// [r, g, b] — which is what lets the medals be gold/silver/copper while the
// controls stay monochrome.
function render(paint) {
    const png = new PNG({ width: SIZE, height: SIZE });
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const i = (y * SIZE + x) * 4;
            const c = paint(x, y);
            if (!c) continue;
            const [r, g, b] = c === true ? [255, 255, 255] : c;
            png.data[i] = r;
            png.data[i + 1] = g;
            png.data[i + 2] = b;
            png.data[i + 3] = 255;
        }
    }
    return PNG.sync.write(png);
}

// Podium medals for the DJ badge — flat disc + ribbon in the metal's color,
// same visual weight as the white set. [face, rim] per rank.
const METALS = [
    [[0xff, 0xc9, 0x40], [0xb8, 0x86, 0x0b]], // gold
    [[0xc7, 0xcd, 0xd6], [0x8b, 0x93, 0x9e]], // silver
    [[0xc7, 0x7b, 0x45], [0x8c, 0x52, 0x2a]], // copper
];

function medalPainter([face, rim]) {
    return (x, y) => {
        // Ribbon: two slanted straps meeting in a V above the disc.
        const t = y / SIZE;
        if (t >= 0.06 && t < 0.44) {
            const spread = 0.20 - (t - 0.06) * 0.28; // straps converge downward
            const w = 0.085;
            if (Math.abs(x - f(0.5 - spread)) < f(w) || Math.abs(x - f(0.5 + spread)) < f(w)) return rim;
        }
        if (ring(x, y, 0.5, 0.62, 0.20, 0.27)) return rim; // rim
        if (disc(x, y, 0.5, 0.62, 0.20)) return face; // face
        return false;
    };
}
METALS.forEach((metal, i) => {
    GLYPHS[`np_medal${i + 1}`] = medalPainter(metal);
});

// Seven-segment digits 0-9 for the seek hotkeys — same flat white as the rest.
const SEGS = {
    A: (x, y) => bar(x, 0.28, 0.72) && bar(y, 0.10, 0.20),
    B: (x, y) => bar(x, 0.66, 0.78) && bar(y, 0.14, 0.52),
    C: (x, y) => bar(x, 0.66, 0.78) && bar(y, 0.48, 0.86),
    D: (x, y) => bar(x, 0.28, 0.72) && bar(y, 0.80, 0.90),
    E: (x, y) => bar(x, 0.22, 0.34) && bar(y, 0.48, 0.86),
    F: (x, y) => bar(x, 0.22, 0.34) && bar(y, 0.14, 0.52),
    G: (x, y) => bar(x, 0.28, 0.72) && bar(y, 0.45, 0.55),
};
const DIGIT_SEGS = ["ABCDEF", "BC", "ABGED", "ABGCD", "FGBC", "AFGCD", "AFGEDC", "ABC", "ABCDEFG", "ABCDFG"];
for (let d = 0; d <= 9; d++) {
    const segs = DIGIT_SEGS[d].split("").map((k) => SEGS[k]);
    GLYPHS[`np_d${d}`] = (x, y) => segs.some((seg) => seg(x, y));
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
