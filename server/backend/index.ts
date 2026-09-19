import { cors } from "hono/cors";
import { Hono } from "hono";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  ACCESS_TOKEN_TTL,
  ADMIN_SESSION_TTL,
  AUTH_CODE_TTL,
  PASSWORD_ITERATIONS,
  REFRESH_TOKEN_TTL,
  clearedCookie,
  cookie,
  equalStrings,
  hashPassword,
  parseCookies,
  randomToken,
  sha256Base64Url,
  sha256Hex,
  validEmail,
  validExtensionRedirect,
  validPassword,
  verifyPassword,
} from "./auth.ts";
import {
  adminSessions,
  authCodes,
  authTokens,
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
  ADMIN_PASSWORD_SALT?: string;
  ADMIN_PASSWORD_SHA256?: string;
}

type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    adminAuthenticated?: boolean;
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
  readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503;
  readonly code: string;

  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
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

type TokenClient = "web" | "extension";

const ACCESS_COOKIE = "mugen_access";
const REFRESH_COOKIE = "mugen_refresh";
const ADMIN_COOKIE = "mugen_admin_session";

function isSecureRequest(url: string): boolean {
  return new URL(url).protocol === "https:";
}

function responseUser(user: typeof users.$inferSelect, plan: typeof plans.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    plan: {
      id: plan.id,
      maxBookmarks: plan.maxBookmarks,
      maxHistoryEntries: plan.maxHistoryEntries,
      maxDevices: plan.maxDevices,
    },
    deviceCount: user.deviceIds.length,
    registeredAt: user.registeredAt,
    lastLoginAt: user.lastLoginAt,
  };
}

async function issueTokens(
  db: DatabaseExecutor,
  userId: string,
  client: TokenClient,
  now: number,
): Promise<{ accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const accessExpiresAt = now + ACCESS_TOKEN_TTL;
  const refreshExpiresAt = now + REFRESH_TOKEN_TTL;
  await db.insert(authTokens).values([
    {
      id: randomToken(16),
      userId,
      tokenHash: await sha256Hex(accessToken),
      kind: "access",
      client,
      createdAt: now,
      expiresAt: accessExpiresAt,
    },
    {
      id: randomToken(16),
      userId,
      tokenHash: await sha256Hex(refreshToken),
      kind: "refresh",
      client,
      createdAt: now,
      expiresAt: refreshExpiresAt,
    },
  ]).run();
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

async function userForAccessToken(db: DatabaseExecutor, token: string, now = Date.now()) {
  const tokenHash = await sha256Hex(token);
  const tokenRow = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.kind, "access")))
    .limit(1)
    .get();
  if (!tokenRow || tokenRow.revokedAt !== null || tokenRow.expiresAt <= now) return undefined;
  const user = await db.select().from(users).where(eq(users.id, tokenRow.userId)).limit(1).get();
  if (!user || user.status !== "active") return undefined;
  const plan = await getPlan(db, user.planId || DEFAULT_PLAN_ID);
  return { token: tokenRow, user, plan };
}

async function userForRefreshToken(db: DatabaseExecutor, token: string, now = Date.now()) {
  const tokenHash = await sha256Hex(token);
  const tokenRow = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, tokenHash), eq(authTokens.kind, "refresh")))
    .limit(1)
    .get();
  if (!tokenRow || tokenRow.revokedAt !== null || tokenRow.expiresAt <= now) return undefined;
  const user = await db.select().from(users).where(eq(users.id, tokenRow.userId)).limit(1).get();
  if (!user || user.status !== "active") return undefined;
  const plan = await getPlan(db, user.planId || DEFAULT_PLAN_ID);
  return { token: tokenRow, user, plan };
}

function bearerOrCookie(c: { req: { header(name: string): string | undefined; raw: Request } }): string | undefined {
  const authorization = c.req.header("Authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (match) return match[1];
  return parseCookies(c.req.header("Cookie"))[ACCESS_COOKIE];
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

async function requestJson(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | undefined> {
  try {
    return jsonObject(await c.req.json());
  } catch {
    return undefined;
  }
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
  const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1).get();
  if (!existing || existing.status !== "active") throw new ApiError(401, "unauthorized", "Account is not active");

  const plan = await getPlan(db, existing.planId || DEFAULT_PLAN_ID);

  const deviceIds = Array.isArray(existing.deviceIds) ? existing.deviceIds : [];
  if (!deviceIds.includes(deviceId)) {
    if (isLimited(plan.maxDevices) && deviceIds.length >= plan.maxDevices) {
      throw new ApiError(409, "device_limit_reached", "同時利用できるデバイス数の上限に達しています");
    }
    deviceIds.push(deviceId);
    await db.update(users).set({ deviceIds }).where(eq(users.id, userId)).run();
    return { user: { ...existing, deviceIds }, plan };
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
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    credentials: true,
    maxAge: 86_400,
  })(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

async function authenticatedUser(c: any, next: () => Promise<Response | void>): Promise<Response | void> {
  if (c.req.method === "OPTIONS") return next();
  const token = bearerOrCookie(c);
  if (!token || token.length > 512) return c.json({ error: "unauthorized" }, 401);
  const account = await userForAccessToken(drizzle(c.env.DB), token);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", account.user.id);
  return next();
}

async function authenticatedAdmin(c: any, next: () => Promise<Response | void>): Promise<Response | void> {
  if (c.req.method === "OPTIONS") return next();
  const raw = parseCookies(c.req.header("Cookie"))[ADMIN_COOKIE];
  if (!raw) return c.json({ error: "admin_unauthorized" }, 401);
  const session = await drizzle(c.env.DB)
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.tokenHash, await sha256Hex(raw)))
    .limit(1)
    .get();
  if (!session || session.revokedAt !== null || session.expiresAt <= Date.now()) {
    return c.json({ error: "admin_unauthorized" }, 401);
  }
  c.set("adminAuthenticated", true);
  return next();
}

function authCookies(c: any, tokens: { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }) {
  const secure = isSecureRequest(c.req.url);
  c.header("Set-Cookie", cookie(ACCESS_COOKIE, tokens.accessToken, Math.ceil((tokens.accessExpiresAt - Date.now()) / 1_000), secure));
  c.header("Set-Cookie", cookie(REFRESH_COOKIE, tokens.refreshToken, Math.ceil((tokens.refreshExpiresAt - Date.now()) / 1_000), secure), { append: true });
}

app.post("/v1/auth/login", async (c) => {
  const body = await requestJson(c);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = body?.password;
  const client: TokenClient = body?.client === "extension" ? "extension" : "web";
  if (!validEmail(email) || !validPassword(password)) return c.json({ error: "invalid_credentials" }, 401);
  const db = drizzle(c.env.DB);
  const user = await db.select().from(users).where(eq(users.email, email)).limit(1).get();
  if (!user || user.status !== "active" || !user.passwordHash || !user.passwordSalt || !user.passwordIterations || !(await verifyPassword(password, user.passwordHash, user.passwordSalt, user.passwordIterations))) {
    logEvent("auth_rejected", { route: "/v1/auth/login", reason: "invalid_credentials" });
    return c.json({ error: "invalid_credentials" }, 401);
  }
  const now = Date.now();
  const tokens = await issueTokens(db, user.id, client, now);
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)).run();
  const plan = await getPlan(db, user.planId || DEFAULT_PLAN_ID);
  if (client === "web") {
    authCookies(c, tokens);
    return c.json({ user: responseUser({ ...user, lastLoginAt: now }, plan) });
  }
  return c.json({ user: responseUser({ ...user, lastLoginAt: now }, plan), ...tokens });
});

app.post("/v1/auth/refresh", async (c) => {
  const body = await requestJson(c);
  const cookies = parseCookies(c.req.header("Cookie"));
  const raw = typeof body?.refreshToken === "string" ? body.refreshToken : cookies[REFRESH_COOKIE];
  if (!raw) return c.json({ error: "unauthorized" }, 401);
  const db = drizzle(c.env.DB);
  const account = await userForRefreshToken(db, raw);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const now = Date.now();
  await db.update(authTokens).set({ revokedAt: now }).where(eq(authTokens.id, account.token.id)).run();
  const client: TokenClient = body?.client === "extension" ? "extension" : account.token.client;
  const tokens = await issueTokens(db, account.user.id, client, now);
  await db.update(authTokens).set({ replacedBy: await sha256Hex(tokens.refreshToken) }).where(eq(authTokens.id, account.token.id)).run();
  if (client === "web") {
    authCookies(c, tokens);
    return c.json({ user: responseUser(account.user, account.plan), ...tokens });
  }
  return c.json({ user: responseUser(account.user, account.plan), ...tokens });
});

app.post("/v1/auth/logout", async (c) => {
  const db = drizzle(c.env.DB);
  const cookies = parseCookies(c.req.header("Cookie"));
  const values = [bearerOrCookie(c), cookies[REFRESH_COOKIE]].filter((value): value is string => Boolean(value));
  const now = Date.now();
  for (const value of values) await db.update(authTokens).set({ revokedAt: now }).where(eq(authTokens.tokenHash, await sha256Hex(value))).run();
  const secure = isSecureRequest(c.req.url);
  c.header("Set-Cookie", clearedCookie(ACCESS_COOKIE, secure));
  c.header("Set-Cookie", clearedCookie(REFRESH_COOKIE, secure), { append: true });
  return c.json({ ok: true });
});

app.use("/v1/auth/me", authenticatedUser);
app.get("/v1/auth/me", async (c) => {
  const db = drizzle(c.env.DB);
  const account = await userForAccessToken(db, bearerOrCookie(c)!);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  return c.json({ user: responseUser(account.user, account.plan) });
});

app.use("/v1/account", authenticatedUser);
app.get("/v1/account/overview", async (c) => {
  const userId = c.get("userId");
  const db = drizzle(c.env.DB);
  const [bookmarksCount, historyCount] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(bookmarks).where(eq(bookmarks.userId, userId)).get(),
    db.select({ count: sql<number>`count(*)` }).from(historyEntries).where(eq(historyEntries.userId, userId)).get(),
  ]);
  return c.json({ bookmarkCount: bookmarksCount?.count ?? 0, historyCount: historyCount?.count ?? 0 });
});
app.patch("/v1/account", async (c) => {
  const body = await requestJson(c);
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : undefined;
  if (displayName !== undefined && (displayName.length < 1 || displayName.length > 100)) return c.json({ error: "invalid_display_name" }, 400);
  if (email !== undefined && !validEmail(email)) return c.json({ error: "invalid_email" }, 400);
  const db = drizzle(c.env.DB);
  if (email) {
    const duplicate = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1).get();
    if (duplicate && duplicate.id !== userId) return c.json({ error: "email_already_exists" }, 409);
  }
  await db.update(users).set({ ...(displayName === undefined ? {} : { displayName }), ...(email === undefined ? {} : { email }) }).where(eq(users.id, userId)).run();
  const account = await db.select().from(users).where(eq(users.id, userId)).limit(1).get();
  if (!account) return c.json({ error: "unauthorized" }, 401);
  return c.json({ user: responseUser(account, await getPlan(db, account.planId || DEFAULT_PLAN_ID)) });
});

app.get("/auth/authorize", (c) => {
  const clientId = c.req.query("client_id");
  const redirectUri = c.req.query("redirect_uri");
  const codeChallenge = c.req.query("code_challenge");
  const state = c.req.query("state");
  if (clientId !== "extension" || !validExtensionRedirect(redirectUri) || !codeChallenge || !state || state.length > 256) return c.json({ error: "invalid_authorize_request" }, 400);
  const params = new URLSearchParams({ authorize: "1", client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, state });
  return c.redirect(`/?${params.toString()}`);
});

app.use("/v1/auth/authorize/approve", authenticatedUser);
app.post("/v1/auth/authorize/approve", async (c) => {
  const body = await requestJson(c);
  const userId = c.get("userId");
  const redirectUri = body?.redirectUri;
  const codeChallenge = body?.codeChallenge;
  const clientId = body?.clientId;
  const state = typeof body?.state === "string" ? body.state : "";
  if (!userId || clientId !== "extension" || !validExtensionRedirect(redirectUri) || typeof codeChallenge !== "string" || codeChallenge.length < 43 || state.length > 256) return c.json({ error: "invalid_authorize_request" }, 400);
  const code = randomToken(32);
  const now = Date.now();
  await drizzle(c.env.DB).insert(authCodes).values({ id: randomToken(16), codeHash: await sha256Hex(code), userId, clientId, redirectUri, codeChallenge, createdAt: now, expiresAt: now + AUTH_CODE_TTL }).run();
  return c.json({ redirect: `${redirectUri}?${new URLSearchParams({ code, state }).toString()}` });
});

app.post("/v1/auth/token", async (c) => {
  const body = await requestJson(c);
  const code = body?.code;
  const verifier = body?.codeVerifier;
  const clientId = body?.clientId;
  const redirectUri = body?.redirectUri;
  if (typeof code !== "string" || typeof verifier !== "string" || clientId !== "extension" || !validExtensionRedirect(redirectUri)) return c.json({ error: "invalid_grant" }, 400);
  const db = drizzle(c.env.DB);
  const authCode = await db.select().from(authCodes).where(eq(authCodes.codeHash, await sha256Hex(code))).limit(1).get();
  if (!authCode || authCode.clientId !== clientId || authCode.redirectUri !== redirectUri || authCode.consumedAt !== null || authCode.expiresAt <= Date.now() || !equalStrings(authCode.codeChallenge, await sha256Base64Url(verifier))) return c.json({ error: "invalid_grant" }, 400);
  const consumed = await db.update(authCodes).set({ consumedAt: Date.now() }).where(and(eq(authCodes.id, authCode.id), isNull(authCodes.consumedAt))).run();
  if (consumed.meta.changes === 0) return c.json({ error: "invalid_grant" }, 400);
  const user = await db.select().from(users).where(eq(users.id, authCode.userId)).limit(1).get();
  if (!user || user.status !== "active") return c.json({ error: "unauthorized" }, 401);
  const plan = await getPlan(db, user.planId || DEFAULT_PLAN_ID);
  return c.json({ user: responseUser(user, plan), ...(await issueTokens(db, user.id, "extension", Date.now())) });
});

app.post("/v1/admin/login", async (c) => {
  const body = await requestJson(c);
  const password = body?.password;
  const salt = c.env.ADMIN_PASSWORD_SALT;
  const expected = c.env.ADMIN_PASSWORD_SHA256;
  if (typeof password !== "string" || !salt || !expected || !equalStrings(expected, await sha256Hex(`${password}${salt}`))) {
    logEvent("admin_auth_rejected", { reason: "invalid_credentials" });
    return c.json({ error: "invalid_credentials" }, 401);
  }
  const raw = randomToken();
  const now = Date.now();
  await drizzle(c.env.DB).insert(adminSessions).values({ id: randomToken(16), tokenHash: await sha256Hex(raw), createdAt: now, expiresAt: now + ADMIN_SESSION_TTL }).run();
  c.header("Set-Cookie", cookie(ADMIN_COOKIE, raw, ADMIN_SESSION_TTL / 1_000, isSecureRequest(c.req.url), "Strict"));
  return c.json({ admin: true, expiresAt: now + ADMIN_SESSION_TTL });
});

app.use("/v1/admin/me", authenticatedAdmin);
app.get("/v1/admin/me", (c) => c.json({ admin: true }));

app.post("/v1/admin/logout", async (c) => {
  const raw = parseCookies(c.req.header("Cookie"))[ADMIN_COOKIE];
  if (raw) await drizzle(c.env.DB).update(adminSessions).set({ revokedAt: Date.now() }).where(eq(adminSessions.tokenHash, await sha256Hex(raw))).run();
  c.header("Set-Cookie", clearedCookie(ADMIN_COOKIE, isSecureRequest(c.req.url)));
  return c.json({ ok: true });
});

app.use("/v1/admin/overview", authenticatedAdmin);
app.get("/v1/admin/overview", async (c) => {
  const db = drizzle(c.env.DB);
  const usersCount = await db.select({ count: sql<number>`count(*)` }).from(users).get();
  const activeUsers = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.status, "active")).get();
  const devices = await db.select().from(users).all();
  const activeTokens = await db.select({ count: sql<number>`count(*)` }).from(authTokens).where(and(eq(authTokens.kind, "access"), isNull(authTokens.revokedAt), gt(authTokens.expiresAt, Date.now()))).get();
  return c.json({ users: usersCount?.count ?? 0, activeUsers: activeUsers?.count ?? 0, devices: devices.reduce((total, user) => total + user.deviceIds.length, 0), activeSessions: activeTokens?.count ?? 0 });
});

app.use("/v1/admin/users", authenticatedAdmin);
app.get("/v1/admin/users", async (c) => {
  const db = drizzle(c.env.DB);
  const query = c.req.query("query")?.trim().toLowerCase();
  const rows = await db.select().from(users).orderBy(desc(users.registeredAt)).limit(500).all();
  const filtered = query ? rows.filter((user) => user.email?.toLowerCase().includes(query) || user.displayName.toLowerCase().includes(query) || user.id.includes(query)) : rows;
  return c.json({ users: filtered.map((user) => ({ id: user.id, email: user.email, displayName: user.displayName, planId: user.planId, status: user.status, deviceCount: user.deviceIds.length, registeredAt: user.registeredAt, lastLoginAt: user.lastLoginAt })) });
});

app.post("/v1/admin/users", async (c) => {
  const body = await requestJson(c);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const password = body?.password;
  const planId = typeof body?.planId === "string" ? body.planId : DEFAULT_PLAN_ID;
  if (!validEmail(email) || displayName.length < 1 || displayName.length > 100 || !validPassword(password)) return c.json({ error: "invalid_user" }, 400);
  const db = drizzle(c.env.DB);
  const [duplicate, plan] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1).get(),
    db.select().from(plans).where(eq(plans.id, planId)).limit(1).get(),
  ]);
  if (duplicate) return c.json({ error: "email_already_exists" }, 409);
  if (!plan) return c.json({ error: "invalid_plan" }, 400);
  const salt = randomToken(16);
  const now = Date.now();
  const id = randomToken(16);
  await db.insert(users).values({ id, registeredAt: now, email, displayName, passwordHash: await hashPassword(password, salt), passwordSalt: salt, passwordIterations: PASSWORD_ITERATIONS, status: "active", deviceIds: [], planId, revision: 0 }).run();
  const user = await db.select().from(users).where(eq(users.id, id)).limit(1).get();
  return c.json({ user: user ? responseUser(user, plan) : undefined }, 201);
});

app.patch("/v1/admin/users/:id", async (c) => {
  const id = c.req.param("id");
  const body = await requestJson(c);
  const db = drizzle(c.env.DB);
  const existing = await db.select().from(users).where(eq(users.id, id)).limit(1).get();
  if (!existing) return c.json({ error: "user_not_found" }, 404);
  const planId = typeof body?.planId === "string" ? body.planId : undefined;
  const status = body?.status === "active" || body?.status === "disabled" ? body.status : undefined;
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : undefined;
  if (planId && !(await db.select({ id: plans.id }).from(plans).where(eq(plans.id, planId)).limit(1).get())) return c.json({ error: "invalid_plan" }, 400);
  if (displayName !== undefined && (displayName.length < 1 || displayName.length > 100)) return c.json({ error: "invalid_display_name" }, 400);
  await db.update(users).set({ ...(planId ? { planId } : {}), ...(status ? { status } : {}), ...(displayName === undefined ? {} : { displayName }) }).where(eq(users.id, id)).run();
  if (status === "disabled") await db.update(authTokens).set({ revokedAt: Date.now() }).where(and(eq(authTokens.userId, id), isNull(authTokens.revokedAt))).run();
  const updated = await db.select().from(users).where(eq(users.id, id)).limit(1).get();
  if (!updated) return c.json({ error: "user_not_found" }, 404);
  return c.json({ user: responseUser(updated, await getPlan(db, updated.planId || DEFAULT_PLAN_ID)) });
});

app.post("/v1/admin/users/:id/password-reset", async (c) => {
  const id = c.req.param("id");
  const body = await requestJson(c);
  const password = body?.password;
  if (!validPassword(password)) return c.json({ error: "invalid_password" }, 400);
  const db = drizzle(c.env.DB);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1).get();
  if (!existing) return c.json({ error: "user_not_found" }, 404);
  const salt = randomToken(16);
  await db.update(users).set({ passwordHash: await hashPassword(password, salt), passwordSalt: salt, passwordIterations: PASSWORD_ITERATIONS }).where(eq(users.id, id)).run();
  await db.update(authTokens).set({ revokedAt: Date.now() }).where(and(eq(authTokens.userId, id), isNull(authTokens.revokedAt))).run();
  return c.json({ ok: true });
});

app.use("/v1/sync", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const token = bearerOrCookie(c);
  const account = token ? await userForAccessToken(drizzle(c.env.DB), token) : undefined;
  if (!account) {
    logEvent("auth_rejected", { route: "/v1/sync", reason: "invalid_bearer" });
    return c.json({ error: "unauthorized" }, 401);
  }
  const limited = await c.env.SYNC_RATE_LIMITER.limit({ key: account.user.id });
  if (!limited.success) {
    logEvent("rate_limited", { route: "/v1/sync", userIdPrefix: account.user.id.slice(0, 12) });
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
  }
  c.set("userId", account.user.id);
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
