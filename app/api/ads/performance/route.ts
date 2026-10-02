import { NextResponse } from "next/server"
import { getAdsCredentials } from "@/lib/ads-credentials"
import {
  buildWindows,
  emptyBase,
  fetchGoogleDaily,
  fetchMetaDaily,
  fetchRange,
  windowRanges,
  withRatios,
  WINDOW_KEYS,
  type BaseMetrics,
  type CampaignDaily,
  type Platform,
  type WindowKey,
  type WindowMetrics,
} from "@/lib/ads-metrics"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type CampaignOut = {
  platform: Platform
  campaignId: string
  name: string
  windows: Record<WindowKey, WindowMetrics>
}

function sumInto(acc: BaseMetrics, m: WindowMetrics) {
  acc.conversions += m.conversions
  acc.cost += m.cost
  acc.impressions += m.impressions
  acc.clicks += m.clicks
}

export async function GET() {
  const creds = await getAdsCredentials()
  if (!creds.configured) {
    return NextResponse.json({ configured: false, notes: creds.notes, campaigns: [] })
  }

  const now = new Date()
  const { from, to } = fetchRange(now)
  const ranges = windowRanges(now)

  const platforms: Record<string, { ok: boolean; error?: string; campaigns: number }> = {}

  async function pull(platform: Platform, fn: () => Promise<CampaignDaily[]>): Promise<CampaignDaily[]> {
    try {
      const rows = await fn()
      platforms[platform] = { ok: true, campaigns: rows.length }
      return rows
    } catch (e) {
      platforms[platform] = { ok: false, error: (e as Error).message, campaigns: 0 }
      return []
    }
  }

  const [metaRows, googleRows] = await Promise.all([
    creds.meta ? pull("meta", () => fetchMetaDaily(creds.meta!, from, to)) : Promise.resolve([]),
    creds.google ? pull("google", () => fetchGoogleDaily(creds.google!, from, to)) : Promise.resolve([]),
  ])
  if (!creds.meta) platforms.meta = { ok: false, error: "not configured", campaigns: 0 }
  if (!creds.google) platforms.google = { ok: false, error: "not configured", campaigns: 0 }

  const all = [...metaRows, ...googleRows]
  const campaigns: CampaignOut[] = all
    .map((c) => ({ platform: c.platform, campaignId: c.campaignId, name: c.name, windows: buildWindows(c.byDate, now) }))
    .sort((a, b) => b.windows.last30.cost - a.windows.last30.cost)

  // Per-platform + combined window totals (sum base metrics, then re-derive ratios).
  const emptyByWindow = () => Object.fromEntries(WINDOW_KEYS.map((k) => [k, emptyBase()])) as Record<WindowKey, BaseMetrics>
  const acc: Record<"meta" | "google" | "combined", Record<WindowKey, BaseMetrics>> = {
    meta: emptyByWindow(),
    google: emptyByWindow(),
    combined: emptyByWindow(),
  }
  for (const c of campaigns) {
    for (const k of WINDOW_KEYS) {
      sumInto(acc[c.platform][k], c.windows[k])
      sumInto(acc.combined[k], c.windows[k])
    }
  }
  const finalize = (byWindow: Record<WindowKey, BaseMetrics>) =>
    Object.fromEntries(WINDOW_KEYS.map((k) => [k, withRatios(byWindow[k])])) as Record<WindowKey, WindowMetrics>

  return NextResponse.json({
    configured: true,
    generatedAt: new Date().toISOString(),
    range: { from, to },
    windowRanges: ranges,
    platforms,
    notes: creds.notes,
    campaigns,
    totals: { meta: finalize(acc.meta), google: finalize(acc.google), combined: finalize(acc.combined) },
  })
}
