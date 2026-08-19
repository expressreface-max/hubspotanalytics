import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { hsFetch, HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const payload = {
    properties: ["firstname", "lastname", "email", "zip", "er_territory", "er_sub_region", "er_region", "er_super_region"],
    limit: 100,
    ...body,
  }

  try {
    const data = await hsFetch("/crm/v3/objects/contacts/search", {
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
