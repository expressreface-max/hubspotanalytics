import { NextResponse } from "next/server"
import { getScanHistory, getScanSummary, getScanStates } from "@/lib/open-quote-scans"
import { fetchPortalId, getToken } from "@/lib/hubspot"

export const dynamic = "force-dynamic"

// Stored daily-scan data. With ?dealId= returns that quote's scan history
// (newest first); without it returns an overall scan summary. Read-only from
// the DB, so it's cheap and does not hit HubSpot or the AI model.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const dealId = searchParams.get("dealId")

  try {
    if (dealId) {
      const scans = await getScanHistory(dealId)
      return NextResponse.json({ dealId, scans })
    }
    const token = getToken(req)
    const [summary, states, portalId] = await Promise.all([
      getScanSummary(),
      getScanStates(),
      token ? fetchPortalId(token) : Promise.resolve(null),
    ])
    return NextResponse.json({ ...summary, states, portalId })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || "Failed to load scans", scans: [] }, { status: 500 })
  }
}
