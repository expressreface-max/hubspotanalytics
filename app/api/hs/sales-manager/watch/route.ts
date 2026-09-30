import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth"
import { getActiveToken } from "@/lib/token-store"
import { readWatch, applyWatchAction } from "@/lib/sales-watch-store"
import { runWatch } from "@/lib/sales-watch-runner"

export const dynamic = "force-dynamic"
export const maxDuration = 300
async function session() {
  // The existing app supports a dev signing fallback. Never accept that fallback
  // for the new customer-intelligence/read-or-spend boundary.
  if (!process.env.AUTH_SESSION_SECRET && !process.env.SUPABASE_JWT_SECRET) return null
  return verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value)
}
export async function GET() {
  if (!await session()) return NextResponse.json({ error:"Not authenticated" },{ status:401 })
  if (process.env.SALES_WATCH_ENABLED !== "true") return NextResponse.json({
    items:[],run:null,lastCompleteAt:null,enabled:false,coverage:["Sales Watch is not activated. Migration and canary validation are required."],
  })
  try { return NextResponse.json(await readWatch()) }
  catch { return NextResponse.json({error:"Watch storage unavailable. Check the reviewed migration and database connection."},{status:503}) }
}
const bodySchema = z.discriminatedUnion("action",[
  z.object({action:z.literal("refresh"),confirm:z.literal(true)}),
  z.object({action:z.enum(["resolve","snooze","reopen"]),id:z.string().regex(/^[a-f0-9]{32}$/),note:z.string().min(5).max(2000),until:z.string().datetime({offset:true}).optional()}),
])
export async function POST(req: Request) {
  const user = await session()
  if (!user) return NextResponse.json({error:"Not authenticated"},{status:401})
  if (req.headers.get("origin") !== new URL(req.url).origin) return NextResponse.json({error:"Same-origin request required"},{status:403})
  const body = bodySchema.safeParse(await req.json().catch(()=>null))
  if (!body.success) return NextResponse.json({error:"Invalid request or confirmation missing"},{status:400})
  try {
    if (body.data.action === "refresh") {
      const token = getActiveToken()
      if (!token) return NextResponse.json({error:"HubSpot is not configured"},{status:503})
      return NextResponse.json(await runWatch(token,"manual"))
    }
    if (process.env.SALES_WATCH_ENABLED !== "true") return NextResponse.json({error:"Watch is disabled"},{status:409})
    return NextResponse.json(await applyWatchAction(body.data.id,body.data.action,body.data.note,user.email,body.data.until))
  } catch {
    return NextResponse.json({error:"Watch request did not complete. Check saved run status, deployment configuration and coverage; wait 15 minutes before starting another new run."},{status:500})
  }
}
