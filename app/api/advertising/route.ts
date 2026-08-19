import { NextResponse } from "next/server"
import { sql } from "@/lib/db"
import { ADVERTISING_DATA, type AdSpendRow } from "@/data/advertising-data"

export const dynamic = "force-dynamic"

function normalize(rows: any[]): AdSpendRow[] {
  return rows
    .map((r) => ({
      month: String(r.month),
      digital: Number(r.digital) || 0,
      television: Number(r.television) || 0,
      print: Number(r.print) || 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

export async function GET() {
  try {
    const rows = await sql`
      select month, digital, television, print
      from public.advertising_spend
      order by month asc
    `
    return NextResponse.json({ rows: normalize(rows as any[]), source: "db" })
  } catch (err) {
    console.log("[v0] advertising GET fell back to static:", (err as Error).message)
    // Fallback so the page still renders if the DB is unreachable.
    return NextResponse.json({ rows: normalize(ADVERTISING_DATA as any[]), source: "static" })
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export async function POST(req: Request) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const month = String(body?.month ?? "").trim()
  if (!MONTH_RE.test(month)) {
    return NextResponse.json({ error: "month must be in YYYY-MM format" }, { status: 400 })
  }

  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : NaN
  }
  const digital = num(body?.digital)
  const television = num(body?.television)
  const print = num(body?.print)
  if ([digital, television, print].some((n) => Number.isNaN(n))) {
    return NextResponse.json({ error: "digital, television and print must be non-negative numbers" }, { status: 400 })
  }

  try {
    const [row] = await sql`
      insert into public.advertising_spend (month, digital, television, print, updated_at)
      values (${month}, ${digital}, ${television}, ${print}, now())
      on conflict (month) do update
        set digital = excluded.digital,
            television = excluded.television,
            print = excluded.print,
            updated_at = now()
      returning month, digital, television, print
    `
    return NextResponse.json({ row })
  } catch (err) {
    console.log("[v0] advertising POST error:", (err as Error).message)
    return NextResponse.json({ error: "Failed to save advertising month" }, { status: 500 })
  }
}
