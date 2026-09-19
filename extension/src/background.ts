/// <reference types="@taisan11/vite-plugin-webext/types" />

import {
  addVisit,
  getAllBookmarks,
  toggleBookmark as toggleBookmarkInDb,
  getBookmarkByUrl,
  updateVisitMetadata,
  type BookmarkEntry,
} from "./db.ts";
import { getSyncSettings, saveAuthTokens, syncNow, type SyncResult } from "./sync.ts";
// import { extensionApi } from "./extension-api.ts";

const ALLOWED_SCHEMES = ["http://", "https://", "file://"];
const IS_FIREFOX = import.meta.env.IS_FIREFOX;

const PAGE_BOOKMARK_OFF = "bookmark-off.svg";
const PAGE_BOOKMARK_ON = "bookmark-on.svg";
const ACTION_BOOKMARK_OFF = "bookmark-off-16.png";
const ACTION_BOOKMARK_ON = "bookmark-on-16.png";

type ActionIcon = { 16: ImageData; 32: ImageData };
const actionIconCache = new Map<boolean, Promise<ActionIcon>>();

let syncTimer: ReturnType<typeof setTimeout> | undefined;
const syncWaiters: Array<{
  resolve: (result: SyncResult) => void;
  reject: (error: unknown) => void;
}> = [];

function scheduleSync(): Promise<SyncResult> {
  const promise = new Promise<SyncResult>((resolve, reject) =>
    syncWaiters.push({ resolve, reject }),
  );
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    const waiters = syncWaiters.splice(0);
    void syncNow().then(
      (result) => waiters.forEach((waiter) => waiter.resolve(result)),
      (error: unknown) => waiters.forEach((waiter) => waiter.reject(error)),
    );
  }, 150);
  return promise;
}

function scheduleSyncInBackground(): void {
  void scheduleSync().catch((error: unknown) => console.error("Scheduled sync failed", error));
}

type ActionTab = {
  id?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
};

type PageMetadataMessage = {
  type: "PAGE_METADATA";
  url: string;
  title?: string;
  favicon?: string;
  navigation?: boolean;
};

// This is only a fast-path to distinguish a SPA route transition from the
// initial metadata message. The database remains the source of truth, so a
// service-worker restart does not lose title updates.
const tabUrls = new Map<number, string>();
const tabMetadata = new Map<number, { url: string; title: string; favicon: string }>();
const MAX_OMNIBOX_SUGGESTIONS = 6;
let omniboxRequestId = 0;
let omniboxCache: { items: BookmarkEntry[]; expiresAt: number } | undefined;

type AuthPending = { state: string; verifier: string; redirectUri: string; serverUrl: string; tabId?: number };

function authBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function authRandom(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return authBase64Url(bytes);
}

async function startAuth(): Promise<{ started: boolean }> {
  const settings = await getSyncSettings();
  if (!settings.syncUrl) throw new Error("先にサーバーURLを保存してください");
  const verifier = authRandom(32);
  const challenge = authBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = authRandom(24);
  const redirectUri = browser.runtime.getURL("auth/callback.html");
  const query = new URLSearchParams({ client_id: "extension", redirect_uri: redirectUri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state });
  const tab = await browser.tabs.create({ url: `${settings.syncUrl.replace(/\/+$/, "")}/auth/authorize?${query.toString()}` });
  await browser.storage.local.set({ authPending: { state, verifier, redirectUri, serverUrl: settings.syncUrl, tabId: tab.id } satisfies AuthPending });
  return { started: true };
}

async function finishAuth(code: string, state: string): Promise<{ ok: boolean }> {
  const data = (await browser.storage.local.get("authPending")) as { authPending?: AuthPending };
  const pending = data.authPending;
  if (!pending || pending.state !== state) throw new Error("認証stateが一致しません");
  const response = await fetch(`${pending.serverUrl.replace(/\/+$/, "")}/v1/auth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: "extension", redirectUri: pending.redirectUri, code, codeVerifier: pending.verifier }) });
  if (!response.ok) throw new Error("認証codeを交換できませんでした");
  const json = (await response.json()) as { accessToken?: string; refreshToken?: string; accessExpiresAt?: number; user?: unknown };
  if (!json.accessToken || !json.refreshToken || !json.accessExpiresAt || !json.user) throw new Error("認証応答が不正です");
  await saveAuthTokens(json as Parameters<typeof saveAuthTokens>[0]);
  await browser.storage.local.remove("authPending");
  if (pending.tabId !== undefined) await browser.tabs.remove(pending.tabId).catch(() => undefined);
  return { ok: true };
}

async function loadActionIcon(path: string): Promise<ImageData> {
  const response = await fetch(browser.runtime.getURL(path));
  if (!response.ok) throw new Error(`Failed to load action icon: ${path}`);

  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function getActionIcon(bookmarked: boolean): Promise<ActionIcon> {
  const cached = actionIconCache.get(bookmarked);
  if (cached) return cached;

  const promise = Promise.all([
    loadActionIcon(bookmarked ? ACTION_BOOKMARK_ON : ACTION_BOOKMARK_OFF),
    loadActionIcon(bookmarked ? "bookmark-on-32.png" : "bookmark-off-32.png"),
  ]).then(([icon16, icon32]) => ({ 16: icon16, 32: icon32 }));
  actionIconCache.set(bookmarked, promise);
  return promise;
}

async function setBookmarkActionIcon(tabId: number, bookmarked: boolean) {
  if (IS_FIREFOX) {
    await browser.pageAction.setIcon({
      tabId,
      path: bookmarked ? PAGE_BOOKMARK_ON : PAGE_BOOKMARK_OFF,
    });
    return;
  }

  await browser.action.setIcon({ tabId, imageData: await getActionIcon(bookmarked) });
}

async function hidePageAction(tabId: number) {
  if (IS_FIREFOX) await browser.pageAction.hide(tabId);
}

async function updatePageAction(tabId: number, url: string) {
  const bookmarked = (await getBookmarkByUrl(url)) !== undefined;
  await setBookmarkActionIcon(tabId, bookmarked);
  if (IS_FIREFOX) await browser.pageAction.show(tabId);
}

async function updatePageActionForTab(tab: ActionTab) {
  if (tab.id === undefined) return;
  if (!tab.url || !ALLOWED_SCHEMES.some((s) => tab.url!.startsWith(s))) {
    await hidePageAction(tab.id);
    return;
  }
  await updatePageAction(tab.id, tab.url);
}

function isPageMetadataMessage(value: unknown): value is PageMetadataMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<PageMetadataMessage>;
  return (
    message.type === "PAGE_METADATA" &&
    typeof message.url === "string" &&
    typeof message.title === "string" &&
    typeof message.favicon === "string" &&
    (message.navigation === undefined || typeof message.navigation === "boolean")
  );
}

function escapeOmnibox(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

async function getOmniboxBookmarks(): Promise<BookmarkEntry[]> {
  if (omniboxCache && omniboxCache.expiresAt > Date.now()) return omniboxCache.items;
  const items = await getAllBookmarks();
  omniboxCache = { items, expiresAt: Date.now() + 1_000 };
  return items;
}

function bookmarkMatches(bookmark: BookmarkEntry, query: string): boolean {
  return (
    bookmark.name.toLowerCase().includes(query) ||
    bookmark.url.toLowerCase().includes(query) ||
    bookmark.folder.toLowerCase().includes(query)
  );
}

function bookmarkDescription(bookmark: BookmarkEntry): string {
  let host = bookmark.url;
  try {
    host = new URL(bookmark.url).hostname;
  } catch {
    // Keep the original value for non-standard bookmark URLs.
  }
  return `${escapeOmnibox(bookmark.name || bookmark.url)} <dim>${escapeOmnibox(host)}</dim>`;
}

function updateOmniboxSuggestions(
  text: string,
  suggest: (results: browser.omnibox.SuggestResult[]) => void,
) {
  const requestId = ++omniboxRequestId;
  const query = text.trim().toLowerCase();
  void getOmniboxBookmarks()
    .then((bookmarks) => {
      if (requestId !== omniboxRequestId) return;
      suggest(
        bookmarks
          .filter((bookmark) => !query || bookmarkMatches(bookmark, query))
          .slice(0, MAX_OMNIBOX_SUGGESTIONS)
          .map((bookmark) => ({
            content: bookmark.url,
            description: bookmarkDescription(bookmark),
          })),
      );
    })
    .catch(() => {
      if (requestId === omniboxRequestId) suggest([]);
    });
}

async function openOmniboxResult(
  text: string,
  disposition: browser.omnibox.OnInputEnteredDisposition,
): Promise<void> {
  let url = text.trim();
  if (!ALLOWED_SCHEMES.some((scheme) => url.toLowerCase().startsWith(scheme))) {
    const bookmark = (await getOmniboxBookmarks()).find((item) =>
      bookmarkMatches(item, url.toLowerCase()),
    );
    if (!bookmark) return;
    url = bookmark.url;
  }
  if (!ALLOWED_SCHEMES.some((scheme) => url.toLowerCase().startsWith(scheme))) return;
  if (disposition === "currentTab") {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id !== undefined) await browser.tabs.update(activeTab.id, { url });
    return;
  }
  await browser.tabs.create({ url, active: disposition === "newForegroundTab" });
}

async function saveVisitFromTab(tabId: number, tab: ActionTab): Promise<void> {
  if (!tab.url || !ALLOWED_SCHEMES.some((scheme) => tab.url!.startsWith(scheme))) return;
  await addVisit({
    url: tab.url,
    title: tab.title?.trim() ?? "",
    favicon: tab.favIconUrl ?? "",
    visitedAt: Date.now(),
  });
  tabUrls.set(tabId, tab.url);
  tabMetadata.set(tabId, {
    url: tab.url,
    title: tab.title?.trim() ?? "",
    favicon: tab.favIconUrl ?? "",
  });
}

async function handlePageMetadata(
  message: PageMetadataMessage,
  sender: browser.runtime.MessageSender,
) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !ALLOWED_SCHEMES.some((scheme) => message.url.startsWith(scheme)))
    return;

  const title = message.title?.trim() ?? "";
  const favicon = message.favicon?.trim() ?? "";
  const previousUrl = tabUrls.get(tabId);
  if (message.navigation === true && previousUrl !== message.url) {
    await addVisit({ url: message.url, title, favicon, visitedAt: Date.now() });
    tabUrls.set(tabId, message.url);
    tabMetadata.set(tabId, { url: message.url, title, favicon });
    scheduleSyncInBackground();
    return;
  }

  // Initial content-script metadata arrives after tabs.onUpdated. If the
  // worker restarted, updateVisitMetadata can still find the existing visit;
  // only create a new visit when no record exists yet.
  const metadataResult = await updateVisitMetadata(message.url, { title, favicon });
  if (metadataResult === "missing") {
    await addVisit({ url: message.url, title, favicon, visitedAt: Date.now() });
    scheduleSyncInBackground();
  } else if (metadataResult === "updated") {
    scheduleSyncInBackground();
  }
  tabUrls.set(tabId, message.url);
  tabMetadata.set(tabId, { url: message.url, title, favicon });
}

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url || !ALLOWED_SCHEMES.some((s) => tab.url!.startsWith(s))) {
    await hidePageAction(tabId);
    return;
  }

  if (changeInfo.status === "complete") {
    await saveVisitFromTab(tabId, tab);
    scheduleSyncInBackground();
  } else if (changeInfo.title !== undefined) {
    const metadataResult = await updateVisitMetadata(tab.url, { title: changeInfo.title });
    const metadata = tabMetadata.get(tabId);
    tabMetadata.set(tabId, {
      url: tab.url,
      title: changeInfo.title.trim(),
      favicon: metadata?.url === tab.url ? metadata.favicon : (tab.favIconUrl ?? ""),
    });
    if (metadataResult === "updated") scheduleSyncInBackground();
  }

  if (tab.url && (changeInfo.url || changeInfo.status === "complete")) {
    await updatePageAction(tabId, tab.url);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabUrls.delete(tabId);
  tabMetadata.delete(tabId);
});

browser.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await browser.tabs.get(activeInfo.tabId);
  await updatePageActionForTab(tab);
});

async function openHistory() {
  await browser.tabs.create({ url: browser.runtime.getURL("history/index.html") });
}

async function toggleBookmark(tab: ActionTab) {
  if (tab.id === undefined || !tab.url || !ALLOWED_SCHEMES.some((s) => tab.url!.startsWith(s)))
    return;
  const url = tab.url;
  const metadata = tabMetadata.get(tab.id);
  const title = metadata?.url === url && metadata.title ? metadata.title : (tab.title ?? "");
  const favicon =
    metadata?.url === url && metadata.favicon ? metadata.favicon : (tab.favIconUrl ?? "");
  const bookmarked = await toggleBookmarkInDb({ url, name: title || url, favicon, folder: "" });
  omniboxCache = undefined;
  await setBookmarkActionIcon(tab.id, bookmarked);
  scheduleSyncInBackground();
}

if (IS_FIREFOX) {
  browser.action.onClicked.addListener(openHistory);
  browser.pageAction.onClicked.addListener(toggleBookmark);
} else {
  browser.action.onClicked.addListener(toggleBookmark);
}

browser.omnibox.onInputStarted.addListener(() => {
  browser.omnibox.setDefaultSuggestion({
    description: "ブックマークを検索（名前・URL・フォルダ）",
  });
});
browser.omnibox.onInputChanged.addListener(updateOmniboxSuggestions);
browser.omnibox.onInputCancelled.addListener(() => {
  omniboxRequestId++;
});
browser.omnibox.onInputEntered.addListener((text, disposition) => {
  void openOmniboxResult(text, disposition).catch((error: unknown) =>
    console.error("Failed to open omnibox bookmark", error),
  );
});

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_AUTH") {
    void startAuth().then(sendResponse, (error: unknown) => sendResponse({ error: error instanceof Error ? error.message : "ログインを開始できませんでした" }));
    return true;
  }
  if (msg.type === "AUTH_CALLBACK") {
    void finishAuth(msg.code, msg.state).then(sendResponse, (error: unknown) => sendResponse({ error: error instanceof Error ? error.message : "ログインに失敗しました" }));
    return true;
  }
  if (isPageMetadataMessage(msg)) {
    void handlePageMetadata(msg, sender).then(
      () => sendResponse({ ok: true }),
      (error: unknown) => {
        console.error("Failed to save page metadata", error);
        sendResponse({ ok: false });
      },
    );
    return true;
  }
  if (msg.type === "TOGGLE_BOOKMARK" && sender.tab?.url && sender.tab?.id) {
    const url = msg.url ?? sender.tab.url;
    const metadata = tabMetadata.get(sender.tab.id);
    (async () => {
      const bookmarked = await toggleBookmarkInDb({
        url,
        name: msg.title ?? ((metadata?.url === url ? metadata?.title : "") || url),
        favicon: msg.favicon ?? (metadata?.url === url ? metadata?.favicon : ""),
        folder: "",
      });
      omniboxCache = undefined;
      await setBookmarkActionIcon(sender.tab!.id!, bookmarked);
      scheduleSyncInBackground();
    })();
    return true;
  }
  if (msg.type === "GET_BOOKMARK_STATUS") {
    return getBookmarkByUrl(msg.url).then((bookmark) => bookmark !== undefined);
  }
  if (msg.type === "GET_BOOKMARK") {
    return getBookmarkByUrl(msg.url);
  }
  if (msg.type === "SYNC_NOW") return scheduleSync();
});

async function initializeActions() {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.map(updatePageActionForTab));
}

void initializeActions();

browser.runtime.onInstalled.addListener(() => {
  console.log("Mugen History and Stars installed");
});
