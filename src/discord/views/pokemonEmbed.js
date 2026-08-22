import { prettyName } from "@/discord/services/pokemonService.js";
import { embed } from "@/discord/views/embeds.js";
import { COLORS } from "@/lib/constants.js";

// The pokédex card. Presentation only — the type palette and the stat bars are
// rendering choices, so they live here rather than in constants with the app's
// own colours.

// Series-standard type colours, so the embed's left edge reads as the type
// before anything is read.
const TYPE_COLORS = {
    normal: 0xa8a77a,
    fire: 0xee8130,
    water: 0x6390f0,
    electric: 0xf7d02c,
    grass: 0x7ac74c,
    ice: 0x96d9d6,
    fighting: 0xc22e28,
    poison: 0xa33ea1,
    ground: 0xe2bf65,
    flying: 0xa98ff3,
    psychic: 0xf95587,
    bug: 0xa6b91a,
    rock: 0xb6a136,
    ghost: 0x735797,
    dragon: 0x6f35fc,
    dark: 0x705746,
    steel: 0xb7b7ce,
    fairy: 0xd685ad,
};

const TYPE_EMOJI = {
    normal: "⬜",
    fire: "🔥",
    water: "💧",
    electric: "⚡",
    grass: "🌿",
    ice: "❄️",
    fighting: "🥊",
    poison: "☠️",
    ground: "⛰️",
    flying: "🪽",
    psychic: "🔮",
    bug: "🐛",
    rock: "🪨",
    ghost: "👻",
    dragon: "🐉",
    dark: "🌙",
    steel: "⚙️",
    fairy: "🧚",
};

// Not 255. That is the true ceiling (Blissey's HP) but almost nothing approaches
// it, so scaling to it squashed every real stat into 4-6 of 12 blocks — Garchomp's
// 130 attack and its 80 special attack drew nearly the same bar. Measured across a
// spread of pokémon, 200 over 16 blocks uses 15 of the 16 possible lengths where
// 255 over 12 used 11, and the only values that clip are the genuine outliers
// (Blissey 255, Shuckle 230), which read correctly as "off the chart" anyway.
// A per-pokémon relative scale was the other option and is worse: it would make
// Magikarp look as balanced as Mewtwo.
const STAT_MAX = 200;
const BAR_LENGTH = 16;

const STAT_LABELS = {
    "hp": "HP ",
    "attack": "Atk",
    "defense": "Def",
    "special-attack": "SpA",
    "special-defense": "SpD",
    "speed": "Spe",
};

// PokéAPI hyphenates multi-word names ("sand-veil", "special-attack"). Unlike a
// pokémon slug, where the hyphen is part of the name (nidoran-f, mr-mime), here it
// is just a word separator — so prettyName is wrong for these and produced
// "Sand-Veil".
function label(apiName) {
    return apiName.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

function statBar(value) {
    const filled = Math.max(1, Math.round((Math.min(value, STAT_MAX) / STAT_MAX) * BAR_LENGTH));
    return `${"█".repeat(filled)}${"░".repeat(BAR_LENGTH - filled)}`;
}

const ROMAN = {
    i: "I",
    ii: "II",
    iii: "III",
    iv: "IV",
    v: "V",
    vi: "VI",
    vii: "VII",
    viii: "VIII",
    ix: "IX",
};

function generationLabel(generation) {
    const numeral = generation?.split("-")[1];
    return numeral ? `Gen ${ROMAN[numeral] ?? numeral.toUpperCase()}` : null;
}

// `dex` is null when PokéAPI didn't answer — the card falls back to what /pokemon
// always showed (name + sprite) rather than failing.
export function pokemonCard(name, dex) {
    const e = embed().setImage("attachment://sprite.png");
    if (!dex) return e.setTitle(name);

    e.setColor(TYPE_COLORS[dex.types[0]] ?? COLORS.PRIMARY);
    e.setTitle(`#${String(dex.id).padStart(3, "0")}  ${name.toUpperCase()}`);

    const badges = [dex.genus, generationLabel(dex.generation)].filter(Boolean);
    if (dex.mythical) badges.push("✨ Mythical");
    else if (dex.legendary) badges.push("👑 Legendary");

    const types = dex.types.map((t) => `${TYPE_EMOJI[t] ?? ""} ${label(t)}`).join("   ");
    const description = [badges.join(" · "), "", types];
    // Italicised so the pokédex voice reads as a quotation rather than as the
    // bot's own copy.
    if (dex.flavor) description.push("", `*${dex.flavor}*`);
    e.setDescription(description.join("\n"));

    // One code block, not six inline fields: monospace is what keeps the bars
    // aligned, and Discord's field columns would break the grid at some widths.
    const stats = dex.stats
        .map((s) => `${STAT_LABELS[s.name] ?? s.name} ${statBar(s.value)} ${String(s.value).padStart(3)}`)
        .join("\n");
    e.addFields({ name: "Base stats", value: `\`\`\`\n${stats}\n\`\`\`` });

    const abilities = dex.abilities
        .map((a) => (a.hidden ? `${label(a.name)} (hidden)` : label(a.name)))
        .join(" · ");
    e.addFields(
        { name: "Abilities", value: abilities || "—", inline: false },
        { name: "Height", value: `${dex.heightM.toFixed(1)} m`, inline: true },
        { name: "Weight", value: `${dex.weightKg.toFixed(1)} kg`, inline: true },
    );
    return e;
}

// A wild spawn: the same card, framed as an encounter. The stats stay — a trainer
// deciding whether to spend one of five pokéballs on it wants to know what it is.
export function spawnCard(name, dex) {
    return pokemonCard(name, dex).setTitle(`❗ A wild ${name.toUpperCase()} appeared!`);
}

// A collection reads as a log of what someone found, newest first. Only the page
// is rendered; `total` is the real size so a truncated list says so instead of
// quietly looking complete.
export function collectionEmbed(user, rows, total, balls = null) {
    const e = embed().setTitle(`🎁 ${user.username}'s collection`);
    if (!rows.length) {
        return e.setDescription("Nothing caught yet — wild pokémon appear on their own; be first to throw.");
    }

    const lines = rows.map((row) => {
        const num = row.dexId ? `\`#${String(row.dexId).padStart(3, "0")}\`` : "`  — `";
        return `${num} ${prettyName(row.slug)}`;
    });
    e.setDescription(lines.join("\n"));

    const footer = [`${total} caught`];
    if (rows.length < total) footer.push(`showing the newest ${rows.length}`);
    if (balls !== null) footer.push(`${balls}/${LIMITS.POKEBALLS_MAX} pokéballs`);
    e.setFooter({ text: footer.join(" · ") });
    return e;
}
