import { cors } from "hono/cors";
import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  bookmarks,
  deletionEventDevices,
  deletionEvents,
  historyEntries,
  plans,
  syncOperations,
  users,
} from "./schema.ts";

export interface Env {
  DB: D1Database;
  CORS_ORIGINS?: string;
  SYNC_RATE_LIMITER: RateLimit;
}

type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
  };
};

type SyncKind = "history" | "bookmark";
type SyncOperation = "upsert" | "delete";
type ChangePayload = Record<string, unknown>;

type IncomingChange = {
  operationId: string;
  itemId: string;
  kind: SyncKind;
  operation: SyncOperation;
  clientUpdatedAt: number;
  deviceId: string;
  payload?: ChangePayload;
};

type SyncRequest = {
  cursor?: number;
  deviceId: string;
  changes: IncomingChange[];
  acknowledgedDeletionIds?: number[];
};

const MAX_CHANGES = 100;
const MAX_RESPONSE_CHANGES = 500;
const MAX_BODY_BYTES = 1_048_576;
const MAX_STRING_LENGTH = 512;
const SERVER_DEVICE_ID = "\uffff";
const MAX_HISTORY_PRUNE_PER_SYNC = 1_000;
const DEFAULT_PLAN_ID = "free";

function isLimited(value: number): boolean {
  return value >= 0;
}

class ApiError extends Error {
  readonly status: 409 | 429 | 503;
  readonly code: string;

  constructor(
    status: 409 | 429 | 503,
    code: string,
    message: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log({
    service: "mugen-history-sync",
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  });
}

function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error({
    service: "mugen-history-sync",
    event,
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    ...fields,
  });
}

const localOriginPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const extensionOriginPattern = /^(?:chrome|moz)-extension:\/\/[a-z\d-]+$/i;

function configuredOrigins(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? []
  );
}

function allowedOrigin(origin: string, configured: string[]): boolean {
  if (configured.length > 0) return configured.includes("*") || configured.includes(origin);
  return localOriginPattern.test(origin) || extensionOriginPattern.test(origin);
}

async function userIdForToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown, maxLength = MAX_STRING_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isNullableString(value: unknown, maxLength = MAX_STRING_LENGTH): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPayload(kind: SyncKind, value: unknown): value is ChangePayload {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.url) || !isNullableString(value.favicon)) return false;
  if (kind === "bookmark") {
    return (
      isBoundedString(value.name) &&
      isTimestamp(value.createdAt) &&
      typeof value.folder === "string" &&
      value.folder.length <= MAX_STRING_LENGTH
    );
  }
  return isNullableString(value.title) && isTimestamp(value.visitedAt);
}

function validateChange(value: unknown): value is IncomingChange {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.operationId) || !isBoundedString(value.itemId)) return false;
  if (value.kind !== "history" && value.kind !== "bookmark") return false;
  if (value.operation !== "upsert" && value.operation !== "delete") return false;
  if (!isTimestamp(value.clientUpdatedAt) || !isBoundedString(value.deviceId)) return false;
  return value.operation === "delete" || validPayload(value.kind, value.payload);
}

function validateRequest(value: unknown): value is SyncRequest {
  if (!isRecord(value)) return false;
  if (value.cursor !== undefined && !isTimestamp(value.cursor)) return false;
  if (!isBoundedString(value.deviceId) || !Array.isArray(value.changes)) return false;
  if (value.changes.length > MAX_CHANGES || !value.changes.every(validateChange)) return false;
  if (value.acknowledgedDeletionIds !== undefined) {
    if (
      !Array.isArray(value.acknowledgedDeletionIds) ||
      value.acknowledgedDeletionIds.length > MAX_RESPONSE_CHANGES
    ) {
      return false;
    }
    if (!value.acknowledgedDeletionIds.every(isTimestamp)) return false;
  }
  return value.changes.every((change) => change.deviceId === value.deviceId);
}

function isNewer(
  incoming: Pick<IncomingChange, "clientUpdatedAt" | "deviceId">,
  current:
    | Pick<typeof bookmarks.$inferSelect, "clientUpdatedAt" | "updatedBy">
    | Pick<typeof deletionEvents.$inferSelect, "clientUpdatedAt" | "deviceId">,
): boolean {
  const currentDeviceId = "updatedBy" in current ? current.updatedBy : current.deviceId;
  return (
    incoming.clientUpdatedAt > current.clientUpdatedAt ||
    (incoming.clientUpdatedAt === current.clientUpdatedAt && incoming.deviceId > currentDeviceId)
  );
}

type DatabaseExecutor = Pick<ReturnType<typeof drizzle>, "select" | "insert" | "update" | "delete">;

async function getPlan(db: DatabaseExecutor, planId: string): Promise<typeof plans.$inferSelect> {
  const plan = await db.select().from(plans).where(eq(plans.id, planId)).limit(1).get();
  if (plan) return plan;
  const fallback = await db.select().from(plans).where(eq(plans.id, DEFAULT_PLAN_ID)).limit(1).get();
  if (!fallback) throw new Error("Default plan is not configured");
  return fallback;
}

async function ensureUser(
  db: DatabaseExecutor,
  userId: string,
  deviceId: string,
): Promise<{ user: typeof users.$inferSelect; plan: typeof plans.$inferSelect }> {
  let existing = await db.select().from(users).where(eq(users.id, userId)).limit(1).get();
  if (!existing) {
    await db
      .insert(users)
      .values({
        id: userId,
        registeredAt: Date.now(),
        deviceIds: [deviceId],
        planId: DEFAULT_PLAN_ID,
        revision: 0,
      })
      .onConflictDoNothing({ target: users.id })
      .run();
    existing = await db.select().from(users).where(eq(users.id, userId)).limit(1).get();
  }
  if (!existing) throw new Error("User could not be created");

  const plan = await getPlan(db, existing.planId || DEFAULT_PLAN_ID);

  const deviceIds = Array.isArray(existing.deviceIds) ? existing.deviceIds : [];
  if (!deviceIds.includes(deviceId)) {
    if (isLimited(plan.maxDevices) && deviceIds.length >= plan.maxDevices) {
      throw new ApiError(409, "device_limit_reached", "同時利用できるデバイス数の上限に達しています");
    }
    deviceIds.push(deviceId);
    await db.update(users).set({ deviceIds }).where(eq(users.id, userId)).run();
    existing = { ...existing, deviceIds };
  }
  return { user: existing, plan };
}

async function nextRevision(db: DatabaseExecutor, userId: string): Promise<number> {
  const updated = await db
    .update(users)
    .set({ revision: sql`${users.revision} + 1` })
    .where(eq(users.id, userId))
    .returning({ revision: users.revision })
    .get();
  if (!updated) throw new Error("User revision could not be allocated");
  return updated.revision;
}

async function currentItem(
  db: DatabaseExecutor,
  userId: string,
  change: Pick<IncomingChange, "kind" | "itemId">,
): Promise<typeof bookmarks.$inferSelect | typeof historyEntries.$inferSelect | undefined> {
  if (change.kind === "bookmark") {
    return await db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, userId), eq(bookmarks.itemId, change.itemId)))
      .limit(1)
      .get();
  }
  return await db
    .select()
    .from(historyEntries)
    .where(and(eq(historyEntries.userId, userId), eq(historyEntries.itemId, change.itemId)))
    .limit(1)
    .get();
}

async function latestDeletion(
  db: DatabaseExecutor,
  userId: string,
  change: Pick<IncomingChange, "kind" | "itemId">,
): Promise<typeof deletionEvents.$inferSelect | undefined> {
  return await db
    .select()
    .from(deletionEvents)
    .where(
      and(
        eq(deletionEvents.userId, userId),
        eq(deletionEvents.kind, change.kind),
        eq(deletionEvents.itemId, change.itemId),
      ),
    )
    .orderBy(desc(deletionEvents.serverRevision))
    .limit(1)
    .get();
}

async function recordDeletion(
  db: DatabaseExecutor,
  user: typeof users.$inferSelect,
  change: Pick<IncomingChange, "kind" | "itemId" | "clientUpdatedAt" | "deviceId">,
  deviceIds: string[],
  serverDeletedAt: number,
): Promise<number> {
  const serverRevision = await nextRevision(db, user.id);
  const inserted = await db
    .insert(deletionEvents)
    .values({
      userId: user.id,
      itemId: change.itemId,
      kind: change.kind,
      clientUpdatedAt: change.clientUpdatedAt,
      deviceId: change.deviceId,
      serverRevision,
      serverDeletedAt,
    })
    .returning({ id: deletionEvents.id })
    .get();
  if (!inserted) throw new Error("Deletion event could not be recorded");

  const targets = [...new Set(deviceIds)].map((deviceId) => ({
    deletionId: inserted.id,
    deviceId,
    acknowledgedAt: deviceId === change.deviceId ? serverDeletedAt : null,
  }));
  if (targets.length > 0) await db.insert(deletionEventDevices).values(targets).run();
  return inserted.id;
}

async function removeCurrentItem(
  db: DatabaseExecutor,
  userId: string,
  change: Pick<IncomingChange, "kind" | "itemId">,
): Promise<void> {
  if (change.kind === "bookmark") {
    await db
      .delete(bookmarks)
      .where(and(eq(bookmarks.userId, userId), eq(bookmarks.itemId, change.itemId)))
      .run();
  } else {
    await db
      .delete(historyEntries)
      .where(and(eq(historyEntries.userId, userId), eq(historyEntries.itemId, change.itemId)))
      .run();
  }
}

async function applyDelete(
  db: DatabaseExecutor,
  user: typeof users.$inferSelect,
  change: IncomingChange,
  deviceIds: string[],
  now: number,
): Promise<void> {
  const current = await currentItem(db, user.id, change);
  const previousDeletion = await latestDeletion(db, user.id, change);
  if (
    (current && !isNewer(change, current)) ||
    (previousDeletion && !isNewer(change, previousDeletion))
  )
    return;

  if (current) await removeCurrentItem(db, user.id, change);
  await recordDeletion(db, user, change, deviceIds, now);
}

async function applyUpsert(
  db: DatabaseExecutor,
  user: typeof users.$inferSelect,
  plan: typeof plans.$inferSelect,
  change: IncomingChange,
  deviceIds: string[],
  now: number,
): Promise<void> {
  const payload = change.payload!;
  const current = await currentItem(db, user.id, change);
  const previousDeletion = await latestDeletion(db, user.id, change);
  if (
    (current && !isNewer(change, current)) ||
    (previousDeletion && !isNewer(change, previousDeletion))
  )
    return;

  if (change.kind === "bookmark") {
    const url = payload.url as string;
    const conflicting = await db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.url, url)))
      .limit(1)
      .get();
    if (conflicting && conflicting.itemId !== change.itemId) {
      if (!isNewer(change, conflicting)) {
        await recordDeletion(
          db,
          user,
          {
            ...change,
            clientUpdatedAt: Math.max(change.clientUpdatedAt, conflicting.clientUpdatedAt) + 1,
            deviceId: SERVER_DEVICE_ID,
          },
          deviceIds,
          now,
        );
        return;
      }
      await removeCurrentItem(db, user.id, { kind: "bookmark", itemId: conflicting.itemId });
      await recordDeletion(
        db,
        user,
        {
          ...change,
          itemId: conflicting.itemId,
          clientUpdatedAt: change.clientUpdatedAt,
        },
        deviceIds,
        now,
      );
    }

    if (!current) {
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(bookmarks)
        .where(eq(bookmarks.userId, user.id))
        .get();
      if (isLimited(plan.maxBookmarks) && Number(countResult?.count ?? 0) >= plan.maxBookmarks) {
        throw new ApiError(409, "bookmark_limit_reached", "ブックマーク件数の上限に達しています");
      }
    }

    const serverRevision = await nextRevision(db, user.id);
    const values = {
      userId: user.id,
      itemId: change.itemId,
      url,
      name: payload.name as string,
      favicon: payload.favicon as string,
      folder: typeof payload.folder === "string" ? payload.folder : "",
      createdAt:
        current && "createdAt" in current ? current.createdAt : (payload.createdAt as number),
      serverRevision,
      serverUpdatedAt: now,
      clientUpdatedAt: change.clientUpdatedAt,
      updatedBy: change.deviceId,
    };
    if (current) {
      await db
        .update(bookmarks)
        .set(values)
        .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.itemId, change.itemId)))
        .run();
    } else {
      await db.insert(bookmarks).values(values).run();
    }
    return;
  }

  const serverRevision = await nextRevision(db, user.id);
  const values = {
    userId: user.id,
    itemId: change.itemId,
    url: payload.url as string,
    title: payload.title as string,
    favicon: payload.favicon as string,
    visitedAt: payload.visitedAt as number,
    serverRevision,
    serverUpdatedAt: now,
    clientUpdatedAt: change.clientUpdatedAt,
    updatedBy: change.deviceId,
  };
  if (current) {
    await db
      .update(historyEntries)
      .set(values)
      .where(and(eq(historyEntries.userId, user.id), eq(historyEntries.itemId, change.itemId)))
      .run();
  } else {
    await db.insert(historyEntries).values(values).run();
  }
}

async function pruneHistory(
  db: DatabaseExecutor,
  user: typeof users.$inferSelect,
  plan: typeof plans.$inferSelect,
): Promise<number> {
  if (!isLimited(plan.maxHistoryEntries)) return 0;
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(historyEntries)
    .where(eq(historyEntries.userId, user.id))
    .get();
  const excess = Math.max(0, Number(countResult?.count ?? 0) - plan.maxHistoryEntries);
  if (excess === 0) return 0;

  const rows = await db
    .select()
    .from(historyEntries)
    .where(eq(historyEntries.userId, user.id))
    .orderBy(asc(historyEntries.visitedAt), asc(historyEntries.serverRevision))
    .limit(Math.min(excess, MAX_HISTORY_PRUNE_PER_SYNC))
    .all();
  for (const row of rows) {
    // Capacity pruning is server-local retention, not a user deletion.
    // Do not create deletion events: otherwise every pruned history entry
    // consumes tombstone and per-device acknowledgement rows indefinitely.
    await removeCurrentItem(db, user.id, { kind: "history", itemId: row.itemId });
  }
  return rows.length;
}

async function cleanupOperationLog(
  db: DatabaseExecutor,
  userId: string,
  plan: typeof plans.$inferSelect,
  now: number,
): Promise<number> {
  const cutoff = now - plan.operationRetentionDays * 24 * 60 * 60 * 1_000;
  const result = await db
    .delete(syncOperations)
    .where(and(eq(syncOperations.userId, userId), lt(syncOperations.receivedAt, cutoff)))
    .run();
  return result.meta.changes ?? 0;
}

async function acknowledgeDeletions(
  db: DatabaseExecutor,
  userId: string,
  deviceId: string,
  deletionIds: number[],
  now: number,
): Promise<void> {
  for (const deletionId of deletionIds) {
    const event = await db
      .select({ id: deletionEvents.id })
      .from(deletionEvents)
      .where(and(eq(deletionEvents.id, deletionId), eq(deletionEvents.userId, userId)))
      .limit(1)
      .get();
    if (!event) continue;

    await db
      .update(deletionEventDevices)
      .set({ acknowledgedAt: now })
      .where(
        and(
          eq(deletionEventDevices.deletionId, deletionId),
          eq(deletionEventDevices.deviceId, deviceId),
          isNull(deletionEventDevices.acknowledgedAt),
        ),
      )
      .run();

    const pending = await db
      .select({ deviceId: deletionEventDevices.deviceId })
      .from(deletionEventDevices)
      .where(
        and(
          eq(deletionEventDevices.deletionId, deletionId),
          isNull(deletionEventDevices.acknowledgedAt),
        ),
      )
      .limit(1)
      .get();
    if (!pending) {
      await db
        .delete(deletionEventDevices)
        .where(eq(deletionEventDevices.deletionId, deletionId))
        .run();
      await db.delete(deletionEvents).where(eq(deletionEvents.id, deletionId)).run();
    }
  }
}

type OutgoingChange = {
  serverRevision: number;
  operationId: string;
  itemId: string;
  kind: SyncKind;
  operation: SyncOperation;
  clientUpdatedAt: number;
  deviceId: string;
  payload?: ChangePayload;
  deletionId?: number;
};

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const origins = configuredOrigins(c.env.CORS_ORIGINS);
  return cors({
    origin: (origin) => (allowedOrigin(origin, origins) ? origin : undefined),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86_400,
  })(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

app.use("/v1/sync", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const authorization = c.req.header("Authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match || match[1].length > MAX_STRING_LENGTH) {
    logEvent("auth_rejected", { route: "/v1/sync", reason: "invalid_bearer" });
    return c.json({ error: "unauthorized" }, 401);
  }
  const userId = await userIdForToken(match[1]);
  const limited = await c.env.SYNC_RATE_LIMITER.limit({ key: userId });
  if (!limited.success) {
    logEvent("rate_limited", { route: "/v1/sync", userIdPrefix: userId.slice(0, 12) });
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
  }
  c.set("userId", userId);
  return next();
});

app.post("/v1/sync", async (c) => {
  const contentLength = Number(c.req.header("Content-Length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return c.json({ error: "request_too_large" }, 413);
  if (!c.req.header("Content-Type")?.toLowerCase().includes("application/json")) {
    return c.json({ error: "content_type_must_be_json" }, 415);
  }

  const body = await c.req.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
    return c.json({ error: "request_too_large" }, 413);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!validateRequest(payload)) return c.json({ error: "invalid_request" }, 400);

  const userId = c.get("userId");
  const db = drizzle(c.env.DB);
  const now = Date.now();

  const applied = await db.transaction(async (tx) => {
    const account = await ensureUser(tx, userId, payload.deviceId);
    await acknowledgeDeletions(
      tx,
      userId,
      payload.deviceId,
      payload.acknowledgedDeletionIds ?? [],
      now,
    );

    for (const change of payload.changes) {
      const claimed = await tx
        .insert(syncOperations)
        .values({
          userId,
          operationId: change.operationId,
          receivedAt: now,
        })
        .onConflictDoNothing({ target: [syncOperations.userId, syncOperations.operationId] })
        .run();
      if (claimed.meta.changes === 0) continue;

      if (change.operation === "delete") {
        await applyDelete(tx, account.user, change, account.user.deviceIds, now);
      } else {
        await applyUpsert(tx, account.user, account.plan, change, account.user.deviceIds, now);
      }
    }

    const prunedHistory = await pruneHistory(tx, account.user, account.plan);
    const cleanedOperations = await cleanupOperationLog(tx, userId, account.plan, now);
    return { account, prunedHistory, cleanedOperations };
  });
  const { account, prunedHistory, cleanedOperations } = applied;
  if (prunedHistory > 0 || cleanedOperations > 0) {
    logEvent("maintenance_completed", {
      route: "/v1/sync",
      userIdPrefix: userId.slice(0, 12),
      plan: account.plan.id,
      prunedHistory,
      cleanedOperations,
    });
  }

  const cursor = payload.cursor ?? 0;
  const bookmarkRows = await db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), gt(bookmarks.serverRevision, cursor)))
    .orderBy(asc(bookmarks.serverRevision))
    .limit(MAX_RESPONSE_CHANGES)
    .all();
  const historyRows = await db
    .select()
    .from(historyEntries)
    .where(and(eq(historyEntries.userId, userId), gt(historyEntries.serverRevision, cursor)))
    .orderBy(asc(historyEntries.serverRevision))
    .limit(MAX_RESPONSE_CHANGES)
    .all();
  const deletionRows = await db
    .select()
    .from(deletionEvents)
    .where(and(eq(deletionEvents.userId, userId), gt(deletionEvents.serverRevision, cursor)))
    .orderBy(asc(deletionEvents.serverRevision))
    .limit(MAX_RESPONSE_CHANGES)
    .all();

  const changes: OutgoingChange[] = [
    ...bookmarkRows.map((row) => ({
      serverRevision: row.serverRevision,
      operationId: `bookmark:${row.itemId}:${row.serverRevision}`,
      itemId: row.itemId,
      kind: "bookmark" as const,
      operation: "upsert" as const,
      clientUpdatedAt: row.clientUpdatedAt,
      deviceId: row.updatedBy,
      payload: {
        syncId: row.itemId,
        url: row.url,
        name: row.name,
        favicon: row.favicon,
        folder: row.folder,
        createdAt: row.createdAt,
      },
    })),
    ...historyRows.map((row) => ({
      serverRevision: row.serverRevision,
      operationId: `history:${row.itemId}:${row.serverRevision}`,
      itemId: row.itemId,
      kind: "history" as const,
      operation: "upsert" as const,
      clientUpdatedAt: row.clientUpdatedAt,
      deviceId: row.updatedBy,
      payload: {
        syncId: row.itemId,
        url: row.url,
        title: row.title,
        favicon: row.favicon,
        visitedAt: row.visitedAt,
      },
    })),
    ...deletionRows.map((row) => ({
      serverRevision: row.serverRevision,
      operationId: `deletion:${row.id}`,
      itemId: row.itemId,
      kind: row.kind,
      operation: "delete" as const,
      clientUpdatedAt: row.clientUpdatedAt,
      deviceId: row.deviceId,
      deletionId: row.id,
    })),
  ]
    .sort((left, right) => left.serverRevision - right.serverRevision)
    .slice(0, MAX_RESPONSE_CHANGES);

  const nextCursor = changes.at(-1)?.serverRevision ?? cursor;
  logEvent("sync_completed", {
    route: "/v1/sync",
    userIdPrefix: userId.slice(0, 12),
    plan: account.plan.id,
    deviceCount: account.user.deviceIds.length,
    inputChanges: payload.changes.length,
    outputChanges: changes.length,
    cursor: nextCursor,
    durationMs: Date.now() - now,
  });
  return c.json({
    cursor: nextCursor,
    changes,
  });
});

app.onError((error, c) => {
  if (error instanceof ApiError) {
    logEvent("request_rejected", {
      route: c.req.path,
      code: error.code,
      status: error.status,
      userIdPrefix: c.get("userId")?.slice(0, 12),
    });
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  logError("request_failed", error, { route: c.req.path, status: 500 });
  return c.json({ error: "internal_server_error" }, 500);
});

export { app };
export default app;
