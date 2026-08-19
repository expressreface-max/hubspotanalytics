import { NextResponse } from "next/server"
import { readStoredMetrics } from "@/lib/sales-metrics"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const data = await readStoredMetrics()
    return NextResponse.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read sales metrics."
    return NextResponse.json({ rows: [], updatedAt: null, error: message }, { status: 200 })
  }
}
