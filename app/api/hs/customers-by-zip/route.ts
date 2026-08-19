import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { searchAllDeals, isClosedWon, fetchZipHierarchyMap, HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type Body = {
  zips?: string[]
  months?: number
}

const ALLOWED_LOOKBACKS = [1, 3, 6, 12, 24]

// Normalize a raw zip to its 5-digit form (drops ZIP+4 and stray whitespace).
function normalizeZip(raw: string): string {
  const m = (raw || "").trim().match(/\d{5}/)
  return m ? m[0] : ""
}

// Build ascending month keys (YYYY-MM) for the trailing `months` window,
// including the current month.
function monthKeys(months: number): string[] {
  const now = new Date()
  const keys: string[] = []
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`)
  }
  return keys
}

function monthKeyOf(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body: Body = await req.json().catch(() => ({}))

  // Dedupe + normalize the requested zips, preserving first-seen order.
  const seen = new Set<string>()
  const zips: string[] = []
  for (const raw of body.zips || []) {
    const z = normalizeZip(raw)
    if (z && !seen.has(z)) {
      seen.add(z)
      zips.push(z)
    }
  }

  if (zips.length === 0) {
    return NextResponse.json({ error: "Enter at least one valid 5-digit ZIP code." }, { status: 400 })
  }

  const months = ALLOWED_LOOKBACKS.includes(Number(body.months)) ? Number(body.months) : 12

  const keys = monthKeys(months)
  const from = new Date(new Date().getFullYear(), new Date().getMonth() - (months - 1), 1)

  // HubSpot deal search: closed-won on/after the window start AND zip IN the list.
  // We filter by close date and closed-won status; count deals by their close-won month.
  const filterGroups = [
    {
      filters: [
        { propertyName: "closedate", operator: "GTE", value: String(from.getTime()) },
        { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
        { propertyName: "zip", operator: "IN", values: zips },
      ],
    },
  ]

  try {
    const [deals, zipHierarchy] = await Promise.all([
      searchAllDeals(token, filterGroups, ["closedate", "zip", "hs_is_closed_won"]),
      fetchZipHierarchyMap(token, zips),
    ])
    // Flat zip -> territory map for backwards-compatible fields.
    const zipTerritory: Record<string, string> = {}
    for (const [z, h] of Object.entries(zipHierarchy)) {
      if (h.territory) zipTerritory[z] = h.territory
    }

    // Seed the crosstab so every requested zip and month is present (even if zero).
    const counts = new Map<string, Record<string, number>>()
    for (const z of zips) {
      const row: Record<string, number> = {}
      for (const k of keys) row[k] = 0
      counts.set(z, row)
    }

    const keySet = new Set(keys)
    let matched = 0
    for (const d of deals) {
      // Guard against any non-won rows slipping through the search filter.
      if (!isClosedWon(d)) continue
      const z = normalizeZip(d.properties.zip || "")
      const row = counts.get(z)
      if (!row) continue
      const closed = d.properties.closedate
      if (!closed) continue
      const key = monthKeyOf(new Date(closed).getTime())
      if (!keySet.has(key)) continue
      row[key] += 1
      matched += 1
    }

    // Shape rows + totals for the crosstab.
    const rows = zips.map((zip) => {
      const byMonth = counts.get(zip)!
      const total = keys.reduce((s, k) => s + byMonth[k], 0)
      const h = zipHierarchy[zip]
      return {
        zip,
        territory: h?.territory || "",
        subRegion: h?.subRegion || "",
        counts: byMonth,
        total,
      }
    })

    const columnTotals: Record<string, number> = {}
    for (const k of keys) columnTotals[k] = rows.reduce((s, r) => s + r.counts[k], 0)
    const grandTotal = rows.reduce((s, r) => s + r.total, 0)

    return NextResponse.json({
      source: "hubspot",
      months: keys,
      lookback: months,
      zips,
      zipTerritory,
      zipHierarchy,
      rows,
      columnTotals,
      grandTotal,
      matched,
      totalFetched: deals.length,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ error: err.message }, { status: err.status || 502 })
    }
    return NextResponse.json({ error: (err as Error).message || "Failed to load customers" }, { status: 500 })
  }
}
