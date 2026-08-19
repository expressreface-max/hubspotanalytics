import { NextResponse } from "next/server"
import { getToken } from "@/lib/hubspot"
import { computeTerritoryPotential, readTerritoryPotentialSnapshot } from "@/lib/territory-potential-report"

export const dynamic = "force-dynamic"
export const maxDuration = 120

// The Territory Potential page reads the nightly snapshot (written by the cron)
// so it paints instantly and shows the same trailing-12-month actuals for
// everyone. If no snapshot exists yet (first run) it falls back to a live
// compute so the page is never empty.
export async function POST(req: Request) {
  const token = getToken(req)
  if (!token) {
    return NextResponse.json({ configured: false, rows: [], outOfModel: [] }, { status: 200 })
  }

  try {
    const snap = await readTerritoryPotentialSnapshot()
    if (snap) {
      return NextResponse.json({ ...snap.report, snapshotAt: snap.updatedAt })
    }
    // No snapshot yet — compute live this once.
    const report = await computeTerritoryPotential(token)
    return NextResponse.json(report)
  } catch (err) {
    return NextResponse.json(
      { configured: true, error: (err as Error).message, rows: [], outOfModel: [] },
      { status: 200 },
    )
  }
}
