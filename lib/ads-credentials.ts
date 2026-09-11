import "server-only"

/**
 * Reads Meta (Facebook) Ads and Google Ads API credentials directly from this
 * project's environment variables, per the "Meta & Google Account Access —
 * Vercel Handoff" doc (2026-09-11).
 *
 * The non-secret account IDs from the handoff are baked in as defaults, so the
 * operator only has to add the actual SECRETS to Settings → Vars:
 *
 *   Meta:    META_ACCESS_TOKEN            (required — system-user token)
 *            META_AD_ACCOUNT_ID           (default 100233233849429)
 *            META_BUSINESS_ID             (optional, default 116841965668342)
 *            META_PIXEL_ID                (optional)
 *            META_API_VERSION             (default v22.0)
 *
 *   Google:  GOOGLE_ADS_DEVELOPER_TOKEN   (required)
 *            GOOGLE_ADS_CLIENT_ID         (required)
 *            GOOGLE_ADS_CLIENT_SECRET     (required)
 *            GOOGLE_ADS_REFRESH_TOKEN     (required)
 *            GOOGLE_ADS_CUSTOMER_ID       (default 5685999331)
 *            GOOGLE_ADS_LOGIN_CUSTOMER_ID (optional — MCC, unset for self-managed)
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

// Non-secret account IDs from the handoff, overridable via env.
const DEFAULT_META_AD_ACCOUNT_ID = "100233233849429"
const DEFAULT_GOOGLE_CUSTOMER_ID = "5685999331"

const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "")
const env = (k: string) => {
  const v = process.env[k]
  return v && v.trim() !== "" ? v.trim() : undefined
}

let cache: AdsCredentials | null = null

export async function getAdsCredentials(): Promise<AdsCredentials> {
  if (cache) return cache
  const notes: string[] = []

  // ── Meta ──
  let meta: MetaCredentials | null = null
  const metaToken = env("META_ACCESS_TOKEN")
  if (metaToken) {
    meta = { accessToken: metaToken, adAccountId: digits(env("META_AD_ACCOUNT_ID") ?? DEFAULT_META_AD_ACCOUNT_ID) }
  } else {
    notes.push("Meta not configured — set META_ACCESS_TOKEN (system-user token with ads_read).")
  }

  // ── Google Ads ──
  let google: GoogleAdsCredentials | null = null
  const developerToken = env("GOOGLE_ADS_DEVELOPER_TOKEN")
  const clientId = env("GOOGLE_ADS_CLIENT_ID")
  const clientSecret = env("GOOGLE_ADS_CLIENT_SECRET")
  const refreshToken = env("GOOGLE_ADS_REFRESH_TOKEN")
  if (developerToken && clientId && clientSecret && refreshToken) {
    const loginCustomerId = env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")
    google = {
      developerToken,
      clientId,
      clientSecret,
      refreshToken,
      customerId: digits(env("GOOGLE_ADS_CUSTOMER_ID") ?? DEFAULT_GOOGLE_CUSTOMER_ID),
      loginCustomerId: loginCustomerId ? digits(loginCustomerId) : undefined,
    }
  } else {
    const missing = [
      !developerToken && "GOOGLE_ADS_DEVELOPER_TOKEN",
      !clientId && "GOOGLE_ADS_CLIENT_ID",
      !clientSecret && "GOOGLE_ADS_CLIENT_SECRET",
      !refreshToken && "GOOGLE_ADS_REFRESH_TOKEN",
    ].filter(Boolean)
    notes.push(`Google Ads not configured — missing ${missing.join(", ")}.`)
  }

  cache = { configured: !!(meta || google), meta, google, notes }
  return cache
}

/** Test-only: clear the per-process cache. */
export function __clearAdsCredentialsCache() {
  cache = null
}
