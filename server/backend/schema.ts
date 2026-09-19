import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  registeredAt: integer("registered_at").notNull(),
  email: text("email").unique(),
  displayName: text("display_name").notNull().default(""),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  passwordIterations: integer("password_iterations"),
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  lastLoginAt: integer("last_login_at"),
  deviceIds: text("device_ids", { mode: "json" }).$type<string[]>().notNull(),
  planId: text("plan_id").notNull().default("free"),
  revision: integer("revision").notNull().default(0),
});

export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind", { enum: ["access", "refresh"] }).notNull(),
    client: text("client", { enum: ["web", "extension"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    replacedBy: text("replaced_by"),
  },
  (table) => ({
    userIdx: index("auth_tokens_user_idx").on(table.userId, table.kind),
    expiryIdx: index("auth_tokens_expiry_idx").on(table.expiresAt),
  }),
);

export const authCodes = sqliteTable("auth_codes", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});

export const adminSessions = sqliteTable("admin_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
});

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  maxBookmarks: integer("max_bookmarks").notNull(),
  maxHistoryEntries: integer("max_history_entries").notNull(),
  maxDevices: integer("max_devices").notNull(),
  operationRetentionDays: integer("operation_retention_days").notNull(),
});

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    url: text("url").notNull(),
    name: text("name").notNull(),
    favicon: text("favicon").notNull(),
    folder: text("folder").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    serverRevision: integer("server_revision").notNull(),
    serverUpdatedAt: integer("server_updated_at").notNull(),
    clientUpdatedAt: integer("client_updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.itemId] }),
    userUrlUnique: uniqueIndex("bookmarks_user_url_unique").on(table.userId, table.url),
    userUpdatedIdx: index("bookmarks_user_updated_idx").on(table.userId, table.serverRevision),
  }),
);

export const historyEntries = sqliteTable(
  "history_entries",
  {
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    favicon: text("favicon").notNull(),
    visitedAt: integer("visited_at").notNull(),
    serverRevision: integer("server_revision").notNull(),
    serverUpdatedAt: integer("server_updated_at").notNull(),
    clientUpdatedAt: integer("client_updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.itemId] }),
    userUpdatedIdx: index("history_entries_user_updated_idx").on(
      table.userId,
      table.serverRevision,
    ),
  }),
);

export const deletionEvents = sqliteTable(
  "deletion_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    kind: text("kind", { enum: ["history", "bookmark"] }).notNull(),
    clientUpdatedAt: integer("client_updated_at").notNull(),
    deviceId: text("device_id").notNull(),
    serverRevision: integer("server_revision").notNull(),
    serverDeletedAt: integer("server_deleted_at").notNull(),
  },
  (table) => ({
    userDeletedIdx: index("deletion_events_user_deleted_idx").on(
      table.userId,
      table.serverRevision,
    ),
    userItemIdx: index("deletion_events_user_item_idx").on(table.userId, table.kind, table.itemId),
  }),
);

export const deletionEventDevices = sqliteTable(
  "deletion_event_devices",
  {
    deletionId: integer("deletion_id").notNull(),
    deviceId: text("device_id").notNull(),
    acknowledgedAt: integer("acknowledged_at"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.deletionId, table.deviceId] }),
    deviceIdx: index("deletion_event_devices_device_idx").on(table.deviceId),
  }),
);

export const syncOperations = sqliteTable(
  "sync_operations",
  {
    userId: text("user_id").notNull(),
    operationId: text("operation_id").notNull(),
    receivedAt: integer("received_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.operationId] }),
    userReceivedIdx: index("sync_operations_user_received_idx").on(
      table.userId,
      table.receivedAt,
    ),
  }),
);

export type User = typeof users.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type AuthToken = typeof authTokens.$inferSelect;
export type Bookmark = typeof bookmarks.$inferSelect;
export type HistoryEntry = typeof historyEntries.$inferSelect;
export type DeletionEvent = typeof deletionEvents.$inferSelect;
