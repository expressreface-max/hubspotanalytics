import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import {
  searchAllDeals,
  isClosedWon,
  enteredAnyStage,
  HubSpotError,
  QUOTED_STAGE_IDS,
  QUOTED_DATE_PROPS,
  DEAL_PROPERTIES,
  CONTACT_ADDRESS_PROPERTIES,
  dealAmount,
  type HubSpotDeal,
} from "@/lib/hubspot"
import { batchFetchAssocIds, batchReadObjects } from "@/lib/deal-context"
import { enrichAddressesBatch, realEstateApiConfigured, type PropertyEnrichment } from "@/lib/realestate"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Scope = "ever_quoted" | "closed_won"

type Body = {
  scope?: Scope
  limit?: number
  enrich?: boolean
}

// Normalize a raw zip to its 5-digit form (drops ZIP+4 and stray whitespace).
function normalizeZip(raw: string): string {
  const m = (raw || "").trim().match(/\d{5}/)
  return m ? m[0] : ""
}

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

export type CustomerAnalysisRow = {
  contactId: string
  dealId: string
  dealName: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  dealAmount: number
  quotedAt: string | null
  closedWon: boolean
  closedAt: string | null
  enrichment: PropertyEnrichment | null
}

export async function POST(req: Request) {
  const token = getActiveToken(req)
  if (!token) return NextResponse.json({ error: "No HubSpot token configured" }, { status: 401 })

  const body: Body = await req.json().catch(() => ({}))
  const scope: Scope = body.scope === "closed_won" ? "closed_won" : "ever_quoted"
  const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 1000)
  const enrich = body.enrich !== false

  try {
    // HubSpot caps search at 5 filterGroups, so we can't OR the 17
    // quoted-stage date props directly (same constraint documented in
    // app/api/hs/quote-analysis/route.ts). Instead, dual-pass by createdate
    // and closedate over a wide lookback, dedupe, then keep deals that
    // actually entered a quoted stage per enteredAnyStage().
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    const LOOKBACK_DAYS = 1460 // ~4 years — covers the full quoted-customer history
    const from = now - LOOKBACK_DAYS * DAY

    const dualFilterGroups = [
      { filters: [{ propertyName: "createdate", operator: "GTE", value: String(from) }] },
      { filters: [{ propertyName: "closedate", operator: "GTE", value: String(from) }] },
    ]

    const dealsDual = await searchAllDeals(token, dualFilterGroups, DEAL_PROPERTIES, 80)

    const seen = new Set<string>()
    const deals: HubSpotDeal[] = []
    for (const d of dealsDual) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      deals.push(d)
    }

    let qualifying = deals.filter((d) => enteredAnyStage(d, QUOTED_STAGE_IDS))
    if (scope === "closed_won") qualifying = qualifying.filter(isClosedWon)

    // Most recent quoted deal per contact wins if a contact has multiple —
    // sort newest first so we keep the latest engagement.
    qualifying.sort((a, b) => (earliestQuotedTime(b) || 0) - (earliestQuotedTime(a) || 0))
    qualifying = qualifying.slice(0, limit)

    // Resolve deal -> contact associations in batch.
    const dealIds = qualifying.map((d) => d.id)
    const assocMap = await batchFetchAssocIds(token, dealIds, "contacts")

    // One representative contact id per deal (first association).
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

    const rows: CustomerAnalysisRow[] = qualifying.map((d) => {
      const contactId = dealToContact.get(d.id) || ""
      const c = contactMap.get(contactId)
      const quotedMs = earliestQuotedTime(d)
      const closedMs = d.properties.closedate ? Date.parse(d.properties.closedate) : NaN
      return {
        contactId,
        dealId: d.id,
        dealName: d.properties.dealname || null,
        firstName: c?.properties.firstname || null,
        lastName: c?.properties.lastname || null,
        email: c?.properties.email || null,
        phone: c?.properties.phone || null,
        address: c?.properties.address || null,
        city: c?.properties.city || null,
        state: c?.properties.state || null,
        zip: normalizeZip(c?.properties.zip || d.properties.zip || ""),
        dealAmount: dealAmount(d),
        quotedAt: quotedMs ? new Date(quotedMs).toISOString() : null,
        closedWon: isClosedWon(d),
        closedAt: Number.isFinite(closedMs) ? new Date(closedMs).toISOString() : null,
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

    return NextResponse.json({
      scope,
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
      { error: (err as Error).message || "Failed to load customer analysis" },
      { status: 500 },
    )
  }
}
