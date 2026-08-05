// Plain object (no defineConfig import) so drizzle-kit's config loader
// works when invoked through Deno (`deno task db:generate`).
export default {
    dialect: "turso",
    schema: "./src/db/schema.js",
    out: "./src/db/migrations",
};
