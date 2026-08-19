import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { refreshAllPeriods } from "@/lib/sales-metrics"
import { refreshAllSnapshots } from "@/lib/sales-manager-snapshots"
import { refreshTerritoryPotentialSnapshot } from "@/lib/territory-potential-report"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Nightly refresh entry point (scheduled in vercel.json). Public in middleware,
// but gated here by CRON_SECRET when it is set. Vercel Cron automatically sends
// `Authorization: Bearer <CRON_SECRET>`. When the secret is unset (local dev /
// seeding) the endpoint is open so it can be triggered manually.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.get("authorization")
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
    }
  }

  const token = getActiveToken()
  if (!token) {
    return NextResponse.json({ ok: false, error: "HubSpot not connected." }, { status: 200 })
  }

  try {
    // Matrix first (fast, count-only), then the heavy section snapshots, then
    // the Territory Potential snapshot (trailing-12mo closed-won by territory).
    const result = await refreshAllPeriods(token)
    const sections = await refreshAllSnapshots(token)
    let territoryPotential: { ok: boolean } = { ok: false }
    try {
      territoryPotential = await refreshTerritoryPotentialSnapshot(token)
    } catch {
      territoryPotential = { ok: false }
    }
    return NextResponse.json({ ok: true, periods: result, sections, territoryPotential })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cron refresh failed."
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
