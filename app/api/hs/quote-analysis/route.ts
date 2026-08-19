import { NextResponse } from "next/server"
import {
  getToken,
  searchAllDeals,
  isClosedWon,
  dealAmount,
  pipelineLabel,
  QUOTED_STAGE_IDS,
  QUOTED_DATE_PROPS,
  DEAL_PROPERTIES,
  type HubSpotDeal,
} from "@/lib/hubspot"

export const maxDuration = 120

const DAY = 24 * 60 * 60 * 1000

// Aging bands for open quotes (by days since the deal entered the Quoted stage).
const BANDS = [
  { key: "d0_30", label: "≤ 30 days", start: 0, end: 30 },
  { key: "d31_60", label: "31–60 days", start: 31, end: 60 },
  { key: "d61_90", label: "61–90 days", start: 61, end: 90 },
  { key: "d91", label: "91+ days", start: 91, end: Infinity },
] as const

// Lower-bound thresholds used for the conditional "still open at day N" model.
const THRESHOLDS = [0, 31, 61, 91]

function parseTime(v: string | null | undefined): number | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

// Earliest date the deal entered any Quoted-stage (its "quoted on" date).
function quotedTime(deal: HubSpotDeal): number | null {
  let min: number | null = null
  for (const prop of QUOTED_DATE_PROPS) {
    const t = parseTime(deal.properties[prop])
    if (t != null && (min == null || t < min)) min = t
  }
  return min
}

// Which aging band an age (in days) falls into.
function bandIndex(ageDays: number): number {
  if (ageDays <= 30) return 0
  if (ageDays <= 60) return 1
  if (ageDays <= 90) return 2
  return 3
}

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export async function POST(req: Request) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: "Not configured" }, { status: 400 })

  try {
    await req.json().catch(() => ({}))
    // This analysis is scoped to the Express Reface pipeline only (id "default").
    const pipelines: string[] = ["default"]
    const now = Date.now()
    const props = [...DEAL_PROPERTIES, "hs_is_closed"]

    // Exclude non-sales / internal deals: anything with "doug schubert" or
    // "training" in the deal name (case-insensitive).
    const isExcluded = (d: HubSpotDeal): boolean => {
      const name = (d.properties.dealname || "").toLowerCase()
      return name.includes("doug schubert") || name.includes("training")
    }

    // ---- Section 1: deals CURRENTLY in a Quoted stage (open quotes) ----
    const quotedStageIds = [...QUOTED_STAGE_IDS]
    const openFilterGroups = pipelines.length
      ? pipelines.map((p) => ({
          filters: [
            { propertyName: "dealstage", operator: "IN", values: quotedStageIds },
            { propertyName: "pipeline", operator: "EQ", value: p },
          ],
        }))
      : [{ filters: [{ propertyName: "dealstage", operator: "IN", values: quotedStageIds }] }]

    // ---- Section 2: all deals that ENTERED the Quoted stage in the last 24 months ----
    // HubSpot caps search at 5 filterGroups, so we can't OR the 17 quoted-stage
    // date props. Instead, dual-pass by createdate + closedate in the window
    // (like the territory report), dedupe, then keep those whose quoted date
    // actually falls in the window. Extra createdate lookback buffer captures
    // long-cycle deals created before the window but quoted inside it.
    const from = now - 730 * DAY // ~24 months
    const createFrom = now - 900 * DAY // ~30 months buffer for created-before/quoted-inside
    const pipeFilter = pipelines.length === 1 ? [{ propertyName: "pipeline", operator: "EQ", value: pipelines[0] }] : []
    const cohortFilterGroups = [
      { filters: [{ propertyName: "createdate", operator: "GTE", value: String(createFrom) }, ...pipeFilter] },
      { filters: [{ propertyName: "closedate", operator: "GTE", value: String(from) }, ...pipeFilter] },
    ]

    const [openDealsRaw, cohortDual] = await Promise.all([
      searchAllDeals(token, openFilterGroups, props, 60),
      searchAllDeals(token, cohortFilterGroups, props, 80),
    ])
    const openDeals = openDealsRaw.filter((d) => !isExcluded(d))

    // Dedupe the dual-pass results, keep only deals quoted within the 24mo window
    // (and, when scoping multiple pipelines, in the requested set).
    const seen = new Set<string>()
    const cohort: HubSpotDeal[] = []
    for (const d of cohortDual) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      if (isExcluded(d)) continue
      if (pipelines.length > 1 && !pipelines.includes(d.properties.pipeline || "")) continue
      const qt = quotedTime(d)
      if (qt == null || qt < from || qt > now) continue
      cohort.push(d)
    }

    // ---- Build the historical conversion model from the cohort ----
    // For each quote: quotedTime, outcome (won/lost/open), and the day it resolved
    // (days-to-won, days-to-lost, or censored current age for still-open).
    type CohortRow = { won: boolean; closed: boolean; resolveDay: number; daysToWon: number | null }
    const rows: CohortRow[] = []
    for (const d of cohort) {
      const qt = quotedTime(d)
      if (qt == null) continue
      const won = isClosedWon(d)
      const closedFlag = d.properties.hs_is_closed === "true" || won
      const closeT = parseTime(d.properties.closedate)
      let resolveDay: number
      let daysToWon: number | null = null
      if (won && closeT != null) {
        daysToWon = Math.max(0, Math.round((closeT - qt) / DAY))
        resolveDay = daysToWon
      } else if (closedFlag && closeT != null) {
        resolveDay = Math.max(0, Math.round((closeT - qt) / DAY)) // lost
      } else {
        resolveDay = Math.max(0, Math.round((now - qt) / DAY)) // still open (censored)
      }
      rows.push({ won, closed: closedFlag, resolveDay, daysToWon })
    }

    // Conditional win-rate: among quotes still open at day T, fraction that
    // eventually win. (resolveDay >= T means the quote had not yet closed by day T.)
    const conversionByThreshold = THRESHOLDS.map((T) => {
      const eligible = rows.filter((r) => r.resolveDay >= T)
      const won = eligible.filter((r) => r.won).length
      return {
        threshold: T,
        eligible: eligible.length,
        won,
        rate: eligible.length ? won / eligible.length : 0,
      }
    })

    const wonRows = rows.filter((r) => r.won)
    const overallRate = rows.length ? wonRows.length / rows.length : 0
    const medianDaysToWon = median(wonRows.map((r) => r.daysToWon || 0))

    // ---- Quote outcome timeline: 30-day bands out to 2 years ----
    // Kaplan-Meier style so still-open (censored) quotes drop out of the at-risk
    // set once we can no longer observe them, giving unbiased conditional rates.
    // For each band [start,end): at-risk = quotes not yet resolved before `start`.
    // condWin = won during band ÷ at-risk (the "if still open at day start, chance
    // it wins in the next 30 days"). Cumulative win/loss + still-open come from
    // chaining the per-band survival, so the three always sum to ~100% per band.
    const TIMELINE_BAND_DAYS = 30
    const TIMELINE_MAX_DAY = 720 // ~24 months in 30-day months
    const timeline: {
      start: number
      end: number
      label: string
      atRisk: number
      wonInBand: number
      lostInBand: number
      condWinPct: number
      condLossPct: number
      cumWonPct: number
      cumLostPct: number
      stillOpenPct: number
    }[] = []
    let survivorS = 1 // probability still open at band start
    let cumWinP = 0
    let cumLossP = 0
    for (let start = 0; start < TIMELINE_MAX_DAY; start += TIMELINE_BAND_DAYS) {
      const end = start + TIMELINE_BAND_DAYS
      const atRisk = rows.filter((r) => r.resolveDay >= start).length
      const wonInBand = rows.filter((r) => r.won && r.resolveDay >= start && r.resolveDay < end).length
      const lostInBand = rows.filter(
        (r) => r.closed && !r.won && r.resolveDay >= start && r.resolveDay < end,
      ).length
      const winHaz = atRisk ? wonInBand / atRisk : 0
      const lossHaz = atRisk ? lostInBand / atRisk : 0
      const startS = survivorS
      cumWinP += startS * winHaz
      cumLossP += startS * lossHaz
      survivorS = startS * (1 - winHaz - lossHaz)
      timeline.push({
        start,
        end,
        label: `${start}\u2013${end}d`,
        atRisk,
        wonInBand,
        lostInBand,
        condWinPct: winHaz * 100,
        condLossPct: lossHaz * 100,
        cumWonPct: cumWinP * 100,
        cumLostPct: cumLossP * 100,
        stillOpenPct: Math.max(0, survivorS) * 100,
      })
    }

    // ---- Aging buckets + forecast for the current open quotes ----
    const buckets = BANDS.map((b, i) => ({
      key: b.key,
      label: b.label,
      count: 0,
      amount: 0,
      conversionPct: conversionByThreshold[i].rate * 100,
      forecastAmount: 0,
    }))

    for (const d of openDeals) {
      const qt = quotedTime(d)
      if (qt == null) continue
      const ageDays = Math.max(0, Math.round((now - qt) / DAY))
      const idx = bandIndex(ageDays)
      buckets[idx].count += 1
      buckets[idx].amount += dealAmount(d)
    }
    for (let i = 0; i < buckets.length; i++) {
      buckets[i].forecastAmount = buckets[i].amount * conversionByThreshold[i].rate
    }

    const totalCount = buckets.reduce((s, b) => s + b.count, 0)
    const totalAmount = buckets.reduce((s, b) => s + b.amount, 0)
    const totalForecast = buckets.reduce((s, b) => s + b.forecastAmount, 0)

    // ---- Monthly sales forecast: this month + last month ----
    // Forecast for a month = revenue already closed-won in that month (actuals)
    // PLUS, for the current month, the probability-weighted value expected to
    // close out of the open quote pipeline (totalForecast). Last month is
    // complete, so it is actuals only.
    const nowDate = new Date(now)
    const thisMonthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1)
    const lastMonthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - 1, 1)
    const monthName = (ms: number) =>
      new Date(ms).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })

    const seenWon = new Set<string>()
    let thisMonthWon = 0
    let thisMonthWonCount = 0
    let lastMonthWon = 0
    let lastMonthWonCount = 0
    for (const d of cohortDual) {
      if (seenWon.has(d.id)) continue
      seenWon.add(d.id)
      if (isExcluded(d)) continue
      if (pipelines.length > 1 && !pipelines.includes(d.properties.pipeline || "")) continue
      if (!isClosedWon(d)) continue
      const ct = parseTime(d.properties.closedate)
      if (ct == null) continue
      const amt = dealAmount(d)
      if (ct >= thisMonthStart && ct <= now) {
        thisMonthWon += amt
        thisMonthWonCount += 1
      } else if (ct >= lastMonthStart && ct < thisMonthStart) {
        lastMonthWon += amt
        lastMonthWonCount += 1
      }
    }

    const forecast = {
      thisMonth: {
        label: monthName(thisMonthStart),
        won: thisMonthWon,
        wonCount: thisMonthWonCount,
        openForecast: totalForecast,
        total: thisMonthWon + totalForecast,
      },
      lastMonth: {
        label: monthName(lastMonthStart),
        won: lastMonthWon,
        wonCount: lastMonthWonCount,
        openForecast: 0,
        total: lastMonthWon,
      },
    }

    // Per-open-quote detail rows (for the table)
    const openDetail = openDeals
      .map((d) => {
        const qt = quotedTime(d)
        const ageDays = qt == null ? null : Math.max(0, Math.round((now - qt) / DAY))
        return {
          id: d.id,
          name: d.properties.dealname || "(unnamed)",
          quotedDate: qt != null ? new Date(qt).toISOString() : null,
          ageDays,
          band: ageDays == null ? "" : BANDS[bandIndex(ageDays)].label,
          amount: dealAmount(d),
          pipeline: pipelineLabel(d.properties.pipeline),
        }
      })
      .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))

    return NextResponse.json({
      asOf: new Date(now).toISOString(),
      aging: { buckets, totalCount, totalAmount, totalForecast },
      forecast,
      model: {
        windowMonths: 24,
        cohortSize: rows.length,
        wonTotal: wonRows.length,
        overallRatePct: overallRate * 100,
        medianDaysToWon,
        bands: BANDS.map((b, i) => ({
          key: b.key,
          label: b.label,
          threshold: conversionByThreshold[i].threshold,
          eligible: conversionByThreshold[i].eligible,
          won: conversionByThreshold[i].won,
          conversionPct: conversionByThreshold[i].rate * 100,
        })),
      },
      timeline,
      openDetail,
    })
  } catch (err: any) {
    const status = err?.status && Number.isFinite(err.status) ? err.status : 500
    return NextResponse.json({ error: err?.message || "Failed to load quote analysis" }, { status })
  }
}
