import CONFIG_HTML from "./config.html" with { type: "text" };
import { getConfig, setConfig } from "./config.js";
import HTML from "./dashboard.html" with { type: "text" };
import { log } from "./logger.js";
import { captureError } from "./sentry.js";

function checkAuth(req, url) {
    const token = Deno.env.get("DASHBOARD_TOKEN");
    if (!token) return true;
    return (
        url.searchParams.get("token") === token ||
        req.headers.get("authorization") === `Bearer ${token}`
    );
}

function getState(queues, client) {
    return [...queues.entries()].map(([guildId, q]) => ({
        guildId,
        guildName: client.guilds.cache.get(guildId)?.name ?? guildId,
        playing: q.playing,
        paused: q.paused,
        current: q.current
            ? { title: q.current.title, duration: q.current.duration, requestedBy: q.current.requestedBy }
            : null,
        upcoming: q.songs.slice(1, 6).map((s) => ({ title: s.title, duration: s.duration })),
        total: q.songs.length,
    }));
}

function getGuilds(client) {
    return [...client.guilds.cache.values()].map((g) => ({
        id: g.id,
        name: g.name,
        channels: [...g.channels.cache.values()]
            .filter((c) => c.type === 0)
            .sort((a, b) => a.position - b.position)
            .map((c) => ({ id: c.id, name: c.name })),
        config: getConfig(g.id),
    }));
}

export function startServer(port, queues, client) {
    Deno.serve({
        port: Number(port),
        onListen: ({ hostname, port: p }) => {
            const token = Deno.env.get("DASHBOARD_TOKEN");
            const host = Deno.env.get("DASHBOARD_HOST") ?? hostname;
            const qs = token ? `?token=${token}` : "";
            log.info(`dashboard → http://${host}:${p}/${qs}`);
        },
        onError: (err) => {
            log.error(`[dashboard] ${err.message}`);
            captureError(err, { tags: { stage: "dashboard" } });
            return new Response("Internal error", { status: 500 });
        },
    }, async (req) => {
        const url = new URL(req.url);

        if (!checkAuth(req, url)) {
            return new Response("Unauthorized", { status: 401 });
        }

        if (req.method === "GET" && url.pathname === "/") {
            return new Response(HTML, { headers: { "Content-Type": "text/html" } });
        }

        if (req.method === "GET" && url.pathname === "/config") {
            return new Response(CONFIG_HTML, { headers: { "Content-Type": "text/html" } });
        }

        if (req.method === "GET" && url.pathname === "/api/guilds") {
            return new Response(JSON.stringify(getGuilds(client)), {
                headers: { "Content-Type": "application/json" },
            });
        }

        if (req.method === "POST" && url.pathname.match(/^\/config\/\d+$/)) {
            const guildId = url.pathname.split("/")[2];
            const patch = Object.fromEntries(new URLSearchParams(await req.text()));
            setConfig(guildId, patch);
            return new Response("OK");
        }

        if (req.method === "GET" && url.pathname === "/events") {
            const enc = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    let last = "";
                    let stopped = false;
                    const send = () => {
                        if (stopped) return;
                        try {
                            const payload = JSON.stringify(getState(queues, client));
                            if (payload === last) return;
                            last = payload;
                            controller.enqueue(enc.encode(`data: ${payload}\n\n`));
                        } catch {
                            // Client gone / controller closed without an abort event —
                            // flag so the interval stops firing (and throwing) forever.
                            stopped = true;
                        }
                    };
                    send();
                    const interval = setInterval(() => {
                        send();
                        if (stopped) clearInterval(interval);
                    }, 2000);
                    req.signal.addEventListener("abort", () => {
                        clearInterval(interval);
                        try { controller.close(); } catch {}
                    });
                },
            });
            return new Response(stream, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                },
            });
        }

        const action = url.pathname.match(/^\/guilds\/(\d+)\/(skip|pause|stop)$/);
        if (req.method === "POST" && action) {
            const [, guildId, cmd] = action;
            const q = queues.get(guildId);
            if (!q) return new Response("Not found", { status: 404 });
            if (cmd === "skip") q.skip();
            else if (cmd === "pause") q.paused ? q.resume() : q.pause();
            else if (cmd === "stop") q.stop();
            return new Response("OK");
        }

        return new Response("Not found", { status: 404 });
    });
}
