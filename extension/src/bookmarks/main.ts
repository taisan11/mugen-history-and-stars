/// <reference types="@taisan11/vite-plugin-webext/types" />
import {
  getAllBookmarks,
  moveBookmarksToFolder,
  removeBookmark,
  updateBookmark,
  type BookmarkEntry,
} from "../db.ts";
import { getBookmarkFolders, saveBookmarkFolders } from "../bookmark-folders.ts";
import {
  bindSearchInput,
  focusSearchShortcut,
  type SearchInputHandle,
} from "../search-input.ts";
import { requestSync } from "../sync.ts";
import "./style.css";

const UNCATEGORIZED = "__uncategorized";

const app = document.querySelector<HTMLDivElement>("#app")!;

let bookmarks: BookmarkEntry[] = [];
let folders: string[] = [];
let editingId: number | null = null;
let selectedFolder = "";
let searchQuery = "";

let searchInput!: HTMLInputElement;
let searchHandle!: SearchInputHandle;
let statsEl!: HTMLElement;
let folderListEl!: HTMLElement;
let resultsCountEl!: HTMLElement;
let listEl!: HTMLElement;

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getVisibleBookmarks(): BookmarkEntry[] {
  const query = searchQuery.trim().toLowerCase();
  return bookmarks.filter((bookmark) => {
    const inFolder =
      selectedFolder === UNCATEGORIZED
        ? !bookmark.folder
        : !selectedFolder || bookmark.folder === selectedFolder;
    const matchesSearch =
      !query ||
      bookmark.name.toLowerCase().includes(query) ||
      bookmark.url.toLowerCase().includes(query);
    return inFolder && matchesSearch;
  });
}

function folderCount(folder: string): number {
  if (folder === "") return bookmarks.length;
  if (folder === UNCATEGORIZED) return bookmarks.filter((bookmark) => !bookmark.folder).length;
  return bookmarks.filter((bookmark) => bookmark.folder === folder).length;
}

function folderButton(label: string, folder: string, removable = false): string {
  const active = selectedFolder === folder ? " active" : "";
  return `
    <div class="folder-row">
      <button class="folder-btn${active}" data-folder="${escapeHtml(folder)}">
        <span class="folder-label">${escapeHtml(label)}</span>
        <span class="folder-count">${folderCount(folder)}</span>
      </button>
      ${removable ? `<button class="remove-folder" data-folder="${escapeHtml(folder)}" title="フォルダを削除">×</button>` : ""}
    </div>
  `;
}

function folderOptions(bookmark: BookmarkEntry): string {
  const options = [`<option value="" ${bookmark.folder ? "" : "selected"}>未分類</option>`];
  for (const folder of folders) {
    options.push(
      `<option value="${escapeHtml(folder)}" ${bookmark.folder === folder ? "selected" : ""}>${escapeHtml(folder)}</option>`,
    );
  }
  return options.join("");
}

/**
 * Build the static chrome once so the search box (and its focus/selection)
 * survives list updates.
 */
function initShell() {
  app.innerHTML = `
    <header>
      <h1>ブックマーク</h1>
      <div class="stats" id="stats"></div>
      <nav class="nav-links" aria-label="ページ">
        <a href="../history/index.html">履歴</a>
        <a href="../options/index.html">設定</a>
      </nav>
    </header>
    <div class="bookmark-layout">
      <aside class="folder-panel">
        <div class="folder-heading">
          <h2>フォルダ</h2>
          <button id="new-folder" title="新しいフォルダ">+</button>
        </div>
        <div id="folder-list"></div>
      </aside>
      <main class="bookmark-content">
        <div class="toolbar">
          <input type="search" id="search" placeholder="URL・タイトルで検索..." autofocus />
        </div>
        <div class="results-count" id="results-count"></div>
        <div id="bookmark-list"></div>
      </main>
    </div>
  `;

  searchInput = app.querySelector<HTMLInputElement>("#search")!;
  statsEl = app.querySelector<HTMLElement>("#stats")!;
  folderListEl = app.querySelector<HTMLElement>("#folder-list")!;
  resultsCountEl = app.querySelector<HTMLElement>("#results-count")!;
  listEl = app.querySelector<HTMLElement>("#bookmark-list")!;

  app.querySelector<HTMLButtonElement>("#new-folder")!.addEventListener("click", () => {
    void onNewFolder();
  });
}

function render() {
  const visibleBookmarks = getVisibleBookmarks();
  statsEl.textContent = `${searchQuery ? `${visibleBookmarks.length} / ${bookmarks.length}` : bookmarks.length} 件`;
  resultsCountEl.textContent = `${visibleBookmarks.length.toLocaleString()} 件`;
  renderFolders();
  renderList(visibleBookmarks);
}

function renderFolders() {
  folderListEl.innerHTML = [
    folderButton("すべて", ""),
    folderButton("未分類", UNCATEGORIZED),
    ...folders.map((folder) => folderButton(folder, folder, true)),
  ].join("");

  for (const button of folderListEl.querySelectorAll<HTMLButtonElement>(".folder-btn")) {
    button.addEventListener("click", () => {
      searchHandle.cancel();
      selectedFolder = button.dataset.folder ?? "";
      editingId = null;
      render();
      // The clicked button was just replaced; keep keyboard focus on it.
      folderListEl.querySelector<HTMLButtonElement>(".folder-btn.active")?.focus();
    });
  }
  for (const button of folderListEl.querySelectorAll<HTMLButtonElement>(".remove-folder")) {
    button.addEventListener("click", (event) => {
      void onRemoveFolder(event);
    });
  }
}

function renderList(visibleBookmarks: BookmarkEntry[]) {
  let listHtml = "";

  for (const bookmark of visibleBookmarks) {
    if (editingId === bookmark.id) {
      listHtml += `
        <div class="bookmark-item editing" data-id="${bookmark.id}">
          <div class="edit-form">
            <input type="text" class="edit-name" value="${escapeHtml(bookmark.name)}" placeholder="名前" />
            <input type="url" class="edit-url" value="${escapeHtml(bookmark.url)}" placeholder="URL" />
            <label class="edit-folder-label" for="edit-folder-${bookmark.id}">フォルダ</label>
            <select id="edit-folder-${bookmark.id}" class="edit-folder">${folderOptions(bookmark)}</select>
            <div class="edit-actions">
              <button class="save-btn" data-id="${bookmark.id}">保存</button>
              <button class="cancel-btn" data-id="${bookmark.id}">キャンセル</button>
            </div>
          </div>
        </div>
      `;
    } else {
      listHtml += `
        <div class="bookmark-item" data-id="${bookmark.id}">
          <div class="bookmark-info">
            <a class="bookmark-name" href="${escapeHtml(bookmark.url)}" target="_blank">${escapeHtml(bookmark.name)}</a>
            <div class="bookmark-meta">
              <span class="bookmark-domain">${escapeHtml(getDomain(bookmark.url))}</span>
              ${bookmark.folder ? `<span class="bookmark-folder">${escapeHtml(bookmark.folder)}</span>` : ""}
            </div>
          </div>
          <div class="bookmark-actions">
            <button class="edit-btn" data-id="${bookmark.id}" title="編集">✎</button>
            <button class="delete-btn" data-id="${bookmark.id}" title="削除">×</button>
          </div>
        </div>
      `;
    }
  }

  if (visibleBookmarks.length === 0) {
    listHtml = `<div class="empty">${searchQuery ? "検索結果がありません" : selectedFolder ? "このフォルダにブックマークがありません" : "ブックマークがまだありません"}</div>`;
  }

  listEl.innerHTML = listHtml;

  for (const button of listEl.querySelectorAll<HTMLButtonElement>(".edit-btn")) {
    button.addEventListener("click", () => {
      searchHandle.cancel();
      const id = Number(button.dataset.id);
      editingId = id;
      render();
      const input = listEl.querySelector<HTMLInputElement>(
        `.bookmark-item[data-id="${id}"] .edit-name`,
      );
      input?.focus();
      input?.select();
    });
  }
  for (const button of listEl.querySelectorAll<HTMLButtonElement>(".delete-btn")) {
    button.addEventListener("click", onDelete);
  }
  for (const button of listEl.querySelectorAll<HTMLButtonElement>(".save-btn")) {
    button.addEventListener("click", onSave);
  }
  for (const button of listEl.querySelectorAll<HTMLButtonElement>(".cancel-btn")) {
    button.addEventListener("click", () => {
      const id = editingId;
      editingId = null;
      render();
      focusEditButton(id);
    });
  }
}

function focusEditButton(id: number | null) {
  if (id === null) return;
  listEl.querySelector<HTMLButtonElement>(`.bookmark-item[data-id="${id}"] .edit-btn`)?.focus();
}

async function onNewFolder() {
  const name = window.prompt("フォルダ名を入力してください")?.trim() ?? "";
  if (!name || name === UNCATEGORIZED || folders.includes(name)) return;
  folders.push(name);
  folders.sort((a, b) => a.localeCompare(b, "ja"));
  await saveBookmarkFolders(folders);
  selectedFolder = name;
  render();
}

async function onRemoveFolder(event: Event) {
  const folder = (event.currentTarget as HTMLButtonElement).dataset.folder;
  if (
    !folder ||
    !window.confirm(`「${folder}」を削除しますか？\n中のブックマークは未分類になります。`)
  )
    return;
  await moveBookmarksToFolder(folder, "");
  folders = folders.filter((item) => item !== folder);
  await saveBookmarkFolders(folders);
  if (selectedFolder === folder) selectedFolder = "";
  void requestSync().catch((error: unknown) => console.error("Sync failed", error));
  bookmarks = await getAllBookmarks();
  render();
  folderListEl.querySelector<HTMLButtonElement>(".folder-btn.active")?.focus();
}

async function onDelete(event: Event) {
  const id = Number((event.currentTarget as HTMLButtonElement).dataset.id);
  const removedIndex = getVisibleBookmarks().findIndex((bookmark) => bookmark.id === id);
  await removeBookmark(id);
  void requestSync().catch((error: unknown) => console.error("Sync failed", error));
  bookmarks = await getAllBookmarks();
  render();

  // Keep keyboard focus inside the list, at the position the item used to occupy.
  const editButtons = listEl.querySelectorAll<HTMLButtonElement>(".edit-btn");
  const next = removedIndex >= 0 ? editButtons[Math.min(removedIndex, editButtons.length - 1)] : undefined;
  if (next) next.focus();
  else searchInput.focus();
}

async function onSave(event: Event) {
  const id = Number((event.currentTarget as HTMLButtonElement).dataset.id);
  const item = listEl.querySelector<HTMLDivElement>(`.bookmark-item[data-id="${id}"]`)!;
  const name = (item.querySelector(".edit-name") as HTMLInputElement).value.trim();
  const url = (item.querySelector(".edit-url") as HTMLInputElement).value.trim();
  const folder = (item.querySelector(".edit-folder") as HTMLSelectElement).value;
  if (!name || !url) return;
  await updateBookmark(id, { name, url, folder });
  void requestSync().catch((error: unknown) => console.error("Sync failed", error));
  editingId = null;
  bookmarks = await getAllBookmarks();
  render();
  focusEditButton(id);
}

async function init() {
  initShell();
  searchInput.focus();
  focusSearchShortcut(searchInput);
  searchHandle = bindSearchInput(
    searchInput,
    (query) => {
      searchQuery = query;
      render();
    },
    { delay: 120 },
  );

  bookmarks = await getAllBookmarks();
  const savedFolders = await getBookmarkFolders();
  folders = [
    ...new Set([...savedFolders, ...bookmarks.map((bookmark) => bookmark.folder).filter(Boolean)]),
  ].sort((a, b) => a.localeCompare(b, "ja"));
  render();
}

init();
