import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { runDailyScan } from "@/lib/open-quote-scans"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Nightly per-quote AI scan (scheduled in vercel.json). Public in middleware but
// gated here by required CRON_SECRET (Vercel sends Authorization: Bearer).
// A missing secret fails closed rather than allowing public AI/API calls.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ ok: false, error: "CRON_SECRET is required." }, { status: 503 })
  if (secret) {
    const auth = req.headers.get("authorization")
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
    }
  }
  // Avoid paying for overlapping scans after the broader watch is activated.
  if (process.env.SALES_WATCH_ENABLED === "true") {
    return NextResponse.json({ ok: true, skipped: true, reason: "Sales Watch replaces the legacy quote-only scheduled scan." })
  }

  const token = getActiveToken()
  if (!token) return NextResponse.json({ ok: false, error: "HubSpot not connected." }, { status: 200 })

  try {
    const result = await runDailyScan(token)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scan cron failed."
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
