import { join } from "node:path";

import { log } from "@/lib/logger.js";

const CONFIG_PATH = join(Deno.cwd(), "config.json");

let _config = {};
try {
    _config = JSON.parse(Deno.readTextFileSync(CONFIG_PATH));
    log.info(`config loaded from ${CONFIG_PATH}`);
} catch {
    // no config file yet — starts empty, written on first /setup
}

export function getConfig(guildId) {
    return _config[guildId] ?? {};
}

export function setConfig(guildId, patch) {
    _config[guildId] = { ..._config[guildId], ...patch };
    Deno.writeTextFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
}
