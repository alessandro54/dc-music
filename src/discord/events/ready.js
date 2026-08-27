import { loadAppEmojis } from "@/discord/services/appEmojiService.js";
import { log } from "@/lib/logger.js";

export default {
    name: "clientReady",
    once: true,
    execute(client) {
        log.info(
            `${log.bold(client.user.tag)} ready — ${client.guilds.cache.size} guild(s)`,
        );
        client.user.setActivity("/help");
        // Not awaited: the panel's emoji lookups fall back to unicode until
        // (and unless) this lands.
        void loadAppEmojis(client);
    },
};
