import { describe, expect, mock, test } from "bun:test";
import { createDatabaseConnection } from "../src/database-connection.ts";

function fakeDatabase() {
  let closed = false;
  const tx = {} as IDBTransaction;
  const db = {
    onclose: null as (() => void) | null,
    onversionchange: null as (() => void) | null,
    close: mock(() => {
      closed = true;
    }),
    transaction: mock(() => {
      if (closed) throw new DOMException("Connection is closed", "InvalidStateError");
      return tx;
    }),
  };
  return { db, tx, value: db as unknown as IDBDatabase };
}

describe("database connection recovery", () => {
  test("reuses one connection for concurrent transactions", async () => {
    const first = fakeDatabase();
    const open = mock(async () => first.value);
    const connection = createDatabaseConnection(open);

    const results = await Promise.all([
      connection.transaction("visits", "readonly"),
      connection.transaction(["visits", "sync_outbox"], "readwrite"),
    ]);

    expect(results).toEqual([first.tx, first.tx]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(first.db.transaction).toHaveBeenNthCalledWith(1, "visits", "readonly");
    expect(first.db.transaction).toHaveBeenNthCalledWith(2, ["visits", "sync_outbox"], "readwrite");
  });

  test("reopens after an unexpected close while idle", async () => {
    const first = fakeDatabase();
    const second = fakeDatabase();
    const open = mock(async () => first.value)
      .mockResolvedValueOnce(first.value)
      .mockResolvedValue(second.value);
    const connection = createDatabaseConnection(open);

    await connection.transaction("visits", "readwrite");
    first.db.close();
    first.db.onclose?.();

    expect(await connection.transaction("visits", "readwrite")).toBe(second.tx);
    expect(open).toHaveBeenCalledTimes(2);
  });

  test("retries the same transaction when close has not been reported yet", async () => {
    const first = fakeDatabase();
    const second = fakeDatabase();
    const open = mock(async () => first.value)
      .mockResolvedValueOnce(first.value)
      .mockResolvedValue(second.value);
    const connection = createDatabaseConnection(open);

    await connection.transaction("visits", "readonly");
    first.db.close();

    expect(await connection.transaction(["visits", "sync_outbox"], "readwrite")).toBe(second.tx);
    expect(open).toHaveBeenCalledTimes(2);
    expect(second.db.transaction).toHaveBeenCalledWith(["visits", "sync_outbox"], "readwrite");
  });

  test("concurrent failures share the replacement connection", async () => {
    const first = fakeDatabase();
    const second = fakeDatabase();
    const open = mock(async () => first.value)
      .mockResolvedValueOnce(first.value)
      .mockResolvedValue(second.value);
    const connection = createDatabaseConnection(open);

    await connection.transaction("visits", "readonly");
    first.db.close();

    expect(
      await Promise.all([
        connection.transaction("visits", "readwrite"),
        connection.transaction("bookmarks", "readonly"),
      ]),
    ).toEqual([second.tx, second.tx]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  test("delayed events from the old connection do not evict its replacement", async () => {
    const first = fakeDatabase();
    const second = fakeDatabase();
    const open = mock(async () => first.value)
      .mockResolvedValueOnce(first.value)
      .mockResolvedValue(second.value);
    const connection = createDatabaseConnection(open);

    await connection.transaction("visits", "readonly");
    first.db.close();
    await connection.transaction("visits", "readwrite");
    first.db.onclose?.();
    first.db.onversionchange?.();

    expect(await connection.transaction("visits", "readwrite")).toBe(second.tx);
    expect(open).toHaveBeenCalledTimes(2);
  });

  test("closes and reopens on a version change", async () => {
    const first = fakeDatabase();
    const second = fakeDatabase();
    const open = mock(async () => first.value)
      .mockResolvedValueOnce(first.value)
      .mockResolvedValue(second.value);
    const connection = createDatabaseConnection(open);

    await connection.transaction("visits", "readonly");
    first.db.onversionchange?.();

    expect(first.db.close).toHaveBeenCalledTimes(1);
    expect(await connection.transaction("visits", "readonly")).toBe(second.tx);
  });

  test("does not cache a failed open", async () => {
    const first = fakeDatabase();
    const error = new DOMException("Unavailable", "UnknownError");
    const open = mock(async () => first.value).mockRejectedValueOnce(error);
    const connection = createDatabaseConnection(open);

    await expect(connection.transaction("visits", "readonly")).rejects.toBe(error);
    expect(await connection.transaction("visits", "readonly")).toBe(first.tx);
    expect(open).toHaveBeenCalledTimes(2);
  });

  test("does not retry unrelated transaction errors", async () => {
    const first = fakeDatabase();
    const error = new DOMException("Missing store", "NotFoundError");
    first.db.transaction.mockImplementation(() => {
      throw error;
    });
    const open = mock(async () => first.value);
    const connection = createDatabaseConnection(open);

    await expect(connection.transaction("visits", "readonly")).rejects.toBe(error);
    expect(open).toHaveBeenCalledTimes(1);
    expect(first.db.close).not.toHaveBeenCalled();
  });

  test("limits retries and allows the next event to open a fresh connection", async () => {
    const first = fakeDatabase();
    const second = fakeDatabase();
    const third = fakeDatabase();
    first.db.close();
    second.db.close();
    const open = mock(async () => third.value)
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value);
    const connection = createDatabaseConnection(open);

    await expect(connection.transaction("visits", "readwrite")).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(await connection.transaction("visits", "readwrite")).toBe(third.tx);
  });

  test("explicit close clears the cache without needing a close event", async () => {
    const first = fakeDatabase();
    const second = fakeDatabase();
    const open = mock(async () => first.value)
      .mockResolvedValueOnce(first.value)
      .mockResolvedValue(second.value);
    const connection = createDatabaseConnection(open);

    await connection.transaction("visits", "readonly");
    await connection.close();

    expect(first.db.close).toHaveBeenCalledTimes(1);
    expect(await connection.transaction("visits", "readonly")).toBe(second.tx);
  });
});
