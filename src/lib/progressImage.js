// The panel's progress bar, drawn as a PNG. A text bar cannot fill the
// container — its rendered width depends on the viewer's window and font,
// while an image in a Components V2 media gallery stretches to the container's
// width on every client. Same reason FlaviBot's bar looks "real": it is one.
//
// Pure pixels, no I/O — pngjs like spriteImageService. Redrawn per panel edit
// (~3KB every 10s tick), which is noise next to the edit itself.
import { PNG } from "pngjs";

const W = 1120;
const H = 56;
const CY = H / 2;
const TRACK_R = 9;
const KNOB_R = 17;
const PAD = KNOB_R + 2; // the knob must not clip at 0% / 100%

const TRACK = [0x4e, 0x50, 0x58]; // Discord's muted grey
const FILL = [0x58, 0x65, 0xf2]; // COLORS.PRIMARY blurple
const KNOB = [0xff, 0xff, 0xff];

// Capsule: distance from the horizontal segment's centerline.
function inCapsule(x, y, x0, x1, r) {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    return (x - cx) ** 2 + (y - CY) ** 2 <= r ** 2;
}

export function renderProgressBar(ratio) {
    const t = Math.min(Math.max(ratio, 0), 1);
    const png = new PNG({ width: W, height: H });
    const knobX = PAD + t * (W - 2 * PAD);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let color = null;
            if ((x - knobX) ** 2 + (y - CY) ** 2 <= KNOB_R ** 2) color = KNOB;
            else if (inCapsule(x, y, PAD, knobX + TRACK_R, TRACK_R) && knobX > PAD) color = FILL;
            else if (inCapsule(x, y, PAD, W - PAD, TRACK_R)) color = TRACK;
            if (!color) continue;
            const i = (y * W + x) * 4;
            png.data[i] = color[0];
            png.data[i + 1] = color[1];
            png.data[i + 2] = color[2];
            png.data[i + 3] = 255;
        }
    }
    return PNG.sync.write(png);
}
