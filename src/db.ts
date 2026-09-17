// import { extensionApi } from "./extension-api.ts";

const DB_NAME = "mugen-history";
const DB_VERSION = 3;

export type SyncKind = "history" | "bookmark";
export type SyncOperation = "upsert" | "delete";

export interface HistoryEntry {
  id?: number;
  syncId: string;
  url: string;
  title: string;
  favicon: string;
  visitedAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface BookmarkEntry {
  id?: number;
  syncId: string;
  url: string;
  name: string;
  favicon: string;
  folder: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface BookmarkInput {
  url: string;
  name: string;
  favicon: string;
  folder: string;
  createdAt?: number;
}

export interface OutboxEntry {
  operationId: string;
  itemId: string;
  kind: SyncKind;
  operation: SyncOperation;
  clientUpdatedAt: number;
  deviceId: string;
  payloadJson: string;
}

export interface RemoteChange {
  itemId: string;
  kind: SyncKind;
  operation: SyncOperation;
  clientUpdatedAt: number;
  deviceId: string;
  payload?: unknown;
  deletionId?: number;
}

interface SyncInfo {
  enabled: boolean;
  deviceId: string;
}

interface SyncState {
  cursor?: number;
  bootstrap?: "pending" | "queued" | "complete";
  pendingDeletionIds?: number[];
}

function uuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let syncInfoPromise: Promise<SyncInfo | undefined> | undefined;

function getSyncInfo(): Promise<SyncInfo | undefined> {
  if (syncInfoPromise) return syncInfoPromise;
  syncInfoPromise = browser.storage.local
    .get(["syncEnabled", "syncDeviceId"])
    .then((data) => {
      const value = data as { syncEnabled?: boolean; syncDeviceId?: string };
      if (value.syncEnabled !== true || !value.syncDeviceId) return undefined;
      return { enabled: true, deviceId: value.syncDeviceId };
    })
    .catch((error: unknown) => {
      syncInfoPromise = undefined;
      throw error;
    });
  return syncInfoPromise;
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && ("syncEnabled" in changes || "syncDeviceId" in changes))
    syncInfoPromise = undefined;
});

let dbPromise: Promise<IDBDatabase> | undefined;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const visits = db.createObjectStore("visits", { keyPath: "id", autoIncrement: true });
      visits.createIndex("url", "url", { unique: false });
      visits.createIndex("visitedAt", "visitedAt", { unique: false });
      visits.createIndex("syncId", "syncId", { unique: true });

      const bookmarks = db.createObjectStore("bookmarks", { keyPath: "id", autoIncrement: true });
      bookmarks.createIndex("url", "url", { unique: false });
      bookmarks.createIndex("createdAt", "createdAt", { unique: false });
      bookmarks.createIndex("syncId", "syncId", { unique: true });

      const outbox = db.createObjectStore("sync_outbox", { keyPath: "operationId" });
      outbox.createIndex("itemId", "itemId", { unique: false });
      outbox.createIndex("clientUpdatedAt", "clientUpdatedAt", { unique: false });
      db.createObjectStore("sync_state", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Keep one connection alive for the lifetime of this extension context.
      // Opening IndexedDB is surprisingly expensive on every navigation.
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = undefined;
      reject(request.error);
    };
  });
  return dbPromise;
}

export async function resetDatabase(): Promise<void> {
  const db = await dbPromise?.catch(() => undefined);
  db?.close();
  dbPromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("データベースが使用中です"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error);
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    };
  });
}

function withoutId(value: HistoryEntry | BookmarkEntry): Record<string, unknown> {
  const { id: _id, ...payload } = value;
  return payload;
}

function putOutbox(
  store: IDBObjectStore,
  kind: SyncKind,
  operation: SyncOperation,
  value: HistoryEntry | BookmarkEntry | { syncId: string; updatedAt: number; updatedBy: string },
  info: SyncInfo,
): void {
  const payload = "url" in value ? withoutId(value) : value;
  store.put({
    operationId: uuid(),
    itemId: value.syncId,
    kind,
    operation,
    clientUpdatedAt: value.updatedAt,
    deviceId: info.deviceId,
    payloadJson: JSON.stringify(payload),
  } satisfies OutboxEntry);
}

function nextUpdatedAt(current: number | undefined): number {
  const now = Date.now();
  return current === undefined ? now : Math.max(now, current + 1);
}

// --- Visits ---

export async function addVisit(
  entry: Omit<HistoryEntry, "id" | "syncId" | "updatedAt" | "updatedBy">,
): Promise<void> {
  const info = await getSyncInfo();
  const db = await openDB();
  const stores = info ? ["visits", "sync_outbox"] : ["visits"];
  const tx = db.transaction(stores, "readwrite");
  const store = tx.objectStore("visits");
  const lastCursor = await requestResult<IDBCursorWithValue | null>(
    store.index("visitedAt").openCursor(null, "prev"),
  );
  const last = lastCursor?.value as HistoryEntry | undefined;
  const updatedAt = nextUpdatedAt(last?.updatedAt);
  if (last && last.url === entry.url) {
    store.delete(last.id!);
    if (info) {
      putOutbox(
        tx.objectStore("sync_outbox"),
        "history",
        "delete",
        {
          syncId: last.syncId,
          updatedAt,
          updatedBy: info.deviceId,
        },
        info,
      );
    }
  }
  const record: HistoryEntry = {
    ...entry,
    syncId: uuid(),
    updatedAt: last && last.url === entry.url ? updatedAt + 1 : updatedAt,
    updatedBy: info?.deviceId ?? "",
  };
  store.add(record);
  if (info) putOutbox(tx.objectStore("sync_outbox"), "history", "upsert", record, info);
  return transactionDone(tx);
}

export async function addVisits(
  entries: Array<Omit<HistoryEntry, "id" | "syncId" | "updatedAt" | "updatedBy">>,
): Promise<void> {
  if (entries.length === 0) return;
  const info = await getSyncInfo();
  const db = await openDB();
  const stores = info ? ["visits", "sync_outbox"] : ["visits"];
  const tx = db.transaction(stores, "readwrite");
  const store = tx.objectStore("visits");
  const outbox = info ? tx.objectStore("sync_outbox") : undefined;
  const firstUpdatedAt = Date.now();

  entries.forEach((entry, index) => {
    const record: HistoryEntry = {
      ...entry,
      syncId: uuid(),
      updatedAt: firstUpdatedAt + index,
      updatedBy: info?.deviceId ?? "",
    };
    store.add(record);
    if (info) putOutbox(outbox!, "history", "upsert", record, info);
  });
  return transactionDone(tx);
}

/**
 * Update the metadata of the most recent visit for a URL.
 *
 * Titles on modern sites are often assigned after navigation has completed.
 * Keeping this operation separate from addVisit prevents a late title update
 * from creating a second history entry (or changing its visitedAt timestamp).
 * The result distinguishes a missing URL from an already up-to-date record so
 * callers can safely handle the first message after a service-worker restart.
 */
export async function updateVisitMetadata(
  url: string,
  changes: Partial<Pick<HistoryEntry, "title" | "favicon">>,
): Promise<"updated" | "unchanged" | "missing"> {
  const info = await getSyncInfo();
  const stores = info ? ["visits", "sync_outbox"] : ["visits"];
  const db = await openDB();
  const tx = db.transaction(stores, "readwrite");
  const store = tx.objectStore("visits");
  const cursor = await requestResult<IDBCursorWithValue | null>(
    store.index("url").openCursor(IDBKeyRange.only(url), "prev"),
  );
  const current = cursor?.value as HistoryEntry | undefined;
  if (!current) {
    await transactionDone(tx);
    return "missing";
  }

  const titleChanged = Boolean(changes.title && changes.title !== current.title);
  const faviconChanged = Boolean(changes.favicon && changes.favicon !== current.favicon);
  if (!titleChanged && !faviconChanged) {
    await transactionDone(tx);
    return "unchanged";
  }

  const record: HistoryEntry = {
    ...current,
    ...(titleChanged ? { title: changes.title } : {}),
    ...(faviconChanged ? { favicon: changes.favicon } : {}),
    updatedAt: nextUpdatedAt(current.updatedAt),
    updatedBy: info?.deviceId ?? current.updatedBy,
  };
  store.put(record);
  if (info) putOutbox(tx.objectStore("sync_outbox"), "history", "upsert", record, info);
  await transactionDone(tx);
  return "updated";
}

export async function getAllVisits(): Promise<HistoryEntry[]> {
  const db = await openDB();
  const tx = db.transaction("visits", "readonly");
  const request = tx.objectStore("visits").index("visitedAt").openCursor(null, "prev");
  const results: HistoryEntry[] = [];
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
}

export async function deleteVisit(id: number): Promise<void> {
  const info = await getSyncInfo();
  const db = await openDB();
  const tx = db.transaction(info ? ["visits", "sync_outbox"] : ["visits"], "readwrite");
  const store = tx.objectStore("visits");
  const existing = await requestResult<HistoryEntry | undefined>(store.get(id));
  if (existing) {
    store.delete(id);
    if (info)
      putOutbox(
        tx.objectStore("sync_outbox"),
        "history",
        "delete",
        {
          syncId: existing.syncId,
          updatedAt: nextUpdatedAt(existing.updatedAt),
          updatedBy: info.deviceId,
        },
        info,
      );
  }
  return transactionDone(tx);
}

export async function clearAllVisits(): Promise<void> {
  const info = await getSyncInfo();
  const db = await openDB();
  const tx = db.transaction(info ? ["visits", "sync_outbox"] : ["visits"], "readwrite");
  const store = tx.objectStore("visits");
  if (info) {
    const entries = await requestResult<HistoryEntry[]>(store.getAll());
    const outbox = tx.objectStore("sync_outbox");
    for (const entry of entries) {
      putOutbox(
        outbox,
        "history",
        "delete",
        {
          syncId: entry.syncId,
          updatedAt: nextUpdatedAt(entry.updatedAt),
          updatedBy: info.deviceId,
        },
        info,
      );
    }
  }
  store.clear();
  return transactionDone(tx);
}

export async function getVisitsPage(
  page: number,
  perPage: number,
): Promise<{ items: HistoryEntry[]; total: number }> {
  const db = await openDB();
  const tx = db.transaction("visits", "readonly");
  const store = tx.objectStore("visits");
  const skip = page * perPage;
  const totalPromise = requestResult<number>(store.count());
  const itemsPromise = new Promise<HistoryEntry[]>((resolve, reject) => {
    const results: HistoryEntry[] = [];
    const req = store.index("visitedAt").openCursor(null, "prev");
    let skipped = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      if (skipped < skip) {
        skipped++;
        cursor.continue();
        return;
      }
      if (results.length < perPage) {
        results.push(cursor.value);
        cursor.continue();
        return;
      }
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
  const [total, items] = await Promise.all([totalPromise, itemsPromise]);
  return { items, total };
}

export async function searchVisitsPage(
  query: string,
  page: number,
  perPage: number,
): Promise<{ items: HistoryEntry[]; total: number }> {
  const q = query.toLowerCase();
  const start = page * perPage;
  const db = await openDB();
  const tx = db.transaction("visits", "readonly");
  const request = tx.objectStore("visits").index("visitedAt").openCursor(null, "prev");
  const items: HistoryEntry[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ items, total });
        return;
      }
      const entry = cursor.value as HistoryEntry;
      if (entry.url.toLowerCase().includes(q) || entry.title.toLowerCase().includes(q)) {
        if (total >= start && items.length < perPage) items.push(entry);
        total++;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

// --- Bookmarks ---

export async function addBookmarks(entries: BookmarkInput[]): Promise<void> {
  if (entries.length === 0) return;
  const info = await getSyncInfo();
  const db = await openDB();
  const tx = db.transaction(info ? ["bookmarks", "sync_outbox"] : ["bookmarks"], "readwrite");
  const store = tx.objectStore("bookmarks");
  const outbox = info ? tx.objectStore("sync_outbox") : undefined;
  const now = Date.now();
  for (const entry of entries) {
    const record: BookmarkEntry = {
      ...entry,
      folder: entry.folder,
      syncId: uuid(),
      createdAt: entry.createdAt ?? now,
      updatedAt: now,
      updatedBy: info?.deviceId ?? "",
    };
    store.add(record);
    if (info) putOutbox(outbox!, "bookmark", "upsert", record, info);
  }
  return transactionDone(tx);
}

export async function removeBookmark(id: number): Promise<void> {
  const info = await getSyncInfo();
  const db = await openDB();
  const tx = db.transaction(info ? ["bookmarks", "sync_outbox"] : ["bookmarks"], "readwrite");
  const store = tx.objectStore("bookmarks");
  const existing = await requestResult<BookmarkEntry | undefined>(store.get(id));
  if (existing) {
    store.delete(id);
    if (info)
      putOutbox(
        tx.objectStore("sync_outbox"),
        "bookmark",
        "delete",
        {
          syncId: existing.syncId,
          updatedAt: nextUpdatedAt(existing.updatedAt),
          updatedBy: info.deviceId,
        },
        info,
      );
  }
  return transactionDone(tx);
}

/** Toggle a bookmark in one transaction and return its new state. */
export async function toggleBookmark(entry: BookmarkInput): Promise<boolean> {
  const info = await getSyncInfo();
  const db = await openDB();
  const stores = info ? ["bookmarks", "sync_outbox"] : ["bookmarks"];
  const tx = db.transaction(stores, "readwrite");
  const store = tx.objectStore("bookmarks");
  const existing = await requestResult<BookmarkEntry | undefined>(
    store.index("url").get(entry.url),
  );
  if (existing) {
    store.delete(existing.id!);
    if (info)
      putOutbox(
        tx.objectStore("sync_outbox"),
        "bookmark",
        "delete",
        {
          syncId: existing.syncId,
          updatedAt: nextUpdatedAt(existing.updatedAt),
          updatedBy: info.deviceId,
        },
        info,
      );
  } else {
    const now = Date.now();
    const record: BookmarkEntry = {
      ...entry,
      syncId: uuid(),
      createdAt: entry.createdAt ?? now,
      updatedAt: now,
      updatedBy: info?.deviceId ?? "",
    };
    store.add(record);
    if (info) putOutbox(tx.objectStore("sync_outbox"), "bookmark", "upsert", record, info);
  }
  await transactionDone(tx);
  return !existing;
}

export async function updateBookmark(
  id: number,
  changes: Partial<Pick<BookmarkEntry, "name" | "url" | "folder">>,
): Promise<void> {
  const info = await getSyncInfo();
  const db = await openDB();
  const tx = db.transaction(info ? ["bookmarks", "sync_outbox"] : ["bookmarks"], "readwrite");
  const store = tx.objectStore("bookmarks");
  const existing = await requestResult<BookmarkEntry | undefined>(store.get(id));
  if (!existing) {
    return transactionDone(tx);
  }
  const record: BookmarkEntry = {
    ...existing,
    ...changes,
    updatedAt: nextUpdatedAt(existing.updatedAt),
    updatedBy: info?.deviceId ?? existing.updatedBy,
  };
  store.put(record);
  if (info) putOutbox(tx.objectStore("sync_outbox"), "bookmark", "upsert", record, info);
  return transactionDone(tx);
}

export async function moveBookmarksToFolder(fromFolder: string, toFolder: string): Promise<void> {
  if (fromFolder === toFolder) return;
  const info = await getSyncInfo();
  const db = await openDB();
  const tx = db.transaction(info ? ["bookmarks", "sync_outbox"] : ["bookmarks"], "readwrite");
  const store = tx.objectStore("bookmarks");
  const outbox = info ? tx.objectStore("sync_outbox") : undefined;
  const entries = await requestResult<BookmarkEntry[]>(store.getAll());
  for (const entry of entries) {
    if (entry.folder !== fromFolder) continue;
    const record: BookmarkEntry = {
      ...entry,
      folder: toFolder,
      updatedAt: nextUpdatedAt(entry.updatedAt),
      updatedBy: info?.deviceId ?? entry.updatedBy,
    };
    store.put(record);
    if (info) putOutbox(outbox!, "bookmark", "upsert", record, info);
  }
  return transactionDone(tx);
}

export async function getBookmarkByUrl(url: string): Promise<BookmarkEntry | undefined> {
  const db = await openDB();
  const tx = db.transaction("bookmarks", "readonly");
  const result = await requestResult<BookmarkEntry | undefined>(
    tx.objectStore("bookmarks").index("url").get(url),
  );
  return result;
}

export async function getAllBookmarks(): Promise<BookmarkEntry[]> {
  const db = await openDB();
  const tx = db.transaction("bookmarks", "readonly");
  const request = tx.objectStore("bookmarks").index("createdAt").openCursor(null, "prev");
  const results: BookmarkEntry[] = [];
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
}

// --- Sync storage ---

export async function getOutbox(limit = 100): Promise<OutboxEntry[]> {
  const db = await openDB();
  const tx = db.transaction("sync_outbox", "readonly");
  const result = await requestResult<OutboxEntry[]>(
    tx.objectStore("sync_outbox").getAll(undefined, limit),
  );
  return result;
}

export async function getSyncState(): Promise<SyncState> {
  const db = await openDB();
  const tx = db.transaction("sync_state", "readonly");
  const store = tx.objectStore("sync_state");
  const [cursor, bootstrap, pendingDeletionIds] = await Promise.all([
    requestResult<{ key: string; value: unknown } | undefined>(store.get("cursor")),
    requestResult<{ key: string; value: unknown } | undefined>(store.get("bootstrap")),
    requestResult<{ key: string; value: unknown } | undefined>(store.get("pendingDeletionIds")),
  ]);
  return {
    cursor: typeof cursor?.value === "number" ? cursor.value : 0,
    bootstrap:
      bootstrap?.value === "queued" || bootstrap?.value === "complete"
        ? bootstrap.value
        : "pending",
    pendingDeletionIds:
      Array.isArray(pendingDeletionIds?.value) &&
      pendingDeletionIds.value.every((value) => typeof value === "number")
        ? (pendingDeletionIds.value as number[])
        : [],
  };
}

export async function resetSyncState(clearOutbox = false): Promise<void> {
  const db = await openDB();
  const stores = clearOutbox ? ["sync_state", "sync_outbox"] : ["sync_state"];
  const tx = db.transaction(stores, "readwrite");
  const store = tx.objectStore("sync_state");
  store.put({ key: "cursor", value: 0 });
  store.put({ key: "bootstrap", value: "pending" });
  store.put({ key: "pendingDeletionIds", value: [] });
  if (clearOutbox) tx.objectStore("sync_outbox").clear();
  return transactionDone(tx);
}

export async function enqueueBootstrap(): Promise<boolean> {
  const info = await getSyncInfo();
  if (!info) return false;
  const db = await openDB();
  const tx = db.transaction(["visits", "bookmarks", "sync_outbox", "sync_state"], "readwrite");
  const state = await requestResult<{ key: string; value: unknown } | undefined>(
    tx.objectStore("sync_state").get("bootstrap"),
  );
  if (state?.value === "queued" || state?.value === "complete") {
    await transactionDone(tx);
    return false;
  }
  const outbox = tx.objectStore("sync_outbox");
  const visitStore = tx.objectStore("visits");
  const bookmarkStore = tx.objectStore("bookmarks");
  const visits = await requestResult<HistoryEntry[]>(tx.objectStore("visits").getAll());
  const bookmarks = await requestResult<BookmarkEntry[]>(tx.objectStore("bookmarks").getAll());
  for (const entry of visits) {
    const record = entry.updatedBy === "migration" ? { ...entry, updatedBy: info.deviceId } : entry;
    if (record !== entry) visitStore.put(record);
    putOutbox(outbox, "history", "upsert", record, info);
  }
  for (const entry of bookmarks) {
    const record = entry.updatedBy === "migration" ? { ...entry, updatedBy: info.deviceId } : entry;
    if (record !== entry) bookmarkStore.put(record);
    putOutbox(outbox, "bookmark", "upsert", record, info);
  }
  tx.objectStore("sync_state").put({ key: "bootstrap", value: "queued" });
  await transactionDone(tx);
  return true;
}

export async function applyRemoteChanges(changes: RemoteChange[]): Promise<void> {
  if (changes.length === 0) return;
  const db = await openDB();
  const tx = db.transaction(["visits", "bookmarks"], "readwrite");
  for (const change of changes) {
    const store = tx.objectStore(change.kind === "history" ? "visits" : "bookmarks");
    const current = await requestResult<HistoryEntry | BookmarkEntry | undefined>(
      store.index("syncId").get(change.itemId),
    );
    if (current && !isRemoteNewer(change, current)) continue;

    if (change.operation === "delete") {
      if (current) store.delete(current.id!);
      continue;
    }

    const payload = change.payload;
    if (!isRecord(payload)) throw new Error("Invalid sync payload");
    const normalized = normalizeRemotePayload(change, payload);
    if (current) normalized.id = current.id;
    store.put(normalized);
  }
  return transactionDone(tx);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRemoteNewer(change: RemoteChange, current: HistoryEntry | BookmarkEntry): boolean {
  return (
    change.clientUpdatedAt > current.updatedAt ||
    (change.clientUpdatedAt === current.updatedAt && change.deviceId > current.updatedBy)
  );
}

function requiredString(value: unknown): value is string {
  return typeof value === "string";
}

function normalizeRemotePayload(
  change: RemoteChange,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!requiredString(payload.url) || !requiredString(payload.favicon))
    throw new Error("Invalid sync payload");
  if (change.kind === "history") {
    if (!requiredString(payload.title) || typeof payload.visitedAt !== "number")
      throw new Error("Invalid sync payload");
    return {
      syncId: change.itemId,
      url: payload.url,
      title: payload.title,
      favicon: payload.favicon,
      visitedAt: payload.visitedAt,
      updatedAt: change.clientUpdatedAt,
      updatedBy: change.deviceId,
    };
  }
  if (
    !requiredString(payload.name) ||
    !requiredString(payload.folder) ||
    typeof payload.createdAt !== "number"
  )
    throw new Error("Invalid sync payload");
  return {
    syncId: change.itemId,
    url: payload.url,
    name: payload.name,
    favicon: payload.favicon,
    folder: payload.folder,
    createdAt: payload.createdAt,
    updatedAt: change.clientUpdatedAt,
    updatedBy: change.deviceId,
  };
}

export async function commitSyncBatch(
  operationIds: string[],
  cursor: number,
  pendingDeletionIds: number[],
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(["sync_outbox", "sync_state"], "readwrite");
  const store = tx.objectStore("sync_outbox");
  for (const operationId of operationIds) store.delete(operationId);
  tx.objectStore("sync_state").put({ key: "cursor", value: cursor });
  tx.objectStore("sync_state").put({ key: "pendingDeletionIds", value: pendingDeletionIds });
  return transactionDone(tx);
}

export async function markBootstrapComplete(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction("sync_state", "readwrite");
  tx.objectStore("sync_state").put({ key: "bootstrap", value: "complete" });
  return transactionDone(tx);
}
