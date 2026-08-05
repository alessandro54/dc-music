import { MessageFlags } from "discord.js";

// Only the caller sees it — for refusals and validation errors, which is most of
// what commands reply with when something is wrong.
export const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
