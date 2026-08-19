import { NextResponse } from "next/server"
import { setRuntimeToken, tokenHint } from "@/lib/token-store"
import { hsFetch } from "@/lib/hubspot"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const token = (body?.token as string | undefined)?.trim()
  if (!token) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 })
  }

  // Validate the token against HubSpot before saving.
  try {
    await hsFetch("/crm/v3/pipelines/deals", { token, method: "GET" })
  } catch {
    return NextResponse.json(
      { error: "Token rejected by HubSpot. Check the value and required scopes." },
      { status: 401 },
    )
  }

  setRuntimeToken(token)
  return NextResponse.json({ ok: true, hint: tokenHint() })
}
