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
// import { extensionApi } from "./extension-api.ts";

const MIN_SECRET_LENGTH = 32;
const RESPONSE_PAGE_SIZE = 500;

export interface SyncSettings {
  syncUrl: string;
  syncSecret: string;
  syncDeviceId: string;
  syncEnabled: boolean;
}

export interface SyncResult {
  enabled: boolean;
  uploaded: number;
  downloaded: number;
  cursor: number;
}

interface SyncResponseChange {
  operationId: string;
  itemId: string;
  kind: "history" | "bookmark";
  operation: "upsert" | "delete";
  clientUpdatedAt: number;
  deviceId: string;
  payload?: unknown;
  deletionId?: number;
}

interface SyncResponse {
  cursor: number;
  changes: SyncResponseChange[];
}

let inFlight: Promise<SyncResult> | undefined;

function uuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function validSecret(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH;
}

export function generateSyncSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function getSyncSettings(): Promise<SyncSettings> {
  const data = (await browser.storage.local.get([
    "syncUrl",
    "syncSecret",
    "syncDeviceId",
    "syncEnabled",
  ])) as Partial<SyncSettings>;
  return {
    syncUrl: typeof data.syncUrl === "string" ? data.syncUrl : "",
    syncSecret: typeof data.syncSecret === "string" ? data.syncSecret : "",
    syncDeviceId: typeof data.syncDeviceId === "string" ? data.syncDeviceId : "",
    syncEnabled: data.syncEnabled === true,
  };
}

export async function saveSyncSettings(syncUrl: string, syncSecret: string): Promise<void> {
  if (!validUrl(syncUrl)) throw new Error("同期サーバーURLは http または https を指定してください");
  if (!validSecret(syncSecret))
    throw new Error(`同期秘密鍵は${MIN_SECRET_LENGTH}文字以上で指定してください`);
  const normalizedUrl = syncUrl.replace(/\/+$/, "");
  const current = await getSyncSettings();
  await browser.storage.local.set({
    syncUrl: normalizedUrl,
    syncSecret,
    syncDeviceId: current.syncDeviceId || uuid(),
    syncEnabled: true,
  });
  const accountChanged = current.syncUrl !== normalizedUrl || current.syncSecret !== syncSecret;
  await resetSyncState(accountChanged);
}

export function requestSync(): Promise<SyncResult> {
  return browser.runtime
    .sendMessage({ type: "SYNC_NOW" })
    .then((value) => value as SyncResult);
}

async function deriveAuthKey(secret: string): Promise<CryptoKey> {
  const rootKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const derive = (
    label: string,
    keyAlgorithm: AesKeyGenParams | HmacKeyGenParams,
    usages: KeyUsage[],
  ) =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode(`mugen-history/${label}/salt`),
        info: new TextEncoder().encode(`mugen-history/${label}/v1`),
      },
      rootKey,
      keyAlgorithm,
      false,
      usages,
    );
  return derive("authorization", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]);
}

async function authorizationToken(authKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    authKey,
    new TextEncoder().encode("mugen-history-sync-auth-v1"),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function toRequestChange(entry: OutboxEntry): Promise<Record<string, unknown>> {
  const payload =
    entry.operation === "upsert" ? (JSON.parse(entry.payloadJson) as unknown) : undefined;
  return {
    operationId: entry.operationId,
    itemId: entry.itemId,
    kind: entry.kind,
    operation: entry.operation,
    clientUpdatedAt: entry.clientUpdatedAt,
    deviceId: entry.deviceId,
    ...(payload === undefined ? {} : { payload }),
  };
}

function isResponse(value: unknown): value is SyncResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { cursor?: unknown; changes?: unknown };
  return (
    typeof response.cursor === "number" &&
    Number.isSafeInteger(response.cursor) &&
    Array.isArray(response.changes) &&
    response.changes.length <= RESPONSE_PAGE_SIZE
  );
}

function isResponseChange(value: unknown): value is SyncResponseChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Partial<SyncResponseChange>;
  return (
    typeof change.operationId === "string" &&
    typeof change.itemId === "string" &&
    (change.kind === "history" || change.kind === "bookmark") &&
    (change.operation === "upsert" || change.operation === "delete") &&
    typeof change.clientUpdatedAt === "number" &&
    Number.isSafeInteger(change.clientUpdatedAt) &&
    typeof change.deviceId === "string" &&
    (change.deletionId === undefined ||
      (typeof change.deletionId === "number" && Number.isSafeInteger(change.deletionId)))
  );
}

async function postSync(
  settings: SyncSettings,
  token: string,
  body: Record<string, unknown>,
): Promise<SyncResponse> {
  const response = await fetch(`${settings.syncUrl.replace(/\/+$/, "")}/v1/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`同期サーバーエラー: HTTP ${response.status}`);
  const json: unknown = await response.json();
  if (!isResponse(json) || !json.changes.every(isResponseChange))
    throw new Error("同期サーバーの応答が不正です");
  return json;
}

async function performSync(): Promise<SyncResult> {
  const settings = await getSyncSettings();
  if (!settings.syncEnabled) return { enabled: false, uploaded: 0, downloaded: 0, cursor: 0 };
  if (!validUrl(settings.syncUrl)) throw new Error("同期サーバーURLが不正です");
  if (!validSecret(settings.syncSecret))
    throw new Error(`同期秘密鍵は${MIN_SECRET_LENGTH}文字以上で指定してください`);
  if (!settings.syncDeviceId) throw new Error("同期デバイスIDがありません");

  await enqueueBootstrap();
  const authKey = await deriveAuthKey(settings.syncSecret);
  const token = await authorizationToken(authKey);
  let state = await getSyncState();
  let uploaded = 0;
  let downloaded = 0;
  let shouldContinue = true;

  while (shouldContinue) {
    const outbox = await getOutbox(100);
    const changes = await Promise.all(outbox.map((entry) => toRequestChange(entry)));
    const response = await postSync(settings, token, {
      cursor: state.cursor ?? 0,
      deviceId: settings.syncDeviceId,
      changes,
      acknowledgedDeletionIds: state.pendingDeletionIds ?? [],
    });
    const remoteChanges: RemoteChange[] = [];
    for (const change of response.changes) {
      remoteChanges.push({
        itemId: change.itemId,
        kind: change.kind,
        operation: change.operation,
        clientUpdatedAt: change.clientUpdatedAt,
        deviceId: change.deviceId,
        payload: change.payload,
        deletionId: change.deletionId,
      });
    }
    await applyRemoteChanges(remoteChanges);
    const pendingDeletionIds = response.changes
      .filter((change) => change.operation === "delete" && change.deletionId !== undefined)
      .map((change) => change.deletionId!);
    await commitSyncBatch(
      outbox.map((entry) => entry.operationId),
      response.cursor,
      pendingDeletionIds,
    );
    uploaded += outbox.length;
    downloaded += response.changes.length;
    state = { ...state, cursor: response.cursor, pendingDeletionIds };
    const remaining = await getOutbox(1);
    shouldContinue =
      response.changes.length === RESPONSE_PAGE_SIZE ||
      remaining.length > 0 ||
      pendingDeletionIds.length > 0;
  }

  if (state.bootstrap !== "complete") await markBootstrapComplete();
  return { enabled: true, uploaded, downloaded, cursor: state.cursor ?? 0 };
}

export function syncNow(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = performSync().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
