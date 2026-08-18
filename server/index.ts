import { cors } from "hono/cors";
import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  bookmarks,
  deletionEventDevices,
  deletionEvents,
  historyEntries,
  syncOperations,
  users,
} from "./schema.ts";

export interface Env {
  DB: D1Database;
  CORS_ORIGINS?: string;
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

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPayload(kind: SyncKind, value: unknown): value is ChangePayload {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.url) || !isBoundedString(value.favicon)) return false;
  if (kind === "bookmark") {
    return (
      isBoundedString(value.name) &&
      isTimestamp(value.createdAt) &&
      typeof value.folder === "string" &&
      value.folder.length <= MAX_STRING_LENGTH
    );
  }
  return isBoundedString(value.title) && isTimestamp(value.visitedAt);
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

async function ensureUser(
  db: ReturnType<typeof drizzle>,
  userId: string,
  deviceId: string,
): Promise<typeof users.$inferSelect> {
  const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1).get();
  if (!existing) {
    return (await db
      .insert(users)
      .values({
        id: userId,
        registeredAt: Date.now(),
        deviceIds: [deviceId],
        revision: 0,
      })
      .returning()
      .get()) as typeof users.$inferSelect;
  }

  const deviceIds = Array.isArray(existing.deviceIds) ? existing.deviceIds : [];
  if (!deviceIds.includes(deviceId)) {
    deviceIds.push(deviceId);
    await db.update(users).set({ deviceIds }).where(eq(users.id, userId)).run();
    return { ...existing, deviceIds };
  }
  return existing;
}

async function nextRevision(db: ReturnType<typeof drizzle>, userId: string): Promise<number> {
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
  db: ReturnType<typeof drizzle>,
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
  db: ReturnType<typeof drizzle>,
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
  db: ReturnType<typeof drizzle>,
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
  db: ReturnType<typeof drizzle>,
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
  db: ReturnType<typeof drizzle>,
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
  db: ReturnType<typeof drizzle>,
  user: typeof users.$inferSelect,
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

async function acknowledgeDeletions(
  db: ReturnType<typeof drizzle>,
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
  if (!match || match[1].length > MAX_STRING_LENGTH) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", await userIdForToken(match[1]));
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
  const user = await ensureUser(db, userId, payload.deviceId);
  const now = Date.now();

  await acknowledgeDeletions(
    db,
    userId,
    payload.deviceId,
    payload.acknowledgedDeletionIds ?? [],
    now,
  );

  for (const change of payload.changes) {
    const claimed = await db
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
      await applyDelete(db, user, change, user.deviceIds, now);
    } else {
      await applyUpsert(db, user, change, user.deviceIds, now);
    }
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
  return c.json({
    cursor: nextCursor,
    changes,
  });
});

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "internal_server_error" }, 500);
});

export { app };
export default app;
