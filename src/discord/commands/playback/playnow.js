import { definePlay } from "@/discord/commands/playback/play/define.js";

export default definePlay({
    name: "playnow",
    description: "Queue a song or playlist next, ahead of everything else",
    next: true,
});
