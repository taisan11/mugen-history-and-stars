import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { webext } from '@taisan11/vite-plugin-webext'

export default defineConfig({
  plugins: [
    webext({
      defaultBrowser: 'chrome',
      manifest: (browser) => ({
        manifest_version: 3,
        name: `Mugen History and Stars (${browser})`,
        version: '1.0.0',
        background: {
          scripts: ['src/background.ts'],
          type: 'module',
        },
        permissions: ['tabs', 'storage', 'bookmarks'],
        host_permissions: ['http://*/*', 'https://*/*'],
        options_page: 'src/options/index.html',
        action: {
          default_title: '履歴',
          default_icon: {
            16: 'bookmark-off-16.png',
            32: 'bookmark-off-32.png',
          },
          ...(browser === 'firefox' ? { default_area: 'navbar' as const } : {}),
        },
        ...(browser === 'firefox'
          ? {
              page_action: {
                default_title: 'ブックマーク',
                default_icon: 'bookmark-off.svg',
              },
            }
          : {}),
        ...(browser === 'firefox'
          ? {
              browser_specific_settings: {
                gecko: {
                  id: 'mugen-history-stars@yourdomain.local',
                },
              },
            }
          : {}),
        ...(browser === 'chrome'
          ? {
              chrome_url_overrides: {
                history: 'src/history/index.html',
              },
            }
          : {}),
      }),
    }),
  ],
  build: {
    rolldownOptions: {
      input: {
        history: resolve(__dirname, 'src/history/index.html'),
        options: resolve(__dirname, 'src/options/index.html'),
        bookmarks: resolve(__dirname, 'src/bookmarks/index.html'),
      },
    },
  },
})
