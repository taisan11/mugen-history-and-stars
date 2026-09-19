import {
  applyRemoteChanges,
  commitSyncBatch,
  enqueueBootstrap,
  getOutbox,
  getSyncState,
  markBootstrapComplete,
  resetSyncState,
  type OutboxEntry,
  type RemoteChange,
} from "./db.ts";

const RESPONSE_PAGE_SIZE = 500;
const ACCESS_SKEW_MS = 30_000;

export interface AuthUser {
  id: string;
  email: string | null;
  displayName: string;
  status: "active" | "disabled";
  plan: { id: string; maxBookmarks: number; maxHistoryEntries: number; };
  deviceCount: number;
}

export interface SyncSettings {
  syncUrl: string;
  syncDeviceId: string;
  syncEnabled: boolean;
  authAccessToken: string;
  authRefreshToken: string;
  authAccessExpiresAt: number;
  authUser?: AuthUser;
}

export interface SyncResult { enabled: boolean; uploaded: number; downloaded: number; cursor: number; }
interface SyncResponseChange { operationId: string; itemId: string; kind: "history" | "bookmark"; operation: "upsert" | "delete"; clientUpdatedAt: number; deviceId: string; payload?: unknown; deletionId?: number; }
interface SyncResponse { cursor: number; changes: SyncResponseChange[]; }
interface AuthResponse { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number; user: AuthUser; }

let inFlight: Promise<SyncResult> | undefined;

function uuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validUrl(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0; } catch { return false; }
}

function normalizeSyncUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return value.replace(/\/+$/, "");
    if (url.pathname.replace(/\/+$/, "") === "/v1/sync") url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

export async function getSyncSettings(): Promise<SyncSettings> {
  const data = (await browser.storage.local.get(["syncUrl", "syncDeviceId", "syncEnabled", "authAccessToken", "authRefreshToken", "authAccessExpiresAt", "authUser"])) as Partial<SyncSettings>;
  return {
    syncUrl: typeof data.syncUrl === "string" ? normalizeSyncUrl(data.syncUrl) : "",
    syncDeviceId: typeof data.syncDeviceId === "string" ? data.syncDeviceId : "",
    syncEnabled: data.syncEnabled === true,
    authAccessToken: typeof data.authAccessToken === "string" ? data.authAccessToken : "",
    authRefreshToken: typeof data.authRefreshToken === "string" ? data.authRefreshToken : "",
    authAccessExpiresAt: typeof data.authAccessExpiresAt === "number" ? data.authAccessExpiresAt : 0,
    authUser: data.authUser,
  };
}

export async function saveSyncSettings(syncUrl: string): Promise<void> {
  if (!validUrl(syncUrl)) throw new Error("同期サーバーURLは http または https を指定してください");
  const current = await getSyncSettings();
  const normalizedUrl = normalizeSyncUrl(syncUrl);
  await browser.storage.local.set({ syncUrl: normalizedUrl, syncDeviceId: current.syncDeviceId || uuid(), syncEnabled: true });
  await resetSyncState(current.syncUrl !== normalizedUrl);
}

export async function saveAuthTokens(response: AuthResponse): Promise<void> {
  await browser.storage.local.set({ authAccessToken: response.accessToken, authRefreshToken: response.refreshToken, authAccessExpiresAt: response.accessExpiresAt, authUser: response.user, syncEnabled: true });
}

export async function clearAuthTokens(): Promise<void> {
  await browser.storage.local.remove(["authAccessToken", "authRefreshToken", "authAccessExpiresAt", "authUser"]);
}

export async function loginWithPassword(email: string, password: string): Promise<void> {
  const settings = await getSyncSettings();
  if (!validUrl(settings.syncUrl)) throw new Error("先に正しいサーバーURLを保存してください");
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !password) throw new Error("メールアドレスとパスワードを入力してください");
  const response = await fetch(`${settings.syncUrl.replace(/\/+$/, "")}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: normalizedEmail, password, client: "extension" }),
  });
  const json = (await response.json().catch(() => ({}))) as Partial<AuthResponse> & { error?: string };
  if (!response.ok) {
    if (response.status === 401) throw new Error("メールアドレスまたはパスワードが正しくありません");
    throw new Error(typeof json.error === "string" ? json.error : `ログインに失敗しました（HTTP ${response.status}）`);
  }
  if (typeof json.accessToken !== "string" || typeof json.refreshToken !== "string" || typeof json.accessExpiresAt !== "number" || typeof json.refreshExpiresAt !== "number" || !json.user) {
    throw new Error("認証サーバーの応答が不正です");
  }
  await saveAuthTokens(json as AuthResponse);
}

export function requestSync(): Promise<SyncResult> {
  return browser.runtime.sendMessage({ type: "SYNC_NOW" }).then((value) => value as SyncResult);
}

async function refreshAccessToken(settings: SyncSettings): Promise<string> {
  if (!settings.authRefreshToken || !validUrl(settings.syncUrl)) throw new Error("アカウントにログインしてください");
  const response = await fetch(`${settings.syncUrl.replace(/\/+$/, "")}/v1/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client: "extension", refreshToken: settings.authRefreshToken }) });
  if (!response.ok) { await clearAuthTokens(); throw new Error("ログインの有効期限が切れています"); }
  const json = (await response.json()) as AuthResponse;
  if (!json.accessToken || !json.refreshToken) throw new Error("認証情報の更新に失敗しました");
  await saveAuthTokens(json);
  return json.accessToken;
}

async function accessToken(settings: SyncSettings): Promise<string> {
  if (settings.authAccessToken && settings.authAccessExpiresAt > Date.now() + ACCESS_SKEW_MS) return settings.authAccessToken;
  return refreshAccessToken(settings);
}

async function toRequestChange(entry: OutboxEntry): Promise<Record<string, unknown>> {
  const payload = entry.operation === "upsert" ? (JSON.parse(entry.payloadJson) as unknown) : undefined;
  return { operationId: entry.operationId, itemId: entry.itemId, kind: entry.kind, operation: entry.operation, clientUpdatedAt: entry.clientUpdatedAt, deviceId: entry.deviceId, ...(payload === undefined ? {} : { payload }) };
}

function isResponse(value: unknown): value is SyncResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { cursor?: unknown; changes?: unknown };
  return typeof response.cursor === "number" && Number.isSafeInteger(response.cursor) && Array.isArray(response.changes) && response.changes.length <= RESPONSE_PAGE_SIZE;
}

function isResponseChange(value: unknown): value is SyncResponseChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Partial<SyncResponseChange>;
  return typeof change.operationId === "string" && typeof change.itemId === "string" && (change.kind === "history" || change.kind === "bookmark") && (change.operation === "upsert" || change.operation === "delete") && typeof change.clientUpdatedAt === "number" && Number.isSafeInteger(change.clientUpdatedAt) && typeof change.deviceId === "string";
}

async function postSync(settings: SyncSettings, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${settings.syncUrl.replace(/\/+$/, "")}/v1/sync`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function syncError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
  const code = typeof body.error === "string" ? body.error : undefined;
  const message = typeof body.message === "string" ? body.message : undefined;
  const detail = message ?? code;
  return new Error(`同期サーバーエラー: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
}

async function performSync(): Promise<SyncResult> {
  const settings = await getSyncSettings();
  if (!settings.syncEnabled) return { enabled: false, uploaded: 0, downloaded: 0, cursor: 0 };
  if (!validUrl(settings.syncUrl)) throw new Error("同期サーバーURLが不正です");
  if (!settings.syncDeviceId) throw new Error("同期デバイスIDがありません");
  await enqueueBootstrap();
  let token = await accessToken(settings);
  let state = await getSyncState();
  let uploaded = 0;
  let downloaded = 0;
  let shouldContinue = true;
  while (shouldContinue) {
    const outbox = await getOutbox(100);
    const response = await postSync(settings, token, { cursor: state.cursor ?? 0, deviceId: settings.syncDeviceId, changes: await Promise.all(outbox.map(toRequestChange)), acknowledgedDeletionIds: state.pendingDeletionIds ?? [] });
    if (response.status === 401) { token = await refreshAccessToken(await getSyncSettings()); continue; }
    if (!response.ok) throw await syncError(response);
    const json: unknown = await response.json();
    if (!isResponse(json) || !json.changes.every(isResponseChange)) throw new Error("同期サーバーの応答が不正です");
    const remoteChanges: RemoteChange[] = json.changes.map((change) => ({ itemId: change.itemId, kind: change.kind, operation: change.operation, clientUpdatedAt: change.clientUpdatedAt, deviceId: change.deviceId, payload: change.payload, deletionId: change.deletionId }));
    await applyRemoteChanges(remoteChanges);
    const pendingDeletionIds = json.changes.filter((change) => change.operation === "delete" && change.deletionId !== undefined).map((change) => change.deletionId!);
    await commitSyncBatch(outbox.map((entry) => entry.operationId), json.cursor, pendingDeletionIds);
    uploaded += outbox.length; downloaded += json.changes.length;
    state = { ...state, cursor: json.cursor, pendingDeletionIds };
    const remaining = await getOutbox(1);
    shouldContinue = json.changes.length === RESPONSE_PAGE_SIZE || remaining.length > 0 || pendingDeletionIds.length > 0;
  }
  if (state.bootstrap !== "complete") await markBootstrapComplete();
  return { enabled: true, uploaded, downloaded, cursor: state.cursor ?? 0 };
}

export function syncNow(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = performSync().finally(() => { inFlight = undefined; });
  return inFlight;
}
