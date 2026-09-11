import "server-only"

/**
 * Reads Meta (Facebook) Ads and Google Ads API credentials from a SEPARATE
 * Supabase project (the one that stores tokens for our other apps).
 *
 * The operator adds two vars to THIS project:
 *   ADS_SUPABASE_URL         e.g. https://<ref>.supabase.co
 *   ADS_SUPABASE_SERVICE_KEY a service-role (or read-capable) key
 *
 * We don't know the exact table/column layout ahead of time, so this module
 * inspects the PostgREST schema, scans credential-looking tables, and maps the
 * columns to the fields each ad platform needs. Column mapping is deliberately
 * fuzzy (many aliases + nested-JSON support) and can be confirmed/adjusted with
 * `scripts/inspect-ads-creds.mjs` once the Vars exist.
 */

export type MetaCredentials = {
  accessToken: string
  /** digits only; the account is queried as act_<id> */
  adAccountId: string
}

export type GoogleAdsCredentials = {
  developerToken: string
  clientId: string
  clientSecret: string
  refreshToken: string
  /** manager (MCC) account, digits only, optional */
  loginCustomerId?: string
  /** target account the report runs against, digits only */
  customerId: string
}

export type AdsCredentials = {
  configured: boolean
  meta: MetaCredentials | null
  google: GoogleAdsCredentials | null
  /** non-fatal notes about what could / couldn't be resolved */
  notes: string[]
}

const ADS_URL = process.env.ADS_SUPABASE_URL
const ADS_KEY = process.env.ADS_SUPABASE_SERVICE_KEY
// Optional explicit overrides if the fuzzy inference guesses wrong.
const FORCE_TABLE = process.env.ADS_CREDENTIALS_TABLE

const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "")

/** Case-insensitive lookup across a flattened row for the first matching alias. */
function pick(row: Record<string, unknown>, aliases: string[]): string | null {
  const lower: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v
  for (const a of aliases) {
    const v = lower[a.toLowerCase()]
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v)
  }
  return null
}

/** Merge nested JSON columns (jsonb or JSON-string) into the top-level row so pick() can see them. */
function flatten(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const [k, v] of Object.entries(row)) {
    let obj: Record<string, unknown> | null = null
    if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>
    else if (typeof v === "string" && v.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(v)
        if (parsed && typeof parsed === "object") obj = parsed
      } catch {
        /* not JSON */
      }
    }
    if (obj) for (const [ik, iv] of Object.entries(obj)) if (!(ik in out)) out[ik] = iv
  }
  return out
}

async function rest(path: string): Promise<unknown> {
  const res = await fetch(`${ADS_URL}/rest/v1/${path}`, {
    headers: { apikey: ADS_KEY as string, Authorization: `Bearer ${ADS_KEY}` },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`ads-supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/** List table names via the PostgREST OpenAPI document. */
async function listTables(): Promise<string[]> {
  try {
    const spec = (await rest("")) as { definitions?: Record<string, unknown>; paths?: Record<string, unknown> }
    if (spec.definitions) return Object.keys(spec.definitions)
    if (spec.paths) return Object.keys(spec.paths).filter((p) => p.startsWith("/") && p.length > 1).map((p) => p.slice(1))
  } catch {
    /* fall through */
  }
  return []
}

const CANDIDATE_RE = /cred|token|secret|oauth|ads?|meta|google|facebook|fb|integration|connection|api[_-]?key|platform|marketing/i

let cache: AdsCredentials | null = null

export async function getAdsCredentials(): Promise<AdsCredentials> {
  if (cache) return cache
  const notes: string[] = []

  if (!ADS_URL || !ADS_KEY) {
    cache = { configured: false, meta: null, google: null, notes: ["ADS_SUPABASE_URL / ADS_SUPABASE_SERVICE_KEY not set"] }
    return cache
  }

  let tables = FORCE_TABLE ? [FORCE_TABLE] : await listTables()
  if (!FORCE_TABLE) {
    const filtered = tables.filter((t) => CANDIDATE_RE.test(t))
    if (filtered.length) tables = filtered
  }
  if (!tables.length) notes.push("no candidate credential tables found via schema inspection")

  const rows: Record<string, unknown>[] = []
  for (const t of tables) {
    try {
      const data = (await rest(`${encodeURIComponent(t)}?select=*&limit=100`)) as Record<string, unknown>[]
      if (Array.isArray(data)) for (const r of data) rows.push(flatten(r))
    } catch (e) {
      notes.push(`skip table ${t}: ${(e as Error).message}`)
    }
  }

  let meta: MetaCredentials | null = null
  let google: GoogleAdsCredentials | null = null

  for (const row of rows) {
    if (!meta) {
      const accessToken = pick(row, ["meta_access_token", "fb_access_token", "facebook_access_token", "access_token", "token", "page_access_token"])
      const acct = pick(row, ["ad_account_id", "meta_ad_account_id", "account_id", "act_id", "ad_account", "fb_ad_account_id"])
      // Only treat as Meta when it also looks Meta-ish (avoid grabbing a Google row's generic access_token).
      const looksMeta = /meta|facebook|fb|act_|^\d+$/i.test(String(acct ?? "")) || /meta|facebook|fb/i.test(Object.keys(row).join(" "))
      if (accessToken && acct && looksMeta) meta = { accessToken, adAccountId: digits(acct) }
    }
    if (!google) {
      const developerToken = pick(row, ["developer_token", "google_developer_token", "google_ads_developer_token"])
      const refreshToken = pick(row, ["google_refresh_token", "refresh_token", "oauth_refresh_token", "ads_refresh_token"])
      const clientId = pick(row, ["google_client_id", "client_id", "oauth_client_id"])
      const clientSecret = pick(row, ["google_client_secret", "client_secret", "oauth_client_secret"])
      const customerId = pick(row, ["google_customer_id", "customer_id", "ads_customer_id", "google_ads_customer_id"])
      const loginCustomerId = pick(row, ["login_customer_id", "manager_customer_id", "mcc_id", "mcc", "manager_id"])
      if (developerToken && refreshToken && clientId && clientSecret && customerId) {
        google = {
          developerToken,
          clientId,
          clientSecret,
          refreshToken,
          customerId: digits(customerId),
          loginCustomerId: loginCustomerId ? digits(loginCustomerId) : undefined,
        }
      }
    }
  }

  if (!meta) notes.push("Meta credentials not resolved (need access_token + ad_account_id)")
  if (!google) notes.push("Google Ads credentials not resolved (need developer_token + client_id + client_secret + refresh_token + customer_id)")

  cache = { configured: !!(meta || google), meta, google, notes }
  return cache
}

/** Test-only: clear the per-process cache. */
export function __clearAdsCredentialsCache() {
  cache = null
}
