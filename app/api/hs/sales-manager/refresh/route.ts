import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { refreshAllPeriods } from "@/lib/sales-metrics"
import { refreshAllSnapshots } from "@/lib/sales-manager-snapshots"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST() {
  const token = getActiveToken()
  if (!token) {
    return NextResponse.json({ ok: false, error: "HubSpot not connected." }, { status: 200 })
  }
  try {
    const result = await refreshAllPeriods(token)
    const sections = await refreshAllSnapshots(token)
    return NextResponse.json({ ok: true, periods: result.length, sections })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refresh failed."
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
