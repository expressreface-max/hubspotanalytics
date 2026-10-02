import "server-only"
import type { GoogleAdsCredentials, MetaCredentials } from "@/lib/ads-credentials"

/** Raw additive metrics for a single campaign-day. */
export type BaseMetrics = { conversions: number; cost: number; impressions: number; clicks: number }

/** BaseMetrics + the derived ratios for a window. Ratios are null when the denominator is 0. */
export type WindowMetrics = BaseMetrics & {
  costPerConv: number | null
  cpm: number | null
  cpc: number | null
  convPerClick: number | null
}

export type Platform = "meta" | "google"

/** A campaign's daily series over the fetch range. */
export type CampaignDaily = {
  platform: Platform
  campaignId: string
  name: string
  /** date 'YYYY-MM-DD' -> additive metrics for that day */
  byDate: Record<string, BaseMetrics>
}

export const WINDOW_KEYS = ["yesterday", "last7", "last30", "last60", "last90"] as const
export type WindowKey = (typeof WINDOW_KEYS)[number]
export const WINDOW_DAYS: Record<WindowKey, number> = { yesterday: 1, last7: 7, last30: 30, last60: 60, last90: 90 }

const pad = (n: number) => String(n).padStart(2, "0")
export function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/**
 * Window date ranges, all ending YESTERDAY (today is excluded as an incomplete day).
 * yesterday = [D-1, D-1]; last7 = [D-7, D-1]; … last90 = [D-90, D-1].
 */
export function windowRanges(now = new Date()): Record<WindowKey, { from: string; to: string }> {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  end.setUTCDate(end.getUTCDate() - 1) // yesterday
  const to = ymd(end)
  const ranges = {} as Record<WindowKey, { from: string; to: string }>
  for (const k of WINDOW_KEYS) {
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS[k] - 1))
    ranges[k] = { from: ymd(start), to }
  }
  return ranges
}

/** Overall fetch span: the widest window (last 90 days), ending yesterday. */
export function fetchRange(now = new Date()): { from: string; to: string } {
  return windowRanges(now).last90
}

export function emptyBase(): BaseMetrics {
  return { conversions: 0, cost: 0, impressions: 0, clicks: 0 }
}

function addInto(acc: BaseMetrics, d: BaseMetrics) {
  acc.conversions += d.conversions
  acc.cost += d.cost
  acc.impressions += d.impressions
  acc.clicks += d.clicks
}

/** Compute the 4 derived ratios from summed base metrics, guarding divide-by-zero. */
export function withRatios(b: BaseMetrics): WindowMetrics {
  return {
    ...b,
    costPerConv: b.conversions > 0 ? b.cost / b.conversions : null,
    cpm: b.impressions > 0 ? (b.cost / b.impressions) * 1000 : null,
    cpc: b.clicks > 0 ? b.cost / b.clicks : null,
    convPerClick: b.clicks > 0 ? b.conversions / b.clicks : null,
  }
}

/** Sum a campaign's daily series into each window. */
export function buildWindows(byDate: Record<string, BaseMetrics>, now = new Date()): Record<WindowKey, WindowMetrics> {
  const ranges = windowRanges(now)
  const out = {} as Record<WindowKey, WindowMetrics>
  for (const k of WINDOW_KEYS) {
    const { from, to } = ranges[k]
    const acc = emptyBase()
    for (const [date, m] of Object.entries(byDate)) {
      if (date >= from && date <= to) addInto(acc, m)
    }
    out[k] = withRatios(acc)
  }
  return out
}

// ─────────────────────────────────────────────────────────── Meta (Facebook) ──

const META_API_VERSION = process.env.META_API_VERSION || "v22.0"

/**
 * Which Meta action_types count as a conversion. Meta returns many overlapping
 * action rows; we default to pixel/offsite conversions + leads. Override with a
 * comma-separated `META_CONVERSION_ACTIONS` env (exact action_type match) once we
 * see the account's live action types.
 */
function metaConversionsFromActions(actions: { action_type: string; value: string }[] | undefined): number {
  if (!Array.isArray(actions)) return 0
  const override = (process.env.META_CONVERSION_ACTIONS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  let sum = 0
  for (const a of actions) {
    const t = (a.action_type || "").toLowerCase()
    const match = override.length
      ? override.includes(t)
      : t.startsWith("offsite_conversion.fb_pixel_") ||
        t === "lead" ||
        t === "purchase" ||
        t === "complete_registration" ||
        t === "submit_application" ||
        t.startsWith("onsite_conversion.")
    if (match) sum += Number(a.value) || 0
  }
  return sum
}

type MetaInsightRow = {
  campaign_id: string
  campaign_name: string
  date_start: string
  spend?: string
  impressions?: string
  clicks?: string
  actions?: { action_type: string; value: string }[]
}

export async function fetchMetaDaily(creds: MetaCredentials, from: string, to: string): Promise<CampaignDaily[]> {
  const base = `https://graph.facebook.com/${META_API_VERSION}/act_${creds.adAccountId}/insights`
  const params = new URLSearchParams({
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since: from, until: to }),
    fields: "campaign_id,campaign_name,spend,impressions,clicks,actions",
    limit: "500",
    access_token: creds.accessToken,
  })
  let url: string | null = `${base}?${params.toString()}`
  const campaigns = new Map<string, CampaignDaily>()
  let guard = 0
  while (url && guard++ < 50) {
    const res = await fetch(url, { cache: "no-store" })
    const json = (await res.json()) as { data?: MetaInsightRow[]; paging?: { next?: string }; error?: { message: string } }
    if (json.error) throw new Error(`Meta API: ${json.error.message}`)
    for (const row of json.data || []) {
      let c = campaigns.get(row.campaign_id)
      if (!c) {
        c = { platform: "meta", campaignId: row.campaign_id, name: row.campaign_name, byDate: {} }
        campaigns.set(row.campaign_id, c)
      }
      c.byDate[row.date_start] = {
        conversions: metaConversionsFromActions(row.actions),
        cost: Number(row.spend) || 0,
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
      }
    }
    url = json.paging?.next || null
  }
  return [...campaigns.values()]
}

// ───────────────────────────────────────────────────────────── Google Ads ──

const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v21"

async function googleAccessToken(creds: GoogleAdsCredentials): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  })
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  })
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string }
  if (!json.access_token) throw new Error(`Google OAuth: ${json.error_description || json.error || "no access_token"}`)
  return json.access_token
}

type GoogleRow = {
  campaign?: { id?: string; name?: string }
  segments?: { date?: string }
  metrics?: { conversions?: number; costMicros?: string; impressions?: string; clicks?: string }
}

export async function fetchGoogleDaily(creds: GoogleAdsCredentials, from: string, to: string): Promise<CampaignDaily[]> {
  const accessToken = await googleAccessToken(creds)
  const query = `SELECT campaign.id, campaign.name, segments.date, metrics.conversions, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": creds.developerToken,
    "Content-Type": "application/json",
  }
  if (creds.loginCustomerId) headers["login-customer-id"] = creds.loginCustomerId
  const res = await fetch(
    `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${creds.customerId}/googleAds:searchStream`,
    { method: "POST", headers, body: JSON.stringify({ query }), cache: "no-store" },
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`Google Ads API ${res.status}: ${text.slice(0, 300)}`)
  // searchStream returns an array of chunks, each { results: [...] }.
  let chunks: { results?: GoogleRow[] }[]
  try {
    chunks = JSON.parse(text)
  } catch {
    throw new Error(`Google Ads API: unparseable response ${text.slice(0, 200)}`)
  }
  const campaigns = new Map<string, CampaignDaily>()
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    for (const row of chunk.results || []) {
      const id = String(row.campaign?.id ?? "")
      const date = row.segments?.date
      if (!id || !date) continue
      let c = campaigns.get(id)
      if (!c) {
        c = { platform: "google", campaignId: id, name: row.campaign?.name || `Campaign ${id}`, byDate: {} }
        campaigns.set(id, c)
      }
      c.byDate[date] = {
        conversions: Number(row.metrics?.conversions) || 0,
        cost: (Number(row.metrics?.costMicros) || 0) / 1e6,
        impressions: Number(row.metrics?.impressions) || 0,
        clicks: Number(row.metrics?.clicks) || 0,
      }
    }
  }
  return [...campaigns.values()]
}
