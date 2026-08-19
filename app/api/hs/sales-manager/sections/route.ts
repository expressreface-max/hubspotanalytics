import { NextResponse } from "next/server"
import { readAllSnapshots } from "@/lib/sales-metrics"

export const dynamic = "force-dynamic"

// Fast DB read of the three pre-computed section snapshots (Meetings, Open Quote
// Pipeline, Sales Rep YTD). No live HubSpot query — the page is a static
// nightly snapshot.
export async function GET() {
  try {
    const snaps = await readAllSnapshots()
    return NextResponse.json({
      meetingsWeeks: snaps.meetings_weeks,
      openQuotePipeline: snaps.open_quote_pipeline,
      salesRepYtd: snaps.sales_rep_ytd,
      consultNoQuote: snaps.consult_no_quote,
      openQuotesList: snaps.open_quotes_list,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read section snapshots."
    return NextResponse.json(
      {
        meetingsWeeks: null,
        openQuotePipeline: null,
        salesRepYtd: null,
        consultNoQuote: null,
        openQuotesList: null,
        error: message,
      },
      { status: 200 },
    )
  }
}
