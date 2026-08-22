import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from "discord.js";

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

export function spawnRow(spawnId, { caught = false } = {}) {
    const button = new ButtonBuilder()
        .setCustomId(`${PK_PREFIX}${spawnId}`)
        .setEmoji("🔴")
        .setStyle(caught ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setLabel(caught ? "Caught" : "Throw a Pokéball")
        // A spent spawn says so on its own message, so nobody spends a ball
        // pressing a button that cannot win.
        .setDisabled(caught);
    return new ActionRowBuilder().addComponents(button);
}

const CAUGHT_FIELD = "Caught by";

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
        void markCaught(interaction, spawnId, spawn.caughtBy);
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
        if (fresh?.caughtBy) void markCaught(interaction, spawnId, fresh.caughtBy);
        return interaction.editReply(
            `Too slow — ${fresh?.caughtByTag ?? "someone else"} caught **${name}**.`,
        );
    }

    log.info(`[spawn] ${spawn.slug} (#${spawnId}) caught by ${interaction.user.tag}`);
    void markCaught(interaction, spawnId, userId);

    const left = await ballsFromRefill(guildId, userId);
    return interaction.editReply(`🎉 You caught **${name}**! ${left}`);
}

// Close the spawn publicly: who won belongs on the spawn message, not in an
// ephemeral reply only the winner sees. The mention makes it a name rather than a
// tag string, and a spent button stops anyone throwing a ball at a lost race.
//
// Best-effort throughout — the catch is already recorded, and a failed edit must
// never turn a win into an error. `files` is deliberately not passed: leaving it
// out keeps the existing sprite attachment, which the embed's image still points
// at via attachment://sprite.png.
async function markCaught(interaction, spawnId, winnerId) {
    try {
        const original = interaction.message.embeds[0];
        // Idempotent: every late presser lands here too, and addFields on an embed
        // that already carries the field would stack "Caught by" once per press.
        const embeds = original
            ? [
                EmbedBuilder.from(original)
                    .setFields(
                        ...(original.fields ?? []).filter((f) => f.name !== CAUGHT_FIELD),
                        { name: CAUGHT_FIELD, value: `<@${winnerId}>` },
                    ),
            ]
            : [];
        await interaction.message.edit({
            embeds,
            components: [spawnRow(spawnId, { caught: true })],
        });
    } catch (err) {
        log.warn(`[spawn] could not close #${spawnId}: ${err.message}`);
    }
}

async function ballsFromRefill(guildId, userId) {
    const next = await nextRefillAt(guildId, userId);
    return next ? `Next pokéball ${relative(next)}.` : `Pouch full (${LIMITS.POKEBALLS_MAX}).`;
}
