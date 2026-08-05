import { EmbedBuilder } from "discord.js";

import { COLORS } from "@/lib/constants.js";

export const embed = (color = COLORS.PRIMARY) => new EmbedBuilder().setColor(color);
