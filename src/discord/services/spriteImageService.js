import { Buffer } from "node:buffer";
import { PNG } from "pngjs";

// pokemon-colorscripts draws each sprite with the classic terminal half-block
// trick: one character cell = 1px wide x 2px tall.
//   '▀' (upper half block) -> top pixel = current fg, bottom pixel = current bg
//   '▄' (lower half block) -> top pixel = transparent, bottom pixel = current fg
//   ' ' (space)            -> both pixels transparent, regardless of any
//                             lingering fg/bg state
// Matching the ESC byte is the point here — this parses ANSI escape codes.
// deno-lint-ignore no-control-regex
const SGR_OR_CHAR = /\x1b\[([0-9;]*)m|([\s\S])/g;

function parseRgb(params) {
    const parts = params.split(";").slice(2).map(Number);
    return parts.length === 3 ? parts : null;
}

// Walks one line's SGR-interleaved text into two rows of pixels (top/bottom).
function parseLine(line) {
    const top = [];
    const bottom = [];
    let fg = null;
    let bg = null;
    for (const m of line.matchAll(SGR_OR_CHAR)) {
        const [, params, ch] = m;
        if (params !== undefined) {
            if (params === "" || params === "0") fg = bg = null;
            else if (params.startsWith("38;2;")) fg = parseRgb(params);
            else if (params.startsWith("48;2;")) bg = parseRgb(params);
            continue;
        }
        if (ch === "▀") {
            top.push(fg);
            bottom.push(bg);
        } else if (ch === "▄") {
            top.push(null);
            bottom.push(fg);
        } else {
            top.push(null);
            bottom.push(null);
        }
    }
    return { top, bottom };
}

// Renders a pokemon-colorscripts truecolor sprite to a scaled-up PNG buffer,
// preserving its real RGB colors (Discord's ansi codeblock only has 8 muddy
// colors and can't represent this sprite data faithfully).
export function renderSpritePng(art, scale = 8) {
    const pixelRows = [];
    let width = 0;
    for (const line of art.split("\n")) {
        const { top, bottom } = parseLine(line);
        pixelRows.push(top, bottom);
        width = Math.max(width, top.length);
    }
    const height = pixelRows.length;

    const png = new PNG({ width: width * scale, height: height * scale });
    for (let y = 0; y < height; y++) {
        const row = pixelRows[y];
        for (let x = 0; x < width; x++) {
            const px = row[x];
            for (let sy = 0; sy < scale; sy++) {
                const oy = y * scale + sy;
                for (let sx = 0; sx < scale; sx++) {
                    const idx = (width * scale * oy + (x * scale + sx)) << 2;
                    if (px) {
                        png.data[idx] = px[0];
                        png.data[idx + 1] = px[1];
                        png.data[idx + 2] = px[2];
                        png.data[idx + 3] = 255;
                    } else {
                        png.data[idx + 3] = 0;
                    }
                }
            }
        }
    }

    return new Promise((resolve, reject) => {
        const chunks = [];
        png.pack()
            .on("data", (d) => chunks.push(d))
            .on("end", () => resolve(Buffer.concat(chunks)))
            .on("error", reject);
    });
}
