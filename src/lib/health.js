import { log } from "@/lib/logger.js";

// A readiness endpoint and nothing else. The dashboard that used to own the HTTP
// port is gone, and this is not its return: no auth, no state, no routes beyond
// /health, because its only consumer is Dokku's deploy healthcheck.
//
// It has to be HTTP. The first attempt used a `command` healthcheck
// (`test -f /tmp/bot-ready`), which the docker-local scheduler announces and then
// never runs — the deploy hung until SSH timed out, and the Dokku process kept
// looping on the host holding the app lock. `path` checks are that scheduler's
// native mode, so this is the shape that actually works.
export function startHealthServer(port, client) {
    Deno.serve({
        port: Number(port),
        onListen: ({ port: p }) => log.info(`health → :${p}/health`),
        // A probe hanging up mid-response is normal and must not page anyone.
        onError: () => new Response("error", { status: 500 }),
    }, (req) => {
        const { pathname } = new URL(req.url);
        if (req.method !== "GET" || pathname !== "/health") {
            return new Response("not found", { status: 404 });
        }

        // 200 means *connected to Discord*, not merely listening. This server
        // starts before client.login, so an unconditional 200 would report
        // healthy while the bot still can't play anything — and Dokku would kill
        // the old container on that promise. The 503 is what buys zero-downtime.
        const ready = client?.isReady() ?? false;
        return new Response(ready ? "ok" : "connecting", { status: ready ? 200 : 503 });
    });
}
