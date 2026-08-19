import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  searchAllDeals,
  isClosedWon,
  dealAmount,
  pipelineLabel,
  HubSpotError,
  type HubSpotDeal,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type Body = {
  dateFrom?: string // ISO date
  dateTo?: string
  pipelines?: string[]
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body: Body = await req.json().catch(() => ({}))

  const now = new Date()
  const currentYear = now.getFullYear()
  const priorYear = currentYear - 1

  // Default window: Jan 1 of prior year -> now, so we can compute YoY.
  const from = body.dateFrom ? new Date(body.dateFrom) : new Date(priorYear, 0, 1)
  const to = body.dateTo ? new Date(body.dateTo) : now

  const filters: any[] = [
    { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
    { propertyName: "closedate", operator: "GTE", value: String(from.getTime()) },
    { propertyName: "closedate", operator: "LTE", value: String(to.getTime()) },
  ]

  const filterGroups =
    body.pipelines && body.pipelines.length
      ? body.pipelines.map((p) => ({
          filters: [...filters, { propertyName: "pipeline", operator: "EQ", value: p }],
        }))
      : [{ filters }]

  try {
    const deals = await searchAllDeals(token, filterGroups)

    let totalRevenue = 0
    const wonCount = deals.length
    const revByMonth: Record<string, { current: number; prior: number }> = {}
    const jobsByMonth: Record<string, { current: number; prior: number }> = {}
    const revByPipeline: Record<string, number> = {}
    const revByZip: Record<string, number> = {}

    for (const m of MONTHS) {
      revByMonth[m] = { current: 0, prior: 0 }
      jobsByMonth[m] = { current: 0, prior: 0 }
    }

    for (const deal of deals) {
      if (!isClosedWon(deal)) continue
      const amount = dealAmount(deal)
      totalRevenue += amount

      const closedRaw = deal.properties.closedate
      if (closedRaw) {
        const d = new Date(closedRaw)
        const monthKey = MONTHS[d.getMonth()]
        const yr = d.getFullYear()
        if (yr === currentYear) {
          revByMonth[monthKey].current += amount
          jobsByMonth[monthKey].current += 1
        } else if (yr === priorYear) {
          revByMonth[monthKey].prior += amount
          jobsByMonth[monthKey].prior += 1
        }
      }

      const pl = pipelineLabel(deal.properties.pipeline)
      revByPipeline[pl] = (revByPipeline[pl] || 0) + amount

      const zip = (deal.properties.zip || "").trim()
      if (zip) revByZip[zip] = (revByZip[zip] || 0) + amount
    }

    const revenueByMonth = MONTHS.map((m) => ({ month: m, ...revByMonth[m] }))
    const jobsByMonthArr = MONTHS.map((m) => ({ month: m, ...jobsByMonth[m] }))
    const revenueByPipeline = Object.entries(revByPipeline)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
    const revenueByZip = Object.entries(revByZip)
      .map(([zip, value]) => ({ zip, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12)

    return NextResponse.json({
      kpis: {
        totalRevenue,
        closedWon: wonCount,
        avgDealSize: wonCount ? Math.round(totalRevenue / wonCount) : 0,
        activePipelines: Object.keys(revByPipeline).length,
      },
      currentYear,
      priorYear,
      revenueByMonth,
      jobsByMonth: jobsByMonthArr,
      revenueByPipeline,
      revenueByZip,
    })
  } catch (err) {
    const status = err instanceof HubSpotError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
