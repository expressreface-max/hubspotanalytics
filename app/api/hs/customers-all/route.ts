import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { searchAllDeals, isClosedWon, HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type Body = {
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
  const months = ALLOWED_LOOKBACKS.includes(Number(body.months)) ? Number(body.months) : 12

  const keys = monthKeys(months)
  const keySet = new Set(keys)
  const from = new Date(new Date().getFullYear(), new Date().getMonth() - (months - 1), 1)

  // All closed-won deals whose close date falls on/after the window start.
  const filterGroups = [
    {
      filters: [
        { propertyName: "closedate", operator: "GTE", value: String(from.getTime()) },
        { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
      ],
    },
  ]

  try {
    const deals = await searchAllDeals(token, filterGroups, [
      "closedate",
      "zip",
      "hs_is_closed_won",
      "er_territory",
      "er_sub_region",
    ])

    // Group by (subRegion, territory, zip); each combo is one crosstab row.
    const rowMap = new Map<
      string,
      { zip: string; territory: string; subRegion: string; counts: Record<string, number>; total: number }
    >()

    let matched = 0
    for (const d of deals) {
      if (!isClosedWon(d)) continue
      const closed = d.properties.closedate
      if (!closed) continue
      const key = monthKeyOf(new Date(closed).getTime())
      if (!keySet.has(key)) continue

      const zip = normalizeZip(d.properties.zip || "") || "—"
      const territory = (d.properties.er_territory || "").trim()
      const subRegion = (d.properties.er_sub_region || "").trim()
      const rowKey = `${subRegion}|${territory}|${zip}`

      let row = rowMap.get(rowKey)
      if (!row) {
        const counts: Record<string, number> = {}
        for (const k of keys) counts[k] = 0
        row = { zip, territory, subRegion, counts, total: 0 }
        rowMap.set(rowKey, row)
      }
      row.counts[key] += 1
      row.total += 1
      matched += 1
    }

    const rows = Array.from(rowMap.values()).sort((a, b) => b.total - a.total)

    const columnTotals: Record<string, number> = {}
    for (const k of keys) columnTotals[k] = rows.reduce((s, r) => s + r.counts[k], 0)
    const grandTotal = rows.reduce((s, r) => s + r.total, 0)

    return NextResponse.json({
      source: "hubspot",
      months: keys,
      lookback: months,
      zips: [],
      zipTerritory: {},
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
