import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { runDailyScan } from "@/lib/open-quote-scans"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Nightly per-quote AI scan (scheduled in vercel.json). Public in middleware but
// gated here by CRON_SECRET when set (Vercel Cron sends `Authorization: Bearer
// <CRON_SECRET>`). Open when the secret is unset so it can be seeded manually.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.get("authorization")
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
    }
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
