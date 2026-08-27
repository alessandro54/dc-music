// Autocomplete fires once per keystroke, and every one of those used to be a
// live Innertube round-trip (measured 414-516ms each, a repeat costing full
// price). These cover the three things that stop that.
import { assert, assertEquals } from "@std/assert";

const innertube = await import("@/discord/services/innertubeService.js");
const { _resetSearchCacheForTests, peekSearch, peekSearchPrefix, searchVideos } = innertube;

// Stub the client itself rather than the network: the cache is what is under
// test, and Innertube.create() would reach YouTube.
let searches = [];
const fakeYt = {
    search: (query) => {
        searches.push(query);
        return Promise.resolve({
            videos: [{ id: "abc", title: { text: `result for ${query}` }, duration: { seconds: 200 } }],
        });
    },
};

function setup() {
    searches = [];
    _resetSearchCacheForTests();
    innertube._setInnertubeForTests(fakeYt);
}

Deno.test("a repeated query never reaches YouTube twice", async () => {
    setup();
    await searchVideos("daft punk", 5);
    await searchVideos("daft punk", 5);
    // Normalisation, so casing and stray spacing are the same query.
    await searchVideos("  Daft   Punk ", 5);
    assertEquals(searches.length, 1);
});

Deno.test("two keystrokes in flight share one round-trip", async () => {
    setup();
    await Promise.all([searchVideos("bad bunny", 5), searchVideos("bad bunny", 1)]);
    assertEquals(searches.length, 1, "the second must join the first, not open its own");
});

Deno.test("results are cached at full width, so a narrower caller still hits", async () => {
    setup();
    await searchVideos("tego calderon", 10);
    assert(peekSearch("tego calderon", 1), "a 1-result peek must hit the 10-result entry");
    assertEquals(searches.length, 1);
});

Deno.test("the previous keystroke answers the next one instantly", async () => {
    setup();
    await searchVideos("tego cald", 5);
    // What the *next* keystroke sees: no exact entry, but a usable prefix one.
    assertEquals(peekSearch("tego calde", 5), null);
    assert(peekSearchPrefix("tego calde", 5), "typing forward narrows, so the prefix answer stands");
});

Deno.test("a short prefix is not treated as an answer", async () => {
    setup();
    await searchVideos("bad", 5);
    // "bad" and "bad bunny" have nothing to do with each other; serving the
    // former for the latter would be worse than waiting.
    assertEquals(peekSearchPrefix("bad bunny", 5), null);
});
