import { log } from "@/lib/logger.js";
import { READY_FILE } from "@/lib/constants.js";

export default {
    name: "clientReady",
    once: true,
    async execute(client) {
        log.info(
            `${log.bold(client.user.tag)} ready — ${client.guilds.cache.size} guild(s)`,
        );
        client.user.setActivity("/help");

        // Dokku's startup healthcheck polls for this file (see app.json), so the
        // deploy waits for a real Discord login rather than for the process to
        // merely exist — a bad token now fails the release instead of shipping a
        // bot that is up but can't play anything. Written here, on the one event
        // that proves the gateway connection.
        //
        // Best-effort: a bot that is connected but couldn't write /tmp is still a
        // working bot, so a failure here logs rather than throws. The healthcheck
        // failing on its own would already tell us.
        try {
            await Deno.writeTextFile(READY_FILE, String(Date.now()));
        } catch (err) {
            log.warn(`could not write ${READY_FILE}: ${err.message}`);
        }
    },
};
