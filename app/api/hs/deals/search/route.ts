import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { hsFetch, HubSpotError, DEAL_PROPERTIES } from "@/lib/hubspot"

export const dynamic = "force-dynamic"

// Proxy to HubSpot CRM deals search. Body is passed through; sensible defaults
// are applied for properties/limit when omitted.
export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const payload = {
    properties: DEAL_PROPERTIES,
    limit: 100,
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    ...body,
  }

  try {
    const data = await hsFetch("/crm/v3/objects/deals/search", {
      token,
      method: "POST",
      body: JSON.stringify(payload),
    })
    return NextResponse.json(data)
  } catch (err) {
    const status = err instanceof HubSpotError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
