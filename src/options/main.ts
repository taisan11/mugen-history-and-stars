/// <reference types="@taisan11/vite-plugin-webext/types" />
import { addBookmarks, getAllBookmarks, type BookmarkInput } from '../db.ts'
import { generateSyncSecret, getSyncSettings, requestSync, saveSyncSettings, type SyncResult } from '../sync.ts'
import './style.css'

const DEFAULT_PER_PAGE = 500

const app = document.querySelector<HTMLDivElement>('#app')!

function getStorage(): Promise<{ perPage: number }> {
  return browser.storage.local.get('perPage').then((data) => ({
    perPage: (data as { perPage?: number }).perPage ?? DEFAULT_PER_PAGE,
  }))
}

function setStorage(value: { perPage: number }): Promise<void> {
  return browser.storage.local.set(value)
}

function isImportableUrl(url: string): boolean {
  return /^(https?|file):/i.test(url)
}

function escapeHtml(value: string): string {
  const div = document.createElement('div')
  div.textContent = value
  return div.innerHTML
}

async function importBrowserBookmarks(): Promise<{ imported: number; duplicates: number; unsupported: number }> {
  const [tree, existing] = await Promise.all([
    browser.bookmarks.getTree(),
    getAllBookmarks(),
  ])
  const knownUrls = new Set(existing.map((bookmark) => bookmark.url))
  const entries: BookmarkInput[] = []
  let duplicates = 0
  let unsupported = 0

  const visit = (node: browser.bookmarks.BookmarkTreeNode) => {
    if (node.url) {
      if (!isImportableUrl(node.url)) {
        unsupported++
      } else if (knownUrls.has(node.url)) {
        duplicates++
      } else {
        knownUrls.add(node.url)
        entries.push({
          url: node.url,
          name: node.title || node.url,
          favicon: '',
          createdAt: node.dateAdded,
        })
      }
    }
    node.children?.forEach(visit)
  }

  tree.forEach(visit)
  await addBookmarks(entries)
  return { imported: entries.length, duplicates, unsupported }
}

function syncMessage(result: SyncResult): string {
  if (!result.enabled) return '同期は無効です'
  return `同期完了（送信 ${result.uploaded}件、受信 ${result.downloaded}件）`
}

async function init() {
  const [{ perPage }, syncSettings] = await Promise.all([getStorage(), getSyncSettings()])

  app.innerHTML = `
    <h1>設定</h1>
    <div class="setting">
      <label for="perPage">1ページあたりの履歴件数</label>
      <input type="number" id="perPage" min="10" max="10000" step="10" value="${perPage}" />
    </div>
    <div class="setting bookmark-import-setting">
      <h2>ブックマーク</h2>
      <p>ブラウザに保存されているブックマークを、この拡張機能に取り込みます。</p>
      <button type="button" id="import-bookmarks">ブラウザからインポート</button>
      <div id="import-status" role="status" aria-live="polite"></div>
    </div>
    <div class="setting sync-setting">
      <h2>同期</h2>
      <p>同期秘密鍵はサーバーへ送信されません。同期する端末間で同じ秘密鍵を設定してください。</p>
      <label for="sync-url">サーバーURL</label>
      <input type="url" id="sync-url" placeholder="https://example.com" value="${escapeHtml(syncSettings.syncUrl)}" />
      <label for="sync-secret">同期秘密鍵</label>
      <div class="secret-row">
        <input type="password" id="sync-secret" autocomplete="off" value="${escapeHtml(syncSettings.syncSecret)}" />
        <button type="button" id="generate-secret">生成</button>
      </div>
      <div class="sync-actions">
        <button type="button" id="save-sync">保存</button>
        <button type="button" id="sync-now">今すぐ同期</button>
      </div>
      <div id="sync-status" role="status" aria-live="polite"></div>
    </div>
    <div id="status"></div>
  `

  const input = document.querySelector<HTMLInputElement>('#perPage')!
  const status = document.querySelector<HTMLDivElement>('#status')!

  input.addEventListener('change', async () => {
    const val = Math.max(10, Math.min(10000, Number(input.value) || DEFAULT_PER_PAGE))
    input.value = String(val)
    await setStorage({ perPage: val })
    status.textContent = '保存しました'
    setTimeout(() => { status.textContent = '' }, 1500)
  })

  const importButton = document.querySelector<HTMLButtonElement>('#import-bookmarks')!
  const importStatus = document.querySelector<HTMLDivElement>('#import-status')!
  importButton.addEventListener('click', async () => {
    importButton.disabled = true
    importStatus.textContent = 'ブラウザのブックマークを読み込んでいます…'
    try {
      const result = await importBrowserBookmarks()
      const details = [`${result.imported}件追加`, `${result.duplicates}件重複`]
      if (result.unsupported > 0) details.push(`${result.unsupported}件対象外`)
      importStatus.textContent = `インポート完了（${details.join('、')}）`
      void requestSync().catch((error: unknown) => console.error('Sync failed', error))
    } catch (error) {
      console.error('Failed to import browser bookmarks', error)
      importStatus.textContent = 'インポートに失敗しました。権限を確認してください。'
    } finally {
      importButton.disabled = false
    }
  })

  const syncUrl = document.querySelector<HTMLInputElement>('#sync-url')!
  const syncSecret = document.querySelector<HTMLInputElement>('#sync-secret')!
  const generateButton = document.querySelector<HTMLButtonElement>('#generate-secret')!
  const saveSyncButton = document.querySelector<HTMLButtonElement>('#save-sync')!
  const syncNowButton = document.querySelector<HTMLButtonElement>('#sync-now')!
  const syncStatus = document.querySelector<HTMLDivElement>('#sync-status')!

  generateButton.addEventListener('click', () => {
    syncSecret.value = generateSyncSecret()
    syncSecret.type = 'text'
  })

  const runSync = async () => {
    syncNowButton.disabled = true
    syncStatus.textContent = '同期しています…'
    try {
      syncStatus.textContent = syncMessage(await requestSync())
    } catch (error) {
      console.error('Sync failed', error)
      syncStatus.textContent = error instanceof Error ? error.message : '同期に失敗しました'
    } finally {
      syncNowButton.disabled = false
    }
  }

  syncNowButton.addEventListener('click', () => { void runSync() })
  saveSyncButton.addEventListener('click', async () => {
    saveSyncButton.disabled = true
    syncStatus.textContent = '設定を保存しています…'
    try {
      await saveSyncSettings(syncUrl.value.trim(), syncSecret.value)
      syncStatus.textContent = syncMessage(await requestSync())
    } catch (error) {
      console.error('Failed to save sync settings', error)
      syncStatus.textContent = error instanceof Error ? error.message : '同期設定の保存に失敗しました'
    } finally {
      saveSyncButton.disabled = false
    }
  })
}

init()
