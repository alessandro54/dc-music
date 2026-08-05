import debug from "@/discord/commands/admin/debug.js";
import setcookies from "@/discord/commands/admin/setcookies.js";
import setup from "@/discord/commands/admin/setup.js";
import coinflip from "@/discord/commands/fun/coinflip.js";
import pokemon from "@/discord/commands/fun/pokemon.js";
import poll from "@/discord/commands/fun/poll.js";
import help from "@/discord/commands/info/help.js";
import serverinfo from "@/discord/commands/info/serverinfo.js";
import kick from "@/discord/commands/moderation/kick.js";
import timeout from "@/discord/commands/moderation/timeout.js";
import { pause, resume, skip, stop } from "@/discord/commands/playback/controls.js";
import history from "@/discord/commands/playback/history.js";
import np from "@/discord/commands/playback/np.js";
import play from "@/discord/commands/playback/play/index.js";
import queue from "@/discord/commands/playback/queue.js";
import seek from "@/discord/commands/playback/seek.js";
import leaderboard from "@/discord/commands/tracks/leaderboard.js";
import { createRouter } from "@/discord/router.js";

// The route table. Adding a command means importing it and listing it here —
// nothing scans the filesystem, so the set of live commands is greppable and
// `deno check` still sees the whole graph.
//
// Group labels are what /help renders, so a command joins the help output by
// being registered. `hidden` keeps owner tooling out of it.
export const router = createRouter()
    .include("playback", [play, pause, resume, skip, stop, seek, queue, np, history], {
        label: "🎵 Music",
    })
    .include("tracks", [leaderboard], { label: "📈 Tracks" })
    .include("moderation", [kick, timeout], { label: "🛡️ Moderation" })
    .include("fun", [coinflip, poll, pokemon], { label: "🎮 Fun" })
    .include("info", [help, serverinfo], { label: "ℹ️ Info" })
    .include("admin", [debug, setcookies, setup], { hidden: true });

export const commands = router.all();
