import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { runNightlyEnrichment } from "@/lib/reapi-deal-enrichment"
import { realEstateApiConfigured } from "@/lib/realestate"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Nightly RealEstateAPI enrichment (scheduled in vercel.json). Finds deals
// that have entered a Quoted stage or closed (won/lost) and don't yet have a
// row in reapi_deal_enrichment, then looks up property + owner data for up
// to NIGHTLY_CAP new deals (default 200) to keep API cost predictable.
// Public in middleware, but gated here by CRON_SECRET when set (Vercel Cron
// automatically sends `Authorization: Bearer <CRON_SECRET>`).
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

  if (!realEstateApiConfigured()) {
    return NextResponse.json({ ok: false, error: "RealEstateAPI key is not configured." }, { status: 200 })
  }

  try {
    const cap = Number(process.env.REAPI_NIGHTLY_CAP) || 200
    const result = await runNightlyEnrichment(token, cap)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Enrichment cron failed."
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
