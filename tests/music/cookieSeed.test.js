// The config var is a *seed*, not the authority. yt-dlp rewrites the jar on every
// exit because YouTube rotates session tokens as they're used, so a jar on disk
// can be newer than the var it came from — overwriting it every boot replays a
// stale snapshot, which is what invalidates the session.
import { assert, assertEquals } from "@std/assert";

const { _seedCookiesForTests } = await import("@/discord/services/ytdlpService.js");

const ENV = "# Netscape HTTP Cookie File\nseeded";
const ROTATED = "# Netscape HTTP Cookie File\nrotated";

function withDir(fn) {
    const dir = Deno.makeTempDirSync();
    try {
        return fn(dir);
    } finally {
        Deno.removeSync(dir, { recursive: true });
    }
}

Deno.test("a first boot writes the config var to disk", () => {
    withDir((dir) => {
        const res = _seedCookiesForTests(ENV, dir);
        assertEquals(res.reason, "seeded from config var");
        assertEquals(Deno.readTextFileSync(res.file), ENV);
    });
});

Deno.test("an unchanged config var keeps the rotated jar", () => {
    withDir((dir) => {
        const first = _seedCookiesForTests(ENV, dir);
        // yt-dlp rewrites the jar with refreshed tokens.
        Deno.writeTextFileSync(first.file, ROTATED);

        const res = _seedCookiesForTests(ENV, dir);
        assertEquals(res.reason, "persisted jar (config var unchanged)");
        assertEquals(
            Deno.readTextFileSync(res.file),
            ROTATED,
            "reseeding here would undo the token refresh and kill the session",
        );
    });
});

Deno.test("a changed config var wins — that is the operator re-exporting", () => {
    withDir((dir) => {
        _seedCookiesForTests(ENV, dir);
        Deno.writeTextFileSync(`${dir}/yt-cookies.txt`, ROTATED);

        const fresh = "# Netscape HTTP Cookie File\nfresh export";
        const res = _seedCookiesForTests(fresh, dir);
        assertEquals(res.reason, "config var changed — reseeded");
        assertEquals(Deno.readTextFileSync(res.file), fresh);
    });
});

Deno.test("no config var still uses a jar left on the volume", () => {
    withDir((dir) => {
        Deno.writeTextFileSync(`${dir}/yt-cookies.txt`, ROTATED);
        const res = _seedCookiesForTests(undefined, dir);
        assertEquals(res.reason, "persisted jar, no config var set");
        assert(res.hasCookies, "the jar on disk is usable on its own");
    });
});

Deno.test("nothing anywhere means no cookies, not a crash", () => {
    withDir((dir) => {
        const res = _seedCookiesForTests(undefined, dir);
        assertEquals(res.reason, null);
        assert(!res.hasCookies);
    });
});
