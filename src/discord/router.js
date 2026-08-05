import { SlashCommandBuilder } from "discord.js";

// A route: the command's shape (name, description, options) declared next to the
// handler that serves it. `defineCommand` builds the discord.js `data` for you —
// `options` still receives the real SlashCommandBuilder, so the full builder API
// (subcommands, choices, min/max) stays available.
//
// `guard` is route middleware: it returns a value the handler needs, or null to
// abort (having already replied). That removes the `if (!queue) return` prologue
// from every handler, and with it the chance of forgetting it.
//
//   guard(interaction) -> value | null
//   handler(interaction, value)
//
// `client` is not passed — use `interaction.client`.
export function defineCommand({ name, description, options, permissions, guard, handler, autocomplete }) {
    const data = new SlashCommandBuilder().setName(name).setDescription(description);
    if (permissions) data.setDefaultMemberPermissions(permissions);
    if (options) options(data);

    return {
        name,
        data,
        autocomplete,
        async execute(interaction) {
            if (!guard) return await handler(interaction);
            const value = await guard(interaction);
            if (value == null) return; // guard replied with the reason
            return await handler(interaction, value);
        },
    };
}

// Collects routes into groups, the way an app includes one router per module.
// Groups are not cosmetic: `/help` renders itself from them, so a new command
// shows up in help by being registered here and nowhere else.
export function createRouter() {
    const groups = [];
    const byName = new Map();

    return {
        include(title, commands, { label, hidden = false } = {}) {
            for (const command of commands) {
                if (!command?.data?.name) {
                    throw new Error(`${title}: registered a command with no data.name`);
                }
                const existing = byName.get(command.data.name);
                if (existing) {
                    throw new Error(`duplicate command /${command.data.name} in ${existing} and ${title}`);
                }
                byName.set(command.data.name, title);
            }
            groups.push({ title, label: label ?? title, commands, hidden });
            return this;
        },
        all() {
            return groups.flatMap((g) => g.commands);
        },
        // For /help — hidden groups (owner/admin tooling) stay out.
        visibleGroups() {
            return groups.filter((g) => !g.hidden).map((g) => ({
                label: g.label,
                names: g.commands.map((c) => c.data.name),
            }));
        },
    };
}
