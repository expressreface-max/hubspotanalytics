import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  searchAllDeals,
  searchAllContacts,
  isClosedWon,
  dealAmount,
  APPOINTMENT_DATE_PROPS,
  QUOTED_DATE_PROPS,
  UNMAPPED,
  HubSpotError,
} from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Touch = "first" | "last"

type Body = {
  dateFrom?: string
  dateTo?: string
  touch?: Touch
}

// Canonical HubSpot analytics sources, in display order. Anything else falls
// through to "UNKNOWN" (empty/unset source).
const SOURCE_ORDER = [
  "PAID_SEARCH",
  "PAID_SOCIAL",
  "ORGANIC_SEARCH",
  "SOCIAL_MEDIA",
  "EMAIL_MARKETING",
  "REFERRALS",
  "AI_REFERRALS",
  "OTHER_CAMPAIGNS",
  "DIRECT_TRAFFIC",
  "OFFLINE",
]

const SOURCE_LABELS: Record<string, string> = {
  PAID_SEARCH: "Paid Search",
  PAID_SOCIAL: "Paid Social",
  ORGANIC_SEARCH: "Organic Search",
  SOCIAL_MEDIA: "Social Media",
  EMAIL_MARKETING: "Email Marketing",
  REFERRALS: "Referrals",
  AI_REFERRALS: "AI Referrals",
  OTHER_CAMPAIGNS: "Other Campaigns",
  DIRECT_TRAFFIC: "Direct Traffic",
  OFFLINE: "Offline",
  UNKNOWN: "Unknown",
}

// The "latest source" property differs by object type in this portal:
//   contacts -> hs_latest_source, deals -> hs_analytics_latest_source
// "Original source" is hs_analytics_source on both.
const CONTACT_SOURCE = { first: "hs_analytics_source", last: "hs_latest_source" } as const
const DEAL_SOURCE = { first: "hs_analytics_source", last: "hs_analytics_latest_source" } as const

type Cell = { contacts: number; appts: number; won: number; revenue: number }
const emptyCell = (): Cell => ({ contacts: 0, appts: 0, won: 0, revenue: 0 })

function resolveTerritory(p: Record<string, string | null>) {
  const region = (p.er_region || "").trim() || "Unassigned"
  const territory = (p.er_territory || "").trim()
  if (territory && territory.toUpperCase() !== UNMAPPED) {
    return { territory, sub: (p.er_sub_region || "").trim() || "Unassigned", region }
  }
  const zip = (p.zip || "").trim()
  if (zip) return { territory: `ZIP ${zip}`, sub: (p.er_sub_region || "").trim() || "ZIP fallback", region }
  return { territory: UNMAPPED, sub: "Unassigned", region: "Unassigned" }
}

function normalizeSource(raw: string | null | undefined): string {
  const v = (raw || "").trim().toUpperCase()
  return v || "UNKNOWN"
}

// True if a date value falls within [from, to].
function inRange(raw: string | null, from: Date, to: Date): boolean {
  if (!raw) return false
  const t = new Date(raw).getTime()
  return t >= from.getTime() && t <= to.getTime()
}

// True if the deal entered ANY of the given stages (by their hs_v2_date_entered_*
// timestamp) within the window — used for strict "in-period" milestone counting.
function stageEnteredInRange(
  deal: { properties: Record<string, string | null> },
  dateProps: string[],
  from: Date,
  to: Date,
): boolean {
  for (const prop of dateProps) {
    if (inRange(deal.properties[prop] ?? null, from, to)) return true
  }
  return false
}

function buildGroups(field: string, from: Date, to: Date) {
  return [
    {
      filters: [
        { propertyName: field, operator: "GTE", value: String(from.getTime()) },
        { propertyName: field, operator: "LTE", value: String(to.getTime()) },
      ],
    },
  ]
}

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body: Body = await req.json().catch(() => ({}))
  const touch: Touch = body.touch === "last" ? "last" : "first"
  const now = new Date()
  const from = body.dateFrom ? new Date(body.dateFrom) : new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
  const to = body.dateTo ? new Date(body.dateTo) : now

  const contactSourceProp = CONTACT_SOURCE[touch]
  const dealSourceProp = DEAL_SOURCE[touch]

  const territoryProps = ["er_territory", "er_sub_region", "er_region", "zip"]

  try {
    // Sequential to stay under HubSpot's search rate limit. 100 pages (10k, the
    // HubSpot search ceiling) so wide ranges aren't undercounted by the old 4k cap.
    const createdContacts = await searchAllContacts(
      token,
      buildGroups("createdate", from, to),
      ["createdate", ...territoryProps, contactSourceProp],
      100,
    )
    // Dual-pass deals: created-in-range + closed-in-range, deduped by id.
    const dealProps = [
      "dealstage",
      "pipeline",
      "amount",
      "hs_is_closed_won",
      "createdate",
      "closedate",
      ...territoryProps,
      ...APPOINTMENT_DATE_PROPS,
      ...QUOTED_DATE_PROPS,
      dealSourceProp,
    ]
    const createdDeals = await searchAllDeals(token, buildGroups("createdate", from, to), dealProps)
    const closedDeals = await searchAllDeals(token, buildGroups("closedate", from, to), dealProps)

    const dealMap = new Map<string, (typeof createdDeals)[number]>()
    for (const d of [...createdDeals, ...closedDeals]) dealMap.set(d.id, d)
    const deals = Array.from(dealMap.values())

    // Leaf accumulation keyed by region|||sub|||territory, each holding source -> cell.
    type Leaf = { region: string; sub: string; territory: string; bySource: Map<string, Cell> }
    const leaves = new Map<string, Leaf>()
    const sourcesSeen = new Set<string>()

    const cellFor = (region: string, sub: string, territory: string, source: string): Cell => {
      const key = `${region}|||${sub}|||${territory}`
      let leaf = leaves.get(key)
      if (!leaf) {
        leaf = { region, sub, territory, bySource: new Map() }
        leaves.set(key, leaf)
      }
      let cell = leaf.bySource.get(source)
      if (!cell) {
        cell = emptyCell()
        leaf.bySource.set(source, cell)
      }
      sourcesSeen.add(source)
      return cell
    }

    // Contacts created in range -> contacts metric.
    for (const c of createdContacts) {
      const { territory, sub, region } = resolveTerritory(c.properties)
      const source = normalizeSource(c.properties[contactSourceProp])
      cellFor(region, sub, territory, source).contacts++
    }

    // Deals -> appointments, closed won, revenue. IN-PERIOD basis (matches the
    // Funnel + Deal Analysis + HubSpot period reports): appointments count deals
    // whose APPOINTMENT stage-entered date is in the window; won/revenue count
    // deals whose CLOSE DATE is in the window. OR-cascaded so appt >= won holds.
    for (const deal of deals) {
      const p = deal.properties
      const { territory, sub, region } = resolveTerritory(p)
      const source = normalizeSource(p[dealSourceProp])
      const wonInPeriod = isClosedWon(deal) && inRange(p.closedate, from, to)
      const quotedInPeriod = wonInPeriod || stageEnteredInRange(deal, QUOTED_DATE_PROPS, from, to)
      const apptSetInPeriod = quotedInPeriod || stageEnteredInRange(deal, APPOINTMENT_DATE_PROPS, from, to)
      const cell = cellFor(region, sub, territory, source)
      if (apptSetInPeriod) cell.appts++
      if (wonInPeriod) {
        cell.won++
        cell.revenue += dealAmount(deal)
      }
    }

    const addInto = (a: Cell, b: Cell) => {
      a.contacts += b.contacts
      a.appts += b.appts
      a.won += b.won
      a.revenue += b.revenue
    }
    const isEmptyCell = (c: Cell) => !c.contacts && !c.appts && !c.won && !c.revenue

    // Column order: canonical sources that appeared, then any extras, UNKNOWN last.
    const extras = [...sourcesSeen].filter((s) => !SOURCE_ORDER.includes(s) && s !== "UNKNOWN").sort()
    const orderedSeen = [...SOURCE_ORDER.filter((s) => sourcesSeen.has(s)), ...extras]
    if (sourcesSeen.has("UNKNOWN")) orderedSeen.push("UNKNOWN")

    // Pre-compute column totals to drop any source column that is entirely empty.
    const preTotals: Record<string, Cell> = {}
    for (const s of orderedSeen) preTotals[s] = emptyCell()
    for (const leaf of leaves.values()) {
      for (const s of orderedSeen) {
        const cell = leaf.bySource.get(s)
        if (cell) addInto(preTotals[s], cell)
      }
    }
    const sources = orderedSeen.filter((s) => !isEmptyCell(preTotals[s]))

    // Aggregation node holds a cells map (per source) + a running total.
    type Agg = { cells: Record<string, Cell>; total: Cell }
    const mkAgg = (): Agg => {
      const cells: Record<string, Cell> = {}
      for (const s of sources) cells[s] = emptyCell()
      return { cells, total: emptyCell() }
    }
    const addToAgg = (agg: Agg, s: string, cell: Cell) => {
      addInto(agg.cells[s], cell)
      addInto(agg.total, cell)
    }

    type TerrNode = Agg & { name: string }
    type SubNode = Agg & { name: string; territories: Map<string, TerrNode> }
    type RegionNode = Agg & { name: string; subs: Map<string, SubNode> }

    const columnTotals: Record<string, Cell> = {}
    for (const s of sources) columnTotals[s] = emptyCell()
    const grandTotal = emptyCell()

    const regionMap = new Map<string, RegionNode>()

    for (const leaf of leaves.values()) {
      // Build the leaf's per-source cells and skip if the territory has no activity.
      const leafTotal = emptyCell()
      for (const s of sources) addInto(leafTotal, leaf.bySource.get(s) || emptyCell())
      if (isEmptyCell(leafTotal)) continue

      let region = regionMap.get(leaf.region)
      if (!region) {
        region = { name: leaf.region, subs: new Map(), ...mkAgg() }
        regionMap.set(leaf.region, region)
      }
      let sub = region.subs.get(leaf.sub)
      if (!sub) {
        sub = { name: leaf.sub, territories: new Map(), ...mkAgg() }
        region.subs.set(leaf.sub, sub)
      }
      let terr = sub.territories.get(leaf.territory)
      if (!terr) {
        terr = { name: leaf.territory, ...mkAgg() }
        sub.territories.set(leaf.territory, terr)
      }

      for (const s of sources) {
        const cell = leaf.bySource.get(s) || emptyCell()
        addToAgg(terr, s, cell)
        addToAgg(sub, s, cell)
        addToAgg(region, s, cell)
        addInto(columnTotals[s], cell)
        addInto(grandTotal, cell)
      }
    }

    const byWon = (a: Agg, b: Agg) => b.total.won - a.total.won || b.total.revenue - a.total.revenue
    const serializeAgg = (a: Agg) => ({ cells: a.cells, total: a.total })

    const regions = [...regionMap.values()].sort(byWon).map((region) => ({
      name: region.name,
      ...serializeAgg(region),
      subRegions: [...region.subs.values()].sort(byWon).map((sub) => ({
        name: sub.name,
        ...serializeAgg(sub),
        territories: [...sub.territories.values()].sort(byWon).map((terr) => ({
          name: terr.name,
          ...serializeAgg(terr),
        })),
      })),
    }))

    return NextResponse.json({
      source: "hubspot",
      touch,
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      sources,
      sourceLabels: SOURCE_LABELS,
      regions,
      columnTotals,
      grandTotal,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json({ error: (err as Error).message || "Unknown error" }, { status: 500 })
  }
}
