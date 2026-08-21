import type { Sql } from "postgres";

export interface TenantScopedPostgresRepository {
  transaction<T>(tenantId: string, operation: (sql: Sql) => Promise<T>): Promise<T>;
}

/** Runs one private repository operation in a transaction with a transaction-local RLS tenant. */
export function createTenantScopedPostgresRepository(sql: Sql): TenantScopedPostgresRepository {
  return {
    async transaction<T>(tenantId: string, operation: (transactionSql: Sql) => Promise<T>) {
      if (tenantId.length === 0) throw new Error("A tenant id is required for private SQL");
      const result = await sql.begin(async (transactionSql) => {
        await transactionSql`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return { value: await operation(transactionSql) };
      });
      return result.value;
    },
  };
}
