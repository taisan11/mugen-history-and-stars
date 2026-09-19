import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid(), cloudflare()],
  environments: {
    client: {
      build: {
        rolldownOptions: {
          input: {
            app: resolve(import.meta.dirname, "index.html"),
            admin: resolve(import.meta.dirname, "admin-sasisuseso.html"),
          },
        },
      },
    },
  },
});
