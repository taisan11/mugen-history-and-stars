/// <reference types="@taisan11/vite-plugin-webext/types" />

import { addVisit, isBookmarked, addBookmark, removeBookmark, getBookmarkByUrl } from "./db.ts";
import { syncNow, type SyncResult } from "./sync.ts";
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

type ActionTab = {
  id?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
};

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
  const bookmarked = await isBookmarked(url);
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

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url || !ALLOWED_SCHEMES.some((s) => tab.url!.startsWith(s))) {
    await hidePageAction(tabId);
    return;
  }

  if (changeInfo.status === "complete") {
    await addVisit({
      url: tab.url,
      title: tab.title ?? "",
      favicon: tab.favIconUrl ?? "",
      visitedAt: Date.now(),
    });
    void scheduleSync().catch((error: unknown) => console.error("Scheduled sync failed", error));
  }

  if (tab.url && (changeInfo.url || changeInfo.status === "complete")) {
    await updatePageAction(tabId, tab.url);
  }
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
  const bookmarked = await isBookmarked(url);
  if (bookmarked) {
    const existing = await getBookmarkByUrl(url);
    if (existing?.id) await removeBookmark(existing.id);
    await setBookmarkActionIcon(tab.id, false);
  } else {
    await addBookmark({
      url,
      name: tab.title ?? url,
      favicon: tab.favIconUrl ?? "",
      folder: "",
    });
    await setBookmarkActionIcon(tab.id, true);
  }
  void scheduleSync().catch((error: unknown) => console.error("Scheduled sync failed", error));
}

if (IS_FIREFOX) {
  browser.action.onClicked.addListener(openHistory);
  browser.pageAction.onClicked.addListener(toggleBookmark);
} else {
  browser.action.onClicked.addListener(toggleBookmark);
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "TOGGLE_BOOKMARK" && sender.tab?.url && sender.tab?.id) {
    const url = msg.url ?? sender.tab.url;
    (async () => {
      const bookmarked = await isBookmarked(url);
      if (bookmarked) {
        const existing = await getBookmarkByUrl(url);
        if (existing?.id) await removeBookmark(existing.id);
        await setBookmarkActionIcon(sender.tab!.id!, false);
      } else {
        await addBookmark({ url, name: msg.title ?? url, favicon: msg.favicon ?? "", folder: "" });
        await setBookmarkActionIcon(sender.tab!.id!, true);
      }
      void scheduleSync().catch((error: unknown) => console.error("Scheduled sync failed", error));
    })();
    return true;
  }
  if (msg.type === "GET_BOOKMARK_STATUS") {
    return isBookmarked(msg.url);
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
