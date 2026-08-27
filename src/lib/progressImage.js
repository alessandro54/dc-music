// The panel's progress bar: the TUI block-meter aesthetic, drawn as a PNG. A
// text bar cannot fill the container — its rendered width depends on the
// viewer's window and font — while an image stretches to the container's width
// on every client. So the pixels imitate the terminal look instead of the
// terminal imitating a bar.
//
// Pure pixels, no I/O — pngjs like spriteImageService. Redrawn per panel edit
// (~3KB every 10s tick), which is noise next to the edit itself.
import { PNG } from "pngjs";

const W = 1120;
const H = 44;
// TUI-style segmented meter — discrete flat cells with gaps, like █░ blocks in
// a terminal, drawn as pixels so it can be flat AND full-width (a real text
// bar can't fill the container; see the media-gallery notes in the view). The
// leading edge fills its cell partially, which is the pixel version of the
// eighth-block characters the old text bar used.
const CELLS = 30;
const GAP = 8;
const CELL_W = (W - (CELLS - 1) * GAP) / CELLS;
const INSET = 6; // vertical inset — cells sit as a band, not edge to edge

const TRACK = [0x3f, 0x41, 0x47]; // unfilled cell — darker than Discord's grey, reads "off"
const FILL = [0x6b, 0xd5, 0xff]; // COLORS.ICE — the avatar's ice blue

export function renderProgressBar(ratio) {
    const t = Math.min(Math.max(ratio, 0), 1);
    const png = new PNG({ width: W, height: H });
    const filledPx = t * CELLS * CELL_W; // fill measured in cell-pixels, gaps excluded
    for (let cell = 0; cell < CELLS; cell++) {
        const x0 = cell * (CELL_W + GAP);
        // How much of THIS cell is lit: full for passed cells, fractional for
        // the leading one, none beyond it.
        const lit = Math.min(Math.max(filledPx - cell * CELL_W, 0), CELL_W);
        for (let y = INSET; y < H - INSET; y++) {
            for (let dx = 0; dx < CELL_W; dx++) {
                const color = dx < lit ? FILL : TRACK;
                const i = (y * W + Math.round(x0 + dx)) * 4;
                png.data[i] = color[0];
                png.data[i + 1] = color[1];
                png.data[i + 2] = color[2];
                png.data[i + 3] = 255;
            }
        }
    }
    return PNG.sync.write(png);
}
