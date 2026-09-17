import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./backend/schema.ts",
  out: "./drizzle/",
  strict: true,
  verbose: true,
});
