import { embed } from "@/discord/views/embeds.js";
import { COMMIT, COMMIT_URL } from "@/lib/buildInfo.js";

function fmtUptime(s) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s % 60}s`;
}

export function healthEmbed(h) {
    const queueLines = h.guilds.length
        ? h.guilds
            .map((g) => `\`${g.state}\` · ${g.current ?? "—"} · ${g.queued} queued · voice:\`${g.voice}\``)
            .join("\n")
        : "No active queues";

    return embed()
        .setTitle("🩺 Bot Health")
        .addFields(
            { name: "Memory (RSS)", value: `${h.rssMb} MB`, inline: true },
            { name: "Heap", value: `${h.heapMb} MB`, inline: true },
            { name: "Live streams", value: `${h.streams}`, inline: true },
            { name: "Ping", value: `${h.ping} ms`, inline: true },
            { name: "Uptime", value: fmtUptime(h.uptimeS), inline: true },
            {
                name: "Revision",
                value: COMMIT_URL ? `[\`${COMMIT}\`](${COMMIT_URL})` : `\`${COMMIT}\``,
                inline: true,
            },
            { name: "Queues", value: queueLines },
        );
}
