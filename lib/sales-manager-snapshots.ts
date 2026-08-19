import "server-only"
import { saveSnapshot } from "@/lib/sales-metrics"
import { resolveRange } from "@/lib/date-ranges"
import { GET as meetingsWeeksHandler } from "@/app/api/hs/meetings-weeks/route"
import { POST as quoteAnalysisHandler } from "@/app/api/hs/quote-analysis/route"
import { POST as territoryReportHandler } from "@/app/api/hs/territory-report/route"
import { POST as consultNoQuoteHandler } from "@/app/api/hs/consult-no-quote/route"
import { POST as openQuotesHandler } from "@/app/api/hs/open-quotes/route"

// Recompute the three static Sales Manager sections and store each as a
// snapshot. We reuse the existing (verified) route handlers by invoking them
// with synthetic Requests — both token getters read `x-hubspot-token` (else the
// HUBSPOT_TOKEN env var), and each handler parses its own body. This keeps the
// numbers identical to the live Quotes / Funnel pages with zero logic
// duplication. Runs SEQUENTIALLY so we never fan out heavy searches in parallel.
export async function refreshAllSnapshots(token: string): Promise<{ section: string; ok: boolean }[]> {
  const out: { section: string; ok: boolean }[] = []
  const headers = { "content-type": "application/json", "x-hubspot-token": token }
  const origin = "http://internal"

  // 1. Meetings by rep — this / last / next week, by meeting type.
  try {
    const res = await meetingsWeeksHandler()
    const payload = await res.json()
    await saveSnapshot("meetings_weeks", payload)
    out.push({ section: "meetings_weeks", ok: !payload?.error })
  } catch {
    out.push({ section: "meetings_weeks", ok: false })
  }

  // 2. Open quote pipeline by age (+ monthly sales forecast). Store only the
  //    two slices the section renders.
  try {
    const req = new Request(`${origin}/api/hs/quote-analysis`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    })
    const res = await quoteAnalysisHandler(req)
    const full = await res.json()
    const payload = full?.error ? full : { aging: full.aging, forecast: full.forecast }
    await saveSnapshot("open_quote_pipeline", payload)
    out.push({ section: "open_quote_pipeline", ok: !full?.error })
  } catch {
    out.push({ section: "open_quote_pipeline", ok: false })
  }

  // 3. Sales Rep YTD — the By Sales Rep rollup scoped to this calendar year.
  try {
    const { dateFrom, dateTo } = resolveRange("ytd")
    const req = new Request(`${origin}/api/hs/territory-report`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateFrom, dateTo, pipelines: [] }),
    })
    const res = await territoryReportHandler(req)
    const full = await res.json()
    const payload = full?.error
      ? full
      : { byRep: full.byRep ?? [], dateFrom, dateTo, periodLabel: "Year to date" }
    await saveSnapshot("sales_rep_ytd", payload)
    out.push({ section: "sales_rep_ytd", ok: !full?.error })
  } catch {
    out.push({ section: "sales_rep_ytd", ok: false })
  }

  // 4. Consultations (1+ days ago) whose deal has not reached Quoted, by rep.
  try {
    const req = new Request(`${origin}/api/hs/consult-no-quote`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    })
    const res = await consultNoQuoteHandler(req)
    const payload = await res.json()
    await saveSnapshot("consult_no_quote", payload)
    out.push({ section: "consult_no_quote", ok: !payload?.error })
  } catch {
    out.push({ section: "consult_no_quote", ok: false })
  }

  // 5. Open quotes list (currently in Quoted stage), grouped by rep — the list
  //    that backs the Open Quotes section and its per-row AI reviews.
  try {
    const req = new Request(`${origin}/api/hs/open-quotes`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    })
    const res = await openQuotesHandler(req)
    const payload = await res.json()
    await saveSnapshot("open_quotes_list", payload)
    out.push({ section: "open_quotes_list", ok: !payload?.error })
  } catch {
    out.push({ section: "open_quotes_list", ok: false })
  }

  return out
}
