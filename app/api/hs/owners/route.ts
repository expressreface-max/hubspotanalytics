import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { hsFetch, HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  try {
    const data = await hsFetch<{ results: any[] }>("/crm/v3/owners?limit=200", {
      token,
      method: "GET",
    })
    const owners = (data.results || []).map((o) => ({
      id: o.id,
      name: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email,
      email: o.email,
    }))
    return NextResponse.json({ owners })
  } catch (err) {
    const status = err instanceof HubSpotError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
