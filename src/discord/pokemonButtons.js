import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";

import {
    claimSpawn,
    getSpawn,
    nextRefillAt,
    ownsSpecies,
    prettyName,
    refundBall,
    spendBall,
} from "@/discord/services/pokemonService.js";
import { LIMITS } from "@/lib/constants.js";
import { log } from "@/lib/logger.js";

// The Catch button under a wild spawn. Its own file rather than buttons.js: that
// one is the Now Playing transport and its guard ("are you in the voice channel")
// has nothing to say about catching a pokémon.
export const PK_PREFIX = "pk:catch:";

export function spawnRow(spawnId, { caught = false, byTag = null } = {}) {
    const button = new ButtonBuilder()
        .setCustomId(`${PK_PREFIX}${spawnId}`)
        .setEmoji("🔴")
        .setStyle(caught ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setLabel(caught ? `Caught by ${byTag ?? "someone"}` : "Throw a Pokéball")
        // A spent spawn says so on its own message, so nobody spends a ball
        // pressing a button that cannot win.
        .setDisabled(caught);
    return new ActionRowBuilder().addComponents(button);
}

const relative = (date) => `<t:${Math.floor(date.getTime() / 1000)}:R>`;

export async function handleCatchButton(interaction) {
    const spawnId = Number(interaction.customId.slice(PK_PREFIX.length));
    // Ephemeral: several people race one spawn, and only the winner's result is
    // anyone else's business — which the message edit below announces instead.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const spawn = await getSpawn(spawnId);
    if (!spawn) return interaction.editReply("That pokémon is long gone.");
    const name = prettyName(spawn.slug);

    if (spawn.caughtBy) {
        void markCaught(interaction, spawnId, spawn.caughtByTag);
        return interaction.editReply(
            `**${name}** was already caught by ${spawn.caughtByTag ?? "someone else"}.`,
        );
    }

    const { guildId } = interaction;
    const userId = interaction.user.id;

    // Checked before any ball is spent: owning it already is not a failed throw.
    if (await ownsSpecies(guildId, userId, spawn.slug)) {
        return interaction.editReply(`You already have **${name}** — save your pokéballs.`);
    }

    const spent = await spendBall(guildId, userId, interaction.user.tag);
    if (!spent.ok) {
        if (spent.reason === "unavailable") {
            return interaction.editReply("Can't reach your pokéballs right now — try again shortly.");
        }
        const when = spent.nextRefillAt ? relative(spent.nextRefillAt) : "soon";
        return interaction.editReply(`🔴 Out of pokéballs — next one ${when}.`);
    }

    const claim = await claimSpawn({
        spawnId,
        guildId,
        userId,
        userTag: interaction.user.tag,
        slug: spawn.slug,
    });
    if (!claim.ok) {
        // Losing the race costs nothing. The spend happens first because a charge
        // is cheap to give back and a claim is not.
        await refundBall(guildId, userId);
        const fresh = await getSpawn(spawnId);
        void markCaught(interaction, spawnId, fresh?.caughtByTag);
        return interaction.editReply(
            `Too slow — ${fresh?.caughtByTag ?? "someone else"} caught **${name}**.`,
        );
    }

    log.info(`[spawn] ${spawn.slug} (#${spawnId}) caught by ${interaction.user.tag}`);
    void markCaught(interaction, spawnId, interaction.user.tag);

    const left = await ballsFromRefill(guildId, userId);
    return interaction.editReply(`🎉 You caught **${name}**! ${left}`);
}

// Close the spawn message so the next reader sees it is over. Best-effort: the
// catch is already recorded, and a failed edit must not turn a win into an error.
async function markCaught(interaction, spawnId, byTag) {
    try {
        await interaction.message.edit({ components: [spawnRow(spawnId, { caught: true, byTag })] });
    } catch (err) {
        log.warn(`[spawn] could not close #${spawnId}: ${err.message}`);
    }
}

async function ballsFromRefill(guildId, userId) {
    const next = await nextRefillAt(guildId, userId);
    return next ? `Next pokéball ${relative(next)}.` : `Pouch full (${LIMITS.POKEBALLS_MAX}).`;
}
