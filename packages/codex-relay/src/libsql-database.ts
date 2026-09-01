import { createClient } from "@libsql/client/node";
import type { InValue, ResultSet, Row } from "@libsql/client/node";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Executor = {
  execute(statement: { sql: string; args: InValue[] }): Promise<ResultSet>;
};

type PreparedStatement = {
  all(...args: InValue[]): Promise<Row[]>;
  get(...args: InValue[]): Promise<Row | undefined>;
  run(...args: InValue[]): Promise<ResultSet>;
};

type QueryableDatabase = {
  prepare(sql: string): PreparedStatement;
};

type Database = QueryableDatabase & {
  close(): void;
  exec(sql: string): Promise<void>;
  transaction<T>(callback: (database: QueryableDatabase) => Promise<T>): () => Promise<T>;
};

export function connect(path: string): Database {
  const client = createClient({
    intMode: "number",
    url: databaseUrl(path),
  });
  let closed = false;
  const lock = createExclusiveLock();
  const executor =
    path === ":memory:"
      ? {
          execute(statement: { sql: string; args: InValue[] }) {
            return lock(() => client.execute(statement));
          },
        }
      : client;
  const database = createQueryableDatabase(executor);

  return {
    ...database,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      client.close();
    },
    exec(sql) {
      return path === ":memory:"
        ? lock(() => client.executeMultiple(sql))
        : client.executeMultiple(sql);
    },
    transaction(callback) {
      if (path === ":memory:") {
        const transactionDatabase = createQueryableDatabase(client);
        return () =>
          lock(async () => {
            await client.execute("BEGIN IMMEDIATE");
            try {
              const result = await callback(transactionDatabase);
              await client.execute("COMMIT");
              return result;
            } catch (error) {
              await client.execute("ROLLBACK");
              throw error;
            }
          });
      }

      return async () => {
        const transaction = await client.transaction("write");
        try {
          const result = await callback(createQueryableDatabase(transaction));
          await transaction.commit();
          return result;
        } finally {
          transaction.close();
        }
      };
    },
  };
}

function databaseUrl(path: string) {
  return path === ":memory:" ? path : pathToFileURL(resolve(path)).href;
}

function createExclusiveLock() {
  let tail = Promise.resolve();

  return async function withLock<T>(callback: () => Promise<T>) {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };
}

function createQueryableDatabase(executor: Executor): QueryableDatabase {
  return {
    prepare(sql) {
      return {
        async all(...args) {
          return (await executor.execute({ sql, args })).rows;
        },
        async get(...args) {
          return (await executor.execute({ sql, args })).rows[0];
        },
        run(...args) {
          return executor.execute({ sql, args });
        },
      };
    },
  };
}
