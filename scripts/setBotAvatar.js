// Set the bot user's avatar from a local image — including an ANIMATED GIF,
// which the developer portal's file picker refuses to even select (its accept
// list omits image/gif, whatever the label claims). The API takes it: bots may
// carry animated avatars, there is just no UI for it.
//
//   deno run --allow-all --env-file=.env scripts/setBotAvatar.js path/to/avatar.gif
//
// Uses BOT_TOKEN from the env, so point --env-file at whichever bot should
// wear it. Avatars render small (~240px max), so the 512px original beats an
// upscaled one — upload limit is 10MB.
const [path] = Deno.args;
if (!path) throw new Error("usage: setBotAvatar.js <image path>");
const token = Deno.env.get("BOT_TOKEN");
if (!token) throw new Error("BOT_TOKEN not set");

const bytes = await Deno.readFile(path);
if (bytes.length > 10 * 1024 * 1024) throw new Error(`${(bytes.length / 1e6).toFixed(1)}MB — over 10MB`);
const type = path.endsWith(".gif") ? "gif" : path.endsWith(".jpg") ? "jpeg" : "png";
let b64 = "";
// Chunked: String.fromCharCode(...allBytes) blows the arg limit on real files.
for (let i = 0; i < bytes.length; i += 32768) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + 32768));
}
const res = await fetch("https://discord.com/api/v10/users/@me", {
    method: "PATCH",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ avatar: `data:image/${type};base64,${btoa(b64)}` }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const user = await res.json();
console.log(`avatar set for ${user.username} — animated: ${user.avatar?.startsWith("a_")}`);
