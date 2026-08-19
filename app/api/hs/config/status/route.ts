import { NextResponse } from "next/server"
import { isConfigured, tokenHint } from "@/lib/token-store"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  return NextResponse.json({
    configured: isConfigured(req),
    hint: tokenHint(),
    source: process.env.HUBSPOT_TOKEN ? "env" : tokenHint() ? "runtime" : null,
  })
}
