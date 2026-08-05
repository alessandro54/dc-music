import { defineCommand } from "@/discord/router.js";

export default defineCommand({
    name: "coinflip",
    description: "Flip a coin",
    handler: (interaction) => interaction.reply(Math.random() < 0.5 ? "🪙 Heads!" : "🪙 Tails!"),
});
