import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { runWatch } from "@/lib/sales-watch-runner"
export const dynamic = "force-dynamic"
export const maxDuration = 300
export async function GET(req: Request) {
  // Fail closed: no secret NEVER means public permission to spend or read CRM.
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({error:"Unauthorized"},{status:401})
  }
  if (process.env.SALES_WATCH_ENABLED !== "true") return NextResponse.json({skipped:true,reason:"Sales Watch disabled"})
  const token = getActiveToken()
  if (!token) return NextResponse.json({error:"HubSpot not configured"},{status:503})
  try {
    const result = await runWatch(token,"nightly")
    // Log health metadata only, not customer content.
    console.info("sales-watch",JSON.stringify({run:result.run?.id,status:result.run?.status,done:result.run?.done,total:result.run?.total}))
    return NextResponse.json({busy:result.busy,run:result.run})
  } catch {
    return NextResponse.json({error:"Sales Watch failed; check run status."},{status:500})
  }
}
