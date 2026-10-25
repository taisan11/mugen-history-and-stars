/** Reuse a connection, but recover when the browser closes it while idle. */
export function createDatabaseConnection(openDatabase: () => Promise<IDBDatabase>) {
  let connection: Promise<IDBDatabase> | undefined;

  function invalidate(current: Promise<IDBDatabase>): void {
    // A delayed event from an old connection must not discard its replacement.
    if (connection === current) connection = undefined;
  }

  function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    const current = openDatabase().then(
      (db) => {
        db.onclose = () => invalidate(current);
        db.onversionchange = () => {
          db.close();
          invalidate(current);
        };
        return db;
      },
      (error: unknown) => {
        invalidate(current);
        throw error;
      },
    );
    connection = current;
    return current;
  }

  async function transaction(
    stores: string | string[],
    mode: IDBTransactionMode,
  ): Promise<IDBTransaction> {
    for (let attempt = 0; ; attempt++) {
      const current = open();
      const db = await current;
      try {
        return db.transaction(stores, mode);
      } catch (error: unknown) {
        if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
        invalidate(current);
        db.close();
        // Only retry transaction creation: no writes have started yet, so a
        // reconnect cannot duplicate a visit or replay a partially applied sync.
        if (attempt > 0) throw error;
      }
    }
  }

  async function close(): Promise<void> {
    const current = connection;
    connection = undefined;
    const db = await current?.catch(() => undefined);
    db?.close();
  }

  return { transaction, close };
}
