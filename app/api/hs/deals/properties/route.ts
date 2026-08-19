import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { hsFetch, HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  try {
    const data = await hsFetch<{ results: any[] }>("/crm/v3/properties/deals", {
      token,
      method: "GET",
    })
    const properties = (data.results || []).map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      fieldType: p.fieldType,
      groupName: p.groupName,
      options: p.options,
    }))
    return NextResponse.json({ properties })
  } catch (err) {
    const status = err instanceof HubSpotError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
