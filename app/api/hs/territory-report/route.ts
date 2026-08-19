import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  hsFetch,
  searchAllDeals,
  searchAllContacts,
  fetchOwnerMap,
  isClosedWon,
  dealAmount,
  refaceAmountForJob,
  countertopAmountForJob,
  pipelineAbbrev,
  APPOINTMENT_STAGE_IDS,
  QUOTED_STAGE_IDS,
  QUOTED_DATE_PROPS,
  APPOINTMENT_DATE_PROPS,
  enteredAnyStage,
  UNMAPPED,
  HubSpotError,
  type HubSpotDeal,
} from "@/lib/hubspot"
import { householdsFor } from "@/data/territory-households"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Body = {
  dateFrom?: string
  dateTo?: string
  pipelines?: string[]
}

type Metrics = {
  contactsCreated: number
  created: number
  apptSet: number
  quoted: number
  closedWon: number
  revenue: number
}

function emptyMetrics(): Metrics {
  return { contactsCreated: 0, created: 0, apptSet: 0, quoted: 0, closedWon: 0, revenue: 0 }
}

// Resolve the er_* territory chain for any record (deal or contact),
// applying the ZIP fallback when no territory is mapped.
function resolveTerritory(p: Record<string, string | null>) {
  const territory = (p.er_territory || "").trim()
  if (territory && territory.toUpperCase() !== UNMAPPED) {
    return {
      territory,
      sub: (p.er_sub_region || "").trim() || "Unassigned",
      region: (p.er_region || "").trim() || "Unassigned",
      superRegion: (p.er_super_region || "").trim() || "Unassigned",
    }
  }
  const zip = (p.zip || "").trim()
  if (zip) {
    return {
      territory: `ZIP ${zip}`,
      sub: (p.er_sub_region || "").trim() || "ZIP fallback",
      region: (p.er_region || "").trim() || "Unassigned",
      superRegion: (p.er_super_region || "").trim() || "Unassigned",
    }
  }
  return { territory: UNMAPPED, sub: "Unassigned", region: "Unassigned", superRegion: "Unassigned" }
}

// Ensure the super-region > region > sub-region > territory chain exists,
// returning all four nodes so a metric can be incremented on each level.
function ensureChain(
  tree: Map<string, any>,
  superRegion: string,
  region: string,
  sub: string,
  territory: string,
) {
  let sr = tree.get(superRegion)
  if (!sr) {
    sr = { name: superRegion, metrics: emptyMetrics(), wonByPipeline: {}, children: new Map() }
    tree.set(superRegion, sr)
  }
  let rg = sr.children.get(region)
  if (!rg) {
    rg = { name: region, metrics: emptyMetrics(), wonByPipeline: {}, children: new Map() }
    sr.children.set(region, rg)
  }
  let sb = rg.children.get(sub)
  if (!sb) {
    sb = { name: sub, metrics: emptyMetrics(), wonByPipeline: {}, children: new Map() }
    rg.children.set(sub, sb)
  }
  let tr = sb.children.get(territory)
  if (!tr) {
    tr = { name: territory, metrics: emptyMetrics(), wonByPipeline: {} }
    sb.children.set(territory, tr)
  }
  return [sr, rg, sb, tr]
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Build search filter groups for a given date field + range + pipelines.
function buildGroups(field: string, from: Date, to: Date, pipelines?: string[]) {
  const base = [
    { propertyName: field, operator: "GTE", value: String(from.getTime()) },
    { propertyName: field, operator: "LTE", value: String(to.getTime()) },
  ]
  return pipelines && pipelines.length
    ? pipelines.map((p) => ({ filters: [...base, { propertyName: "pipeline", operator: "EQ", value: p }] }))
    : [{ filters: base }]
}

// Contacts are not tied to a pipeline, so this is a simple created-in-range filter.
function buildContactGroups(from: Date, to: Date) {
  return [
    {
      filters: [
        { propertyName: "createdate", operator: "GTE", value: String(from.getTime()) },
        { propertyName: "createdate", operator: "LTE", value: String(to.getTime()) },
      ],
    },
  ]
}

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body: Body = await req.json().catch(() => ({}))
  const now = new Date()
  const from = body.dateFrom ? new Date(body.dateFrom) : new Date(now.getFullYear(), 0, 1)
  const to = body.dateTo ? new Date(body.dateTo) : now

  try {
    // Dual-pass fetch: deals created in range + deals closed in range. Dedupe by id.
    // Run sequentially (not in parallel) so we don't double the search request
    // rate and trip HubSpot's per-second search limit.
    const createdDeals = await searchAllDeals(token, buildGroups("createdate", from, to, body.pipelines))
    const closedDeals = await searchAllDeals(token, buildGroups("closedate", from, to, body.pipelines))

    // Separate top-of-funnel query: contacts created in range. Contacts are not
    // tied to a pipeline, so this count is independent of the pipeline filter and
    // is rolled up by the contact's own er_* territory fields (ZIP fallback).
    // Contacts can exceed the previous 40-page (4,000) cap for wide ranges
    // (e.g. trailing 12 months ~8,700), which silently undercounted the
    // top-of-funnel and every "% of contacts" conversion. HubSpot search tops
    // out at 10,000 results, so 100 pages covers the full window.
    const createdContacts = await searchAllContacts(token, buildContactGroups(from, to), undefined, 100)

    // Owner id -> name, for the "By Sales Rep" rollup.
    const ownerMap = await fetchOwnerMap(token)

    const dealMap = new Map<string, HubSpotDeal>()
    for (const d of [...createdDeals, ...closedDeals]) dealMap.set(d.id, d)
    const deals = Array.from(dealMap.values())

    // Identify deals with no territory mapping for contact fallback.
    const unmapped = deals.filter((d) => {
      const t = (d.properties.er_territory || "").trim()
      return !t || t.toUpperCase() === UNMAPPED
    })

    await patchFromContacts(token, unmapped)

    // Roll up into super_region > region > sub_region > territory.
    const tree = new Map<string, any>()
    const totals = emptyMetrics()
    // Strict "in-period" totals: milestones counted only when their OWN date
    // falls inside the window. Contacts/created are already window-scoped;
    // quoted uses the quoted-stage entered date, closed won uses the close date.
    // Appt set + revenue are intentionally left as-reported (copied post-loop).
    const inPeriodTotals = emptyMetrics()
    // Cohort analysis: for deals CREATED in the window, track how many reached
    // each milestone DURING the window vs AFTER the window end. Revenue split
    // the same way. Denominator for percentages is deals created in period.
    const cohort = {
      contactsCreated: 0,
      created: 0,
      apptDuring: 0,
      apptAfter: 0,
      quotedDuring: 0,
      quotedAfter: 0,
      wonDuring: 0,
      wonAfter: 0,
      revenueDuring: 0,
      revenueAfter: 0,
      // Won revenue split by product field, with job counts, per during/after bucket.
      refaceRevDuring: 0,
      refaceRevAfter: 0,
      refaceCountDuring: 0,
      refaceCountAfter: 0,
      countertopRevDuring: 0,
      countertopRevAfter: 0,
      countertopCountDuring: 0,
      countertopCountAfter: 0,
    }
    // Won-revenue split by product amount fields (reface vs countertop). `total`
    // is the full won revenue; reface + countertop only cover deals where those
    // fields are populated, so they typically sum to less than the total.
    // `refaceCount`/`countertopCount` = number of won deals with a populated
    // (non-null, > 0) amount in that field — used for revenue-per-job.
    const revenueSplit = { reface: 0, countertop: 0, total: 0, refaceCount: 0, countertopCount: 0 }
    const inPeriodRevenueSplit = { reface: 0, countertop: 0, total: 0, refaceCount: 0, countertopCount: 0 }
    let unmappedRemaining = 0

    // Per-sales-rep (deal owner) rollup: deals created, appts, closed won, revenue.
    const repMap = new Map<
      string,
      {
        name: string
        created: number
        apptSet: number
        quoted: number
        closedWon: number
        revenue: number
        deals: {
          id: string
          name: string
          amount: number
          appt: boolean
          quoted: boolean
          won: boolean
          currentlyQuoted: boolean
          currentlyAppt: boolean
          quotedEnteredMs: number | null
          territory: string
        }[]
      }
    >()

    for (const deal of deals) {
      const p = deal.properties
      const { territory, sub, region, superRegion } = resolveTerritory(p)

      if (territory === UNMAPPED) unmappedRemaining++

      const createdInRange = inRange(p.createdate, from, to)
      const won = isClosedWon(deal)
      // Funnel milestones are "ever reached", derived from HubSpot stage history
      // (hs_v2_date_entered_*), NOT the deal's current stage. A won deal now in a
      // fulfillment stage — or a deal that later went lost — still counts as
      // having set an appointment / been quoted. This guarantees appt >= quoted >= won.
      const quoted = won || enteredAnyStage(deal, QUOTED_STAGE_IDS)
      const apptSet = quoted || enteredAnyStage(deal, APPOINTMENT_STAGE_IDS)
      const amount = won ? dealAmount(deal) : 0
      // Product amounts are job-type-validated: cabinet counts only on Reface jobs,
      // countertop only on Countertop jobs (operator rule). This stops a countertop
      // amount mis-keyed on a Reface-only job from inflating the split past revenue.
      const refaceAmt = won ? refaceAmountForJob(deal) : 0
      const counterAmt = won ? countertopAmountForJob(deal) : 0
      const abbrev = pipelineAbbrev(p.pipeline)

      // totals
      if (createdInRange) totals.created++
      if (apptSet) totals.apptSet++
      if (quoted) totals.quoted++
      if (won) {
        totals.closedWon++
        totals.revenue += amount
        revenueSplit.reface += refaceAmt
        revenueSplit.countertop += counterAmt
        revenueSplit.total += amount
        if (refaceAmt > 0) revenueSplit.refaceCount++
        if (counterAmt > 0) revenueSplit.countertopCount++
      }

      // In-period (strict) closed won + quoted. Closed won counts only deals
      // whose CLOSE DATE is in the window; quoted counts deals that ENTERED a
      // quoted stage in the window (OR'd with in-period won so quoted >= won).
      const wonInPeriod = won && inRange(p.closedate, from, to)
      const quotedInPeriod = wonInPeriod || stageEnteredInRange(deal, QUOTED_DATE_PROPS, from, to)
      // In-period appt set = deals whose APPOINTMENT stage-entered date falls in
      // the window (OR'd with in-period quoted so apptSet >= quoted). This differs
      // from as-reported apptSet, which counts any deal in the created∪closed set
      // that EVER set an appointment — inflating a year when deals created earlier
      // but closed in-window drag in appointments set in a prior year.
      const apptSetInPeriod = quotedInPeriod || stageEnteredInRange(deal, APPOINTMENT_DATE_PROPS, from, to)
      if (apptSetInPeriod) inPeriodTotals.apptSet++
      if (quotedInPeriod) inPeriodTotals.quoted++
      if (wonInPeriod) {
        inPeriodTotals.closedWon++
        inPeriodRevenueSplit.reface += refaceAmt
        inPeriodRevenueSplit.countertop += counterAmt
        inPeriodRevenueSplit.total += amount
        if (refaceAmt > 0) inPeriodRevenueSplit.refaceCount++
        if (counterAmt > 0) inPeriodRevenueSplit.countertopCount++
      }

      // Cohort of deals created in the window: bucket each milestone by whether
      // its date is within the window ("during") or past the window end ("after").
      // Effective dates cascade so the funnel stays monotonic (a won date implies
      // quoted/appt no later than it, even if a stage timestamp is missing).
      if (createdInRange) {
        cohort.created++
        const wonT = won ? toTime(p.closedate) : null
        const quotedT = minTime(earliestStageDate(deal, QUOTED_DATE_PROPS), wonT)
        const apptT = minTime(earliestStageDate(deal, APPOINTMENT_DATE_PROPS), quotedT)
        const apptB = bucket(apptSet ? apptT : null, to)
        const quotedB = bucket(quoted ? quotedT : null, to)
        const wonB = bucket(won ? wonT : null, to)
        if (apptB === "during") cohort.apptDuring++
        else if (apptB === "after") cohort.apptAfter++
        if (quotedB === "during") cohort.quotedDuring++
        else if (quotedB === "after") cohort.quotedAfter++
        if (wonB === "during") {
          cohort.wonDuring++
          cohort.revenueDuring += amount
          cohort.refaceRevDuring += refaceAmt
          cohort.countertopRevDuring += counterAmt
          if (refaceAmt > 0) cohort.refaceCountDuring++
          if (counterAmt > 0) cohort.countertopCountDuring++
        } else if (wonB === "after") {
          cohort.wonAfter++
          cohort.revenueAfter += amount
          cohort.refaceRevAfter += refaceAmt
          cohort.countertopRevAfter += counterAmt
          if (refaceAmt > 0) cohort.refaceCountAfter++
          if (counterAmt > 0) cohort.countertopCountAfter++
        }
      }

      // Territory hierarchy is IN-PERIOD: each milestone counts only when its own
      // action happened in the window (appt/quoted stage entered in range, close
      // date in range), matching HubSpot's period reports. Created is already
      // window-scoped by the search date filter.
      const [sr, rg, sb, tr] = ensureChain(tree, superRegion, region, sub, territory)
      for (const node of [sr, rg, sb, tr]) {
        if (createdInRange) node.metrics.created++
        if (apptSetInPeriod) node.metrics.apptSet++
        if (quotedInPeriod) node.metrics.quoted++
        if (wonInPeriod) {
          node.metrics.closedWon++
          node.metrics.revenue += amount
          node.wonByPipeline[abbrev] = (node.wonByPipeline[abbrev] || 0) + 1
        }
      }

      // Sales-rep (deal owner) rollup.
      const ownerId = (p.hubspot_owner_id || "").trim()
      const repKey = ownerId || "unassigned"
      let rep = repMap.get(repKey)
      if (!rep) {
        rep = {
          name: ownerId ? ownerMap[ownerId] || `Owner ${ownerId}` : "Unassigned",
          created: 0,
          apptSet: 0,
          quoted: 0,
          closedWon: 0,
          revenue: 0,
          deals: [],
        }
        repMap.set(repKey, rep)
      }
      // Sales-rep rollup is IN-PERIOD too (same basis as the hierarchy above).
      if (createdInRange) rep.created++
      if (apptSetInPeriod) rep.apptSet++
      if (quotedInPeriod) rep.quoted++
      if (wonInPeriod) {
        rep.closedWon++
        rep.revenue += amount
      }
      // Deal-level detail for the rep. The rep-row COUNTS stay in-period (funnel
      // activity in the window), but the expandable detail groups are CURRENT-STATE:
      //   - Quoted (open)  = deal's CURRENT dealstage is a Quoted stage right now
      //   - Appointment    = deal's CURRENT dealstage is an Appointment-scheduled stage
      // so we also push deals that are currently sitting in those stages even if their
      // in-period milestone flags are false. quotedEnteredMs drives "days in quoted".
      const currentStage = p.dealstage || ""
      const currentlyQuoted = QUOTED_STAGE_IDS.has(currentStage)
      const currentlyAppt = APPOINTMENT_STAGE_IDS.has(currentStage)
      if (apptSetInPeriod || currentlyQuoted || currentlyAppt) {
        rep.deals.push({
          id: deal.id,
          name: p.dealname || `Deal ${deal.id}`,
          amount: wonInPeriod ? amount : dealAmount(deal),
          appt: apptSetInPeriod,
          quoted: quotedInPeriod,
          won: wonInPeriod,
          currentlyQuoted,
          currentlyAppt,
          quotedEnteredMs: currentlyQuoted ? earliestStageDate(deal, QUOTED_DATE_PROPS) : null,
          territory,
        })
      }
    }

    // Roll up contacts created in range as a separate top-of-funnel metric.
    for (const contact of createdContacts) {
      const { territory, sub, region, superRegion } = resolveTerritory(contact.properties)
      totals.contactsCreated++
      const [sr, rg, sb, tr] = ensureChain(tree, superRegion, region, sub, territory)
      for (const node of [sr, rg, sb, tr]) node.metrics.contactsCreated++
    }

    // Contacts + deals-created are already scoped to the window by their search
  // date filter, so their in-period counts equal the as-reported counts.
  // Appt set + closed won are computed in the loop (window-scoped by stage-entered
  // / close date); in-period revenue = won revenue for deals CLOSED in the window.
  inPeriodTotals.contactsCreated = totals.contactsCreated
  inPeriodTotals.created = totals.created
  inPeriodTotals.revenue = inPeriodRevenueSplit.total

    // Contacts created in the window are all "during" by definition.
    cohort.contactsCreated = totals.contactsCreated

    const serialize = (node: any): any => ({
      name: node.name,
      metrics: node.metrics,
      wonByPipeline: node.wonByPipeline,
      children: node.children
        ? Array.from(node.children.values())
            .map(serialize)
            .sort((a: any, b: any) => b.metrics.closedWon - a.metrics.closedWon)
        : undefined,
    })

    const hierarchy = Array.from(tree.values())
      .map(serialize)
      .sort((a: any, b: any) => b.metrics.closedWon - a.metrics.closedWon)

    // Flatten the tree into per-level lists for the top-N panels + penetration.
    const territoryNodes: any[] = []
    const subRegionNodes: any[] = []
    const regionNodes: any[] = []
    for (const sr of tree.values()) {
      for (const rg of sr.children.values()) {
        regionNodes.push(rg)
        for (const sb of rg.children.values()) {
          subRegionNodes.push(sb)
          for (const tr of sb.children.values()) {
            territoryNodes.push(tr)
          }
        }
      }
    }

    // Send all metrics per row so the client can re-rank by the selected tab
    // (contacts created / appointments / revenue). Lists are small enough
    // (territories ~67, sub-regions/regions fewer) to send un-sliced.
    const panelRow = (n: any) => ({
      name: n.name,
      contactsCreated: n.metrics.contactsCreated,
      apptSet: n.metrics.apptSet,
      closedWon: n.metrics.closedWon,
      revenue: n.metrics.revenue,
    })

    const topTerritories = territoryNodes.map(panelRow)
    const topSubRegions = subRegionNodes.map(panelRow)
    const topRegions = regionNodes.map(panelRow)

    // Sales-rep breakdown, default-sorted by revenue (client can re-rank).
    const byRep = Array.from(repMap.values()).sort((a, b) => b.revenue - a.revenue)
    // Order each rep's deals by milestone (won → quoted → appt), then by amount.
    const milestoneRank = (d: { won: boolean; quoted: boolean }) => (d.won ? 0 : d.quoted ? 1 : 2)
    for (const rep of byRep) {
      rep.deals.sort((a, b) => milestoneRank(a) - milestoneRank(b) || b.amount - a.amount)
    }

    // Territory penetration = jobs won / owner-occupied households, ranked.
    const penetration = territoryNodes
      .map((n) => {
        const households = householdsFor(n.name)
        if (!households) return null
        const jobs = n.metrics.closedWon
        return {
          territory: n.name,
          households,
          jobs,
          penetration: jobs / households,
          dollarsPerHousehold: n.metrics.revenue / households,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.penetration - a.penetration)

    return NextResponse.json({
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      totals,
      inPeriodTotals,
      revenueSplit,
      inPeriodRevenueSplit,
      cohort,
      dealCount: deals.length,
      contactCount: createdContacts.length,
      unmappedRemaining,
      hierarchy,
      topTerritories,
      topSubRegions,
      topRegions,
      penetration,
      byRep,
    })
  } catch (err) {
    const status = err instanceof HubSpotError ? err.status : 500
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}

function inRange(raw: string | null, from: Date, to: Date): boolean {
  if (!raw) return false
  const t = new Date(raw).getTime()
  return t >= from.getTime() && t <= to.getTime()
}

// True if the deal entered ANY of the given stages (by their hs_v2_date_entered_*
// timestamp) within the window — used for strict "in-period" milestone counting.
function stageEnteredInRange(deal: HubSpotDeal, dateProps: string[], from: Date, to: Date): boolean {
  for (const prop of dateProps) {
    if (inRange(deal.properties[prop] ?? null, from, to)) return true
  }
  return false
}

// Parse a HubSpot date value to epoch ms, or null.
function toTime(raw: string | null | undefined): number | null {
  if (!raw) return null
  const t = new Date(raw).getTime()
  return isNaN(t) ? null : t
}

// Smallest of two nullable timestamps.
function minTime(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

// Earliest hs_v2_date_entered_* timestamp across the given stage props.
function earliestStageDate(deal: HubSpotDeal, dateProps: string[]): number | null {
  let min: number | null = null
  for (const prop of dateProps) {
    min = minTime(min, toTime(deal.properties[prop]))
  }
  return min
}

// Classify a milestone timestamp relative to the window end: "during" if on or
// before the window end, "after" if past it, null if the milestone wasn't reached.
function bucket(t: number | null, to: Date): "during" | "after" | null {
  if (t === null) return null
  return t <= to.getTime() ? "during" : "after"
}

// For unmapped deals, look up the associated contact and patch er_* fields
// (or fall back to ZIP). Batched to stay within time limits.
async function patchFromContacts(token: string, unmapped: HubSpotDeal[]) {
  if (!unmapped.length) return
  // Cap the number of unmapped lookups to avoid timeouts on huge ranges.
  const subset = unmapped.slice(0, 500)

  const dealToContact = new Map<string, string>()

  for (const batch of chunk(subset, 100)) {
    try {
      const assoc = await hsFetch<{ results: any[] }>(
        "/crm/v4/associations/deals/contacts/batch/read",
        {
          token,
          method: "POST",
          body: JSON.stringify({ inputs: batch.map((d) => ({ id: d.id })) }),
        },
      )
      for (const r of assoc.results || []) {
        const dealId = r.from?.id
        const contactId = r.to?.[0]?.toObjectId
        if (dealId && contactId) dealToContact.set(dealId, String(contactId))
      }
    } catch {
      // association lookups are best-effort
    }
  }

  const contactIds = Array.from(new Set(dealToContact.values()))
  const contactProps = new Map<string, Record<string, string | null>>()

  for (const batch of chunk(contactIds, 100)) {
    try {
      const data = await hsFetch<{ results: any[] }>("/crm/v3/objects/contacts/batch/read", {
        token,
        method: "POST",
        body: JSON.stringify({
          properties: ["er_territory", "er_sub_region", "er_region", "er_super_region", "zip"],
          inputs: batch.map((id) => ({ id })),
        }),
      })
      for (const c of data.results || []) contactProps.set(String(c.id), c.properties || {})
    } catch {
      // best-effort
    }
  }

  for (const deal of subset) {
    const contactId = dealToContact.get(deal.id)
    if (!contactId) continue
    const cp = contactProps.get(contactId)
    if (!cp) continue
    const t = (cp.er_territory || "").trim()
    if (t && t.toUpperCase() !== UNMAPPED) {
      deal.properties.er_territory = cp.er_territory
      deal.properties.er_sub_region = cp.er_sub_region
      deal.properties.er_region = cp.er_region
      deal.properties.er_super_region = cp.er_super_region
    } else if ((cp.zip || "").trim()) {
      deal.properties.er_territory = `ZIP ${cp.zip}`
      deal.properties.er_sub_region = deal.properties.er_sub_region || "ZIP fallback"
    }
  }
}
