import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { runDailyScan } from "@/lib/open-quote-scans"
import { HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 300

type Body = { dealId?: string }

// Run the daily AI scan. With a dealId, scans just that quote (fast, used by the
// per-row "Run scan" button). Without one, scans every open quote (used by the
// "Scan all" control and the nightly cron), bounded by a time budget.
export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const { dealId }: Body = await req.json().catch(() => ({}))

  try {
    const result = await runDailyScan(token, dealId ? { dealId } : {})
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const raw = (err as Error).message || "Scan failed."
    const friendly = /api key not valid|invalid api key|api_key_invalid|permission denied/i.test(raw)
      ? "The Google API key is missing or invalid. Add a valid GOOGLE_GENERATIVE_AI_API_KEY in Project settings → Vars to run Gemini."
      : /rate-limit|rate limit|free tier|paid credits|upgrade|quota/i.test(raw)
        ? "AI scan was rate-limited on the free AI Gateway. Add a Google API key (GOOGLE_GENERATIVE_AI_API_KEY) in Project settings → Vars to use the paid Gemini model, or try again in a minute."
        : raw
    return NextResponse.json({ error: friendly }, { status: 500 })
  }
}
