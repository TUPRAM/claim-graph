import { PGlite } from "@electric-sql/pglite";

interface QueryExecutor {
  query<T>(query: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

class DeferredNeonQuery<T = Record<string, unknown>> implements PromiseLike<T[]> {
  private result: Promise<T[]> | null = null;

  constructor(
    private readonly database: PGlite,
    readonly text: string,
    readonly params: unknown[]
  ) {}

  execute(executor: QueryExecutor = this.database) {
    this.result ??= executor
      .query<T>(this.text, this.params)
      .then((result) => result.rows);
    return this.result;
  }

  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export function createPgliteNeonClient(database: PGlite) {
  const query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    new DeferredNeonQuery<T>(database, text, params);

  return {
    query,
    async transaction(queries: Array<DeferredNeonQuery<unknown>>) {
      return database.transaction(async (transaction) => {
        const results: unknown[][] = [];

        for (const pendingQuery of queries) {
          results.push(await pendingQuery.execute(transaction));
        }

        return results;
      });
    }
  };
}
