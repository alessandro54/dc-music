import { renderSpritePng } from "@/discord/services/spriteImageService.js";

const POKEMON_COLORSCRIPTS = Deno.env.get("POKEMON_COLORSCRIPTS_PATH") || "pokemon-colorscripts";

const dec = new TextDecoder();

// Returns { name, png } — png is a true-color raster of the sprite (Buffer).
export async function getRandomPokemon() {
    const { code, stdout, stderr } = await new Deno.Command(POKEMON_COLORSCRIPTS, {
        args: ["--random"],
        stdout: "piped",
        stderr: "piped",
    }).output();
    if (code !== 0) {
        throw new Error(`pokemon-colorscripts failed: ${dec.decode(stderr).trim() || "unknown error"}`);
    }
    // Output is "<name>\n<art>" — name line, then the sprite.
    const [name, ...artLines] = dec.decode(stdout).replace(/\n+$/, "").split("\n");
    const prettyName = name.trim().split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("-");
    const png = await renderSpritePng(artLines.join("\n"));
    return { name: prettyName, png };
}
