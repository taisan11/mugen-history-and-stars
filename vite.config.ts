import { resolve } from "node:path";
import { defineConfig } from "vite";
import { webext } from "@taisan11/vite-plugin-webext";

export default defineConfig({
  plugins: [
    webext({
      defaultBrowser: "chrome",
      manifest: (browser) => ({
        manifest_version: 3,
        name: `Mugen History and Stars (${browser})`,
        version: "1.0.0",
        background:
          browser === "chrome"
            ? { service_worker: "src/background.ts", type: "module" }
            : { scripts: ["src/background.ts"], type: "module" },
        permissions: ["tabs", "storage", "bookmarks", "history"],
        host_permissions: ["http://*/*", "https://*/*"],
        omnibox: { keyword: "bm" },
        content_scripts: [
          {
            matches: ["http://*/*", "https://*/*"],
            js: ["src/content.ts"],
            // Install early so title updates during an SPA's initial render
            // are observed; later route changes are handled by history events.
            run_at: "document_start",
          },
        ],
        options_page: "src/options/index.html",
        action: {
          default_title: browser === "chrome" ? "ブックマーク" : "履歴",
          default_icon: {
            16: "bookmark-off-16.png",
            32: "bookmark-off-32.png",
          },
          ...(browser === "firefox" ? { default_area: "navbar" as const } : {}),
        },
        ...(browser === "firefox"
          ? {
              page_action: {
                default_title: "ブックマーク",
                default_icon: "bookmark-off.svg",
              },
            }
          : {}),
        ...(browser === "firefox"
          ? {
              browser_specific_settings: {
                gecko: {
                  id: "mugen-history-stars@yourdomain.local",
                },
              },
            }
          : {}),
        ...(browser === "chrome"
          ? {
              chrome_url_overrides: {
                history: "src/history/index.html",
                bookmark: "src/bookmarks/index.html",
              },
            }
          : {}),
      }),
    }),
  ],
  build: {
    rolldownOptions: {
      input: {
        history: resolve(import.meta.dirname, "src/history/index.html"),
        options: resolve(import.meta.dirname, "src/options/index.html"),
        bookmarks: resolve(import.meta.dirname, "src/bookmarks/index.html"),
      },
    },
  },
});
