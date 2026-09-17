/// <reference types="@taisan11/vite-plugin-webext/types" />
import {
  addBookmarks,
  addVisits,
  getAllBookmarks,
  getAllVisits,
  resetDatabase,
  updateBookmark,
  type BookmarkInput,
} from "../db.ts";
import { getBookmarkFolders, saveBookmarkFolders } from "../bookmark-folders.ts";
import {
  generateSyncSecret,
  getSyncSettings,
  requestSync,
  saveSyncSettings,
  type SyncResult,
} from "../sync.ts";
// import { extensionApi } from "../extension-api.ts";
import "./style.css";

const DEFAULT_PER_PAGE = 200;
const MAX_PER_PAGE = 2_000;
const BROWSER_ROOT_FOLDERS = new Set([
  "ブックマーク バー",
  "その他のブックマーク",
  "モバイルのブックマーク",
  "Bookmarks bar",
  "Other bookmarks",
  "Mobile bookmarks",
]);

const app = document.querySelector<HTMLDivElement>("#app")!;

function getStorage(): Promise<{ perPage: number }> {
  return browser.storage.local.get("perPage").then((data) => {
    const value = (data as { perPage?: number }).perPage;
    return {
      perPage: Math.max(
        10,
        Math.min(MAX_PER_PAGE, Number.isFinite(value) ? value! : DEFAULT_PER_PAGE),
      ),
    };
  });
}

function setStorage(value: { perPage: number }): Promise<void> {
  return browser.storage.local.set(value);
}

function isImportableUrl(url: string): boolean {
  return /^(https?|file):/i.test(url);
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function normalizeBrowserFolder(folder: string): string {
  const parts = folder.split(" / ");
  if (BROWSER_ROOT_FOLDERS.has(parts[0])) parts.shift();
  return parts.join(" / ");
}

async function downloadBackup(): Promise<{ visits: number; bookmarks: number }> {
  const [visits, bookmarks, folders] = await Promise.all([
    getAllVisits(),
    getAllBookmarks(),
    getBookmarkFolders(),
  ]);
  const backup = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    visits,
    bookmarks,
    folders,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `mugen-history-backup-${date}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { visits: visits.length, bookmarks: bookmarks.length };
}

async function importBrowserBookmarks(): Promise<{
  imported: number;
  duplicates: number;
  unsupported: number;
}> {
  const [tree, existing, savedFolders] = await Promise.all([
    browser.bookmarks.getTree(),
    getAllBookmarks(),
    getBookmarkFolders(),
  ]);
  const knownUrls = new Set(existing.map((bookmark) => bookmark.url));
  const folders = new Set(savedFolders.map(normalizeBrowserFolder).filter(Boolean));
  const entries: BookmarkInput[] = [];
  let duplicates = 0;
  let unsupported = 0;

  const visit = (node: browser.bookmarks.BookmarkTreeNode, parentFolders: string[]) => {
    if (node.url) {
      if (!isImportableUrl(node.url)) {
        unsupported++;
      } else if (knownUrls.has(node.url)) {
        duplicates++;
      } else {
        knownUrls.add(node.url);
        const folder = normalizeBrowserFolder(parentFolders.join(" / "));
        if (folder) folders.add(folder);
        entries.push({
          url: node.url,
          name: node.title || node.url,
          favicon: "",
          folder,
          createdAt: node.dateAdded,
        });
      }
    }
    const nextFolders = node.url || !node.title ? parentFolders : [...parentFolders, node.title];
    node.children?.forEach((child) => visit(child, nextFolders));
  };

  tree.forEach((node) => visit(node, []));
  for (const bookmark of existing) {
    if (bookmark.id === undefined || !bookmark.folder) continue;
    const folder = normalizeBrowserFolder(bookmark.folder);
    if (folder) folders.add(folder);
    if (folder !== bookmark.folder) await updateBookmark(bookmark.id, { folder });
  }
  await addBookmarks(entries);
  await saveBookmarkFolders([...folders]);
  return { imported: entries.length, duplicates, unsupported };
}

async function importBrowserHistory(): Promise<{
  imported: number;
  duplicates: number;
  unsupported: number;
}> {
  const [items, existing] = await Promise.all([
    browser.history.search({ text: "", startTime: 0, maxResults: 100000 }),
    getAllVisits(),
  ]);
  const known = new Set(existing.map((entry) => `${entry.url}\u0000${entry.visitedAt}`));
  const entries: Array<{ url: string; title: string; favicon: string; visitedAt: number }> = [];
  let duplicates = 0;
  let unsupported = 0;

  for (let offset = 0; offset < items.length; offset += 50) {
    const batch = items.slice(offset, offset + 50);
    const results = await Promise.all(
      batch.map(async (item) => {
        if (!item.url || !isImportableUrl(item.url) || item.lastVisitTime === undefined) {
          return { entries: [], duplicates: 0, unsupported: 1 };
        }
        try {
          const visits = await browser.history.getVisits({ url: item.url });
          const imported: typeof entries = [];
          let itemDuplicates = 0;
          for (const visit of visits) {
            const visitedAt = visit.visitTime ?? item.lastVisitTime;
            const key = `${item.url}\u0000${visitedAt}`;
            if (known.has(key)) {
              itemDuplicates++;
              continue;
            }
            known.add(key);
            imported.push({
              url: item.url,
              title: item.title || item.url,
              favicon: "",
              visitedAt,
            });
          }
          return { entries: imported, duplicates: itemDuplicates, unsupported: 0 };
        } catch (error) {
          console.error(`Failed to import history for ${item.url}`, error);
          return { entries: [], duplicates: 0, unsupported: 1 };
        }
      }),
    );
    for (const result of results) {
      entries.push(...result.entries);
      duplicates += result.duplicates;
      unsupported += result.unsupported;
    }
  }

  await addVisits(entries);
  return { imported: entries.length, duplicates, unsupported };
}

function syncMessage(result: SyncResult): string {
  if (!result.enabled) return "同期は無効です";
  return `同期完了（送信 ${result.uploaded}件、受信 ${result.downloaded}件）`;
}

async function init() {
  const [{ perPage }, syncSettings] = await Promise.all([getStorage(), getSyncSettings()]);

  app.innerHTML = `
    <nav class="page-nav" aria-label="ページ">
      <a href="../history/index.html">履歴</a>
      <a href="../bookmarks/index.html">ブックマーク</a>
      <a href="./index.html" aria-current="page">設定</a>
    </nav>
    <h1>設定</h1>
    <div class="setting">
      <label for="perPage">1ページあたりの履歴件数</label>
      <input type="number" id="perPage" min="10" max="${MAX_PER_PAGE}" step="10" value="${perPage}" />
    </div>
    <div class="setting backup-setting">
      <h2>バックアップ</h2>
      <p>この拡張機能の履歴とブックマークをJSONファイルに保存します。同期設定は含まれません。</p>
      <button type="button" id="download-backup">バックアップをダウンロード</button>
      <div id="backup-status" role="status" aria-live="polite"></div>
    </div>
    <div class="setting reset-setting">
      <h2>全リセット</h2>
      <p>この拡張機能の履歴、ブックマーク、設定をすべて削除します。</p>
      <button type="button" id="reset-all" class="danger">全リセット</button>
      <div id="reset-status" role="status" aria-live="polite"></div>
    </div>
    <div class="setting bookmark-import-setting">
      <h2>ブックマーク</h2>
      <p>ブラウザに保存されているブックマークとフォルダを、この拡張機能に取り込みます。</p>
      <button type="button" id="import-bookmarks">ブラウザからインポート</button>
      <div id="import-status" role="status" aria-live="polite"></div>
    </div>
    <div class="setting history-import-setting">
      <h2>履歴</h2>
      <p>ブラウザに保存されている履歴を、この拡張機能に取り込みます。</p>
      <button type="button" id="import-history">ブラウザからインポート</button>
      <div id="history-import-status" role="status" aria-live="polite"></div>
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
  `;

  const input = document.querySelector<HTMLInputElement>("#perPage")!;
  const status = document.querySelector<HTMLDivElement>("#status")!;

  input.addEventListener("change", async () => {
    const val = Math.max(10, Math.min(MAX_PER_PAGE, Number(input.value) || DEFAULT_PER_PAGE));
    input.value = String(val);
    await setStorage({ perPage: val });
    status.textContent = "保存しました";
    setTimeout(() => {
      status.textContent = "";
    }, 1500);
  });

  const backupButton = document.querySelector<HTMLButtonElement>("#download-backup")!;
  const backupStatus = document.querySelector<HTMLDivElement>("#backup-status")!;
  backupButton.addEventListener("click", async () => {
    backupButton.disabled = true;
    backupStatus.textContent = "バックアップを作成しています…";
    try {
      const result = await downloadBackup();
      backupStatus.textContent = `保存しました（履歴 ${result.visits}件、ブックマーク ${result.bookmarks}件）`;
    } catch (error) {
      console.error("Failed to create backup", error);
      backupStatus.textContent = "バックアップの作成に失敗しました";
    } finally {
      backupButton.disabled = false;
    }
  });

  const resetButton = document.querySelector<HTMLButtonElement>("#reset-all")!;
  const resetStatus = document.querySelector<HTMLDivElement>("#reset-status")!;
  resetButton.addEventListener("click", async () => {
    if (!window.confirm("この拡張機能のデータをすべて削除します。元に戻せません。")) return;
    resetButton.disabled = true;
    resetStatus.textContent = "リセットしています…";
    try {
      await resetDatabase();
      await browser.storage.local.clear();
      location.reload();
    } catch (error) {
      console.error("Failed to reset extension data", error);
      resetStatus.textContent = "リセットに失敗しました。ページを閉じて再試行してください。";
      resetButton.disabled = false;
    }
  });

  const importButton = document.querySelector<HTMLButtonElement>("#import-bookmarks")!;
  const importStatus = document.querySelector<HTMLDivElement>("#import-status")!;
  importButton.addEventListener("click", async () => {
    importButton.disabled = true;
    importStatus.textContent = "ブラウザのブックマークを読み込んでいます…";
    try {
      const result = await importBrowserBookmarks();
      const details = [`${result.imported}件追加`, `${result.duplicates}件重複`];
      if (result.unsupported > 0) details.push(`${result.unsupported}件対象外`);
      importStatus.textContent = `インポート完了（${details.join("、")}）`;
      void requestSync().catch((error: unknown) => console.error("Sync failed", error));
    } catch (error) {
      console.error("Failed to import browser bookmarks", error);
      importStatus.textContent = "インポートに失敗しました。権限を確認してください。";
    } finally {
      importButton.disabled = false;
    }
  });

  const importHistoryButton = document.querySelector<HTMLButtonElement>("#import-history")!;
  const historyImportStatus = document.querySelector<HTMLDivElement>("#history-import-status")!;
  importHistoryButton.addEventListener("click", async () => {
    importHistoryButton.disabled = true;
    historyImportStatus.textContent = "ブラウザの履歴を読み込んでいます…";
    try {
      const result = await importBrowserHistory();
      const details = [`${result.imported}件追加`, `${result.duplicates}件重複`];
      if (result.unsupported > 0) details.push(`${result.unsupported}件対象外`);
      historyImportStatus.textContent = `インポート完了（${details.join("、")}）`;
      void requestSync().catch((error: unknown) => console.error("Sync failed", error));
    } catch (error) {
      console.error("Failed to import browser history", error);
      historyImportStatus.textContent = "インポートに失敗しました。権限を確認してください。";
    } finally {
      importHistoryButton.disabled = false;
    }
  });

  const syncUrl = document.querySelector<HTMLInputElement>("#sync-url")!;
  const syncSecret = document.querySelector<HTMLInputElement>("#sync-secret")!;
  const generateButton = document.querySelector<HTMLButtonElement>("#generate-secret")!;
  const saveSyncButton = document.querySelector<HTMLButtonElement>("#save-sync")!;
  const syncNowButton = document.querySelector<HTMLButtonElement>("#sync-now")!;
  const syncStatus = document.querySelector<HTMLDivElement>("#sync-status")!;

  generateButton.addEventListener("click", () => {
    syncSecret.value = generateSyncSecret();
    syncSecret.type = "text";
  });

  const runSync = async () => {
    syncNowButton.disabled = true;
    syncStatus.textContent = "同期しています…";
    try {
      syncStatus.textContent = syncMessage(await requestSync());
    } catch (error) {
      console.error("Sync failed", error);
      syncStatus.textContent = error instanceof Error ? error.message : "同期に失敗しました";
    } finally {
      syncNowButton.disabled = false;
    }
  };

  syncNowButton.addEventListener("click", () => {
    void runSync();
  });
  saveSyncButton.addEventListener("click", async () => {
    saveSyncButton.disabled = true;
    syncStatus.textContent = "設定を保存しています…";
    try {
      await saveSyncSettings(syncUrl.value.trim(), syncSecret.value);
      syncStatus.textContent = syncMessage(await requestSync());
    } catch (error) {
      console.error("Failed to save sync settings", error);
      syncStatus.textContent =
        error instanceof Error ? error.message : "同期設定の保存に失敗しました";
    } finally {
      saveSyncButton.disabled = false;
    }
  });
}

init();
