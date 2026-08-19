import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { searchAllDeals, isClosedWon, dealAmount, HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Returns closed-won revenue bucketed by calendar month ("YYYY-MM") across a
// date range. Used by the Advertising page to overlay revenue on ad spend.
export async function GET(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const fromParam = searchParams.get("from")
  const toParam = searchParams.get("to")

  const from = fromParam ? new Date(fromParam) : new Date(2023, 0, 1)
  const to = toParam ? new Date(toParam) : new Date()

  const filters = [
    { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
    { propertyName: "closedate", operator: "GTE", value: String(from.getTime()) },
    { propertyName: "closedate", operator: "LTE", value: String(to.getTime()) },
  ]

  try {
    const deals = await searchAllDeals(token, [{ filters }])
    const byMonth: Record<string, { revenue: number; jobs: number }> = {}

    for (const deal of deals) {
      if (!isClosedWon(deal)) continue
      const raw = deal.properties.closedate
      if (!raw) continue
      const d = new Date(raw)
      if (Number.isNaN(d.getTime())) continue
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      if (!byMonth[key]) byMonth[key] = { revenue: 0, jobs: 0 }
      byMonth[key].revenue += dealAmount(deal)
      byMonth[key].jobs += 1
    }

    const monthlyRevenue = Object.entries(byMonth)
      .map(([month, { revenue, jobs }]) => ({ month, revenue, jobs }))
      .sort((a, b) => a.month.localeCompare(b.month))

    return NextResponse.json({ monthlyRevenue })
  } catch (err) {
    const status = err instanceof HubSpotError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
