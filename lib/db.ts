import "server-only"
import postgres from "postgres"

// Singleton Postgres client for the connected Supabase database.
// Uses the non-pooling URL for reliability inside the server runtime, falling
// back to the pooled URL. Reused across hot reloads via globalThis.
declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined
}

function createClient() {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
  if (!url) throw new Error("POSTGRES_URL is not set")
  return postgres(url, { ssl: "require", max: 3, idle_timeout: 20, connect_timeout: 15 })
}

export const sql = globalThis.__sql ?? createClient()
if (process.env.NODE_ENV !== "production") globalThis.__sql = sql
