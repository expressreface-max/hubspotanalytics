import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  searchAllDeals,
  isClosedWon,
  isClosedLost,
  enteredAnyStage,
  HubSpotError,
  QUOTED_STAGE_IDS,
  QUOTED_DATE_PROPS,
  DEAL_PROPERTIES,
  CONTACT_ADDRESS_PROPERTIES,
  dealAmount,
  pipelineLabel,
  type HubSpotDeal,
} from "@/lib/hubspot"
import { batchFetchAssocIds, batchReadObjects, fetchStageLabelMap } from "@/lib/deal-context"
import { enrichAddressesBatch, realEstateApiConfigured, type PropertyEnrichment } from "@/lib/realestate"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Body = {
  limit?: number
  enrich?: boolean
}

// Normalize a raw zip to its 5-digit form (drops ZIP+4 and stray whitespace).
function normalizeZip(raw: string): string {
  const m = (raw || "").trim().match(/\d{5}/)
  return m ? m[0] : ""
}

// Earliest date the deal entered any Quoted stage — this is the "quote date".
function earliestQuotedTime(deal: HubSpotDeal): number | null {
  let min: number | null = null
  for (const prop of QUOTED_DATE_PROPS) {
    const raw = deal.properties[prop]
    if (!raw) continue
    const t = Date.parse(raw)
    if (!Number.isNaN(t) && (min == null || t < min)) min = t
  }
  return min
}

export type DealStatus = "closed_won" | "closed_lost" | "open"

export type DealByStageRow = {
  dealId: string
  dealName: string | null
  contactId: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  pipeline: string | null
  stageId: string | null
  stageLabel: string | null
  dealStatus: DealStatus
  dealAmount: number
  quotedAt: string | null
  closedAt: string | null
  territory: string | null
  subRegion: string | null
  region: string | null
  enrichment: PropertyEnrichment | null
}

// Deal status sort order for the secondary sort key (open first, then won, then lost —
// matches typical "most actionable first" ordering; adjust if a different order is wanted).
const STATUS_SORT_ORDER: Record<DealStatus, number> = { open: 0, closed_won: 1, closed_lost: 2 }

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body: Body = await req.json().catch(() => ({}))
  const limit = Math.min(Math.max(Number(body.limit) || 300, 1), 1000)
  const enrich = body.enrich !== false

  try {
    // HubSpot caps search at 5 filterGroups, so the 17 quoted-stage date props
    // can't be OR'd directly. Dual-pass by createdate + closedate over a wide
    // lookback, dedupe, then keep deals that actually entered a quoted stage.
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    const LOOKBACK_DAYS = 1460 // ~4 years
    const from = now - LOOKBACK_DAYS * DAY

    const dualFilterGroups = [
      { filters: [{ propertyName: "createdate", operator: "GTE", value: String(from) }] },
      { filters: [{ propertyName: "closedate", operator: "GTE", value: String(from) }] },
    ]

    const dealsDual = await searchAllDeals(token, dualFilterGroups, [...DEAL_PROPERTIES, "hs_is_closed"], 80)

    const seen = new Set<string>()
    const deals: HubSpotDeal[] = []
    for (const d of dealsDual) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      deals.push(d)
    }

    let qualifying = deals.filter((d) => enteredAnyStage(d, QUOTED_STAGE_IDS))

    // Sort: quote date newest first, then deal status, then property year
    // built (desc — newer construction first), then territory (alpha), then
    // owner age (desc). Year built / owner age require enrichment, so the
    // final ordering pass happens after enrichment runs, below.
    qualifying.sort((a, b) => (earliestQuotedTime(b) || 0) - (earliestQuotedTime(a) || 0))
    qualifying = qualifying.slice(0, limit)

    const stageLabels = await fetchStageLabelMap(token)

    // Resolve deal -> contact associations in batch.
    const dealIds = qualifying.map((d) => d.id)
    const assocMap = await batchFetchAssocIds(token, dealIds, "contacts")

    const dealToContact = new Map<string, string>()
    const allContactIds = new Set<string>()
    for (const d of qualifying) {
      const ids = assocMap.get(d.id) || []
      if (ids.length) {
        dealToContact.set(d.id, ids[0])
        allContactIds.add(ids[0])
      }
    }

    const { objects: contacts } = await batchReadObjects(
      token,
      "contacts",
      [...allContactIds],
      CONTACT_ADDRESS_PROPERTIES,
    )
    const contactMap = new Map(contacts.map((c) => [c.id, c]))

    const rows: DealByStageRow[] = qualifying.map((d) => {
      const contactId = dealToContact.get(d.id) || ""
      const c = contactMap.get(contactId)
      const quotedMs = earliestQuotedTime(d)
      const closedMs = d.properties.closedate ? Date.parse(d.properties.closedate) : NaN
      const dealStatus: DealStatus = isClosedWon(d) ? "closed_won" : isClosedLost(d) ? "closed_lost" : "open"

      return {
        dealId: d.id,
        dealName: d.properties.dealname || null,
        contactId,
        firstName: c?.properties.firstname || null,
        lastName: c?.properties.lastname || null,
        email: c?.properties.email || null,
        phone: c?.properties.phone || null,
        address: c?.properties.address || null,
        city: c?.properties.city || null,
        state: c?.properties.state || null,
        zip: normalizeZip(c?.properties.zip || d.properties.zip || ""),
        pipeline: pipelineLabel(d.properties.pipeline),
        stageId: d.properties.dealstage || null,
        stageLabel: stageLabels[d.properties.dealstage || ""] || d.properties.dealstage || null,
        dealStatus,
        dealAmount: dealAmount(d),
        quotedAt: quotedMs ? new Date(quotedMs).toISOString() : null,
        closedAt: Number.isFinite(closedMs) ? new Date(closedMs).toISOString() : null,
        territory: d.properties.er_territory || null,
        subRegion: d.properties.er_sub_region || null,
        region: d.properties.er_region || null,
        enrichment: null,
      }
    })

    const missingAddress = rows.filter((r) => !r.address || !r.zip).length
    const reapiConfigured = realEstateApiConfigured()

    if (enrich && reapiConfigured) {
      const toEnrich = rows.filter((r) => r.address && r.zip)
      const results = await enrichAddressesBatch(
        toEnrich.map((r) => ({
          address: r.address!,
          city: r.city || "",
          state: r.state || "",
          zip: r.zip!,
          firstName: r.firstName || undefined,
          lastName: r.lastName || undefined,
        })),
        5,
      )
      toEnrich.forEach((r, i) => {
        r.enrichment = results[i]
      })
    }

    // Final multi-level sort, applied after enrichment so year-built and
    // owner-age are available: quote date desc -> deal status -> year built
    // desc -> territory asc -> owner age desc.
    rows.sort((a, b) => {
      const qa = a.quotedAt ? Date.parse(a.quotedAt) : 0
      const qb = b.quotedAt ? Date.parse(b.quotedAt) : 0
      if (qb !== qa) return qb - qa

      const sa = STATUS_SORT_ORDER[a.dealStatus]
      const sb = STATUS_SORT_ORDER[b.dealStatus]
      if (sa !== sb) return sa - sb

      const ya = a.enrichment?.property?.yearBuilt ?? -1
      const yb = b.enrichment?.property?.yearBuilt ?? -1
      if (yb !== ya) return yb - ya

      const ta = a.territory || ""
      const tb = b.territory || ""
      if (ta !== tb) return ta.localeCompare(tb)

      const oa = a.enrichment?.owner?.age ?? -1
      const ob = b.enrichment?.owner?.age ?? -1
      return ob - oa
    })

    return NextResponse.json({
      rows,
      total: rows.length,
      totalDealsFetched: deals.length,
      missingAddress,
      reapiConfigured,
      enriched: enrich && reapiConfigured,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ error: err.message }, { status: err.status || 502 })
    }
    return NextResponse.json(
      { error: (err as Error).message || "Failed to load deals by stage" },
      { status: 500 },
    )
  }
}
