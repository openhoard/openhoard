import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` diffs src/schema.ts against migrations/ and writes the next migration.
// Hand-written SQL (roles, row-level security, triggers) goes in `drizzle-kit generate --custom`
// migrations, which drizzle-kit keeps in order with the generated ones.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
