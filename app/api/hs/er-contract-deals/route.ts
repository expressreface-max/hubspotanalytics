import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  DEAL_PROPERTIES,
  searchAllDeals,
  isClosedWon,
  dealAmount,
  dealNumber,
  dealJobTypes,
  jobTypeHasReface,
  jobTypeHasCountertop,
  HubSpotError,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

// Express Reface pipeline id.
const ER_PIPELINE = "default"

type Row = {
  id: string
  name: string
  closeDate: string | null
  jobTypes: string[]
  cabinet: number
  countertop: number
  amount: number
  contract: number
  delta: number
  // True when a reface/countertop amount exists but the job type doesn't list it.
  // A mismatched amount is excluded from the reconciled totals below.
  cabinetMismatch: boolean
  countertopMismatch: boolean
}

type Totals = {
  cabinet: number
  countertop: number
  amount: number
  contract: number
  delta: number
}

function inRange(iso: string | null | undefined, from: number, to: number): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return !Number.isNaN(t) && t >= from && t <= to
}

export async function POST() {
  const token = await getActiveToken()
  if (!token) {
    return NextResponse.json({ configured: false, error: "HubSpot not connected." }, { status: 200 })
  }

  const to = new Date()
  const from = new Date(to.getFullYear() - 1, to.getMonth(), to.getDate())
  const fromMs = from.getTime()
  const toMs = to.getTime()

  // contract_price + job_type are not in the default property set, so request them explicitly.
  const props = [...DEAL_PROPERTIES, "contract_price", "job_type", "closedate", "hs_is_closed_won"]

  const groups = [
    {
      filters: [
        { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
        { propertyName: "closedate", operator: "GTE", value: from.toISOString() },
        { propertyName: "closedate", operator: "LTE", value: to.toISOString() },
        { propertyName: "pipeline", operator: "EQ", value: ER_PIPELINE },
      ],
    },
  ]

  try {
    const deals = await searchAllDeals(token, groups, props)

    const rows: Row[] = []
    for (const d of deals) {
      const p = d.properties
      if (!isClosedWon(d)) continue
      if (!inRange(p.closedate, fromMs, toMs)) continue

      const cabinet = dealNumber(d, "reface_amount")
      const countertop = dealNumber(d, "countertop_amount")
      const amount = dealAmount(d)
      const contract = dealNumber(d, "contract_price")

      // job_type is a multi-select stored as a ";"-separated string.
      const jobTypes = dealJobTypes(d)
      // Flag a category amount that has no matching job type (shared rule).
      const cabinetMismatch = cabinet > 0 && !jobTypeHasReface(d)
      const countertopMismatch = countertop > 0 && !jobTypeHasCountertop(d)

      rows.push({
        id: d.id,
        name: p.dealname || "(unnamed deal)",
        closeDate: p.closedate || null,
        jobTypes,
        cabinet,
        countertop,
        amount,
        contract,
        // Delta of deal amount vs contract amount (positive = deal amount higher).
        delta: amount - contract,
        cabinetMismatch,
        countertopMismatch,
      })
    }

    rows.sort((a, b) => {
      const at = a.closeDate ? Date.parse(a.closeDate) : 0
      const bt = b.closeDate ? Date.parse(b.closeDate) : 0
      return bt - at
    })

    // Totals use job-type-validated amounts: a mismatched cabinet/countertop
    // amount is excluded so cabinet + countertop reconciles against deal amount.
    const totals: Totals = rows.reduce<Totals>(
      (acc, r) => {
        acc.cabinet += r.cabinetMismatch ? 0 : r.cabinet
        acc.countertop += r.countertopMismatch ? 0 : r.countertop
        acc.amount += r.amount
        acc.contract += r.contract
        acc.delta += r.delta
        return acc
      },
      { cabinet: 0, countertop: 0, amount: 0, contract: 0, delta: 0 },
    )

    const mismatchCount = rows.filter((r) => r.cabinetMismatch || r.countertopMismatch).length

    return NextResponse.json({
      configured: true,
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      rows,
      totals,
      mismatchCount,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ configured: true, error: err.message }, { status: 200 })
    }
    return NextResponse.json(
      { configured: true, error: (err as Error)?.message || "Failed to load Express Reface deals." },
      { status: 200 },
    )
  }
}
