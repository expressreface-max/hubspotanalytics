import "server-only"
import { sql } from "@/lib/db"
import {
  searchAllDeals,
  enteredAnyStage,
  isClosedWon,
  isClosedLost,
  QUOTED_STAGE_IDS,
  QUOTED_DATE_PROPS,
  DEAL_PROPERTIES,
  CONTACT_ADDRESS_PROPERTIES,
  HubSpotError,
  type HubSpotDeal,
} from "@/lib/hubspot"
import { batchFetchAssocIds, batchReadObjects } from "@/lib/deal-context"
import { realEstateApiConfigured, RealEstateApiError } from "@/lib/realestate"
import { emptyDealEnrichment, type DealDetailEnrichment } from "@/lib/reapi-deal-enrichment-types"

// Deal-keyed enrichment pipeline. Nightly cron target: pick up any deal that
// has entered a Quoted stage or closed (won/lost) and doesn't have a row in
// reapi_deal_enrichment yet, then look up property + owner data and store it
// keyed by deal_id (a contact can back multiple deals, so contact_id alone
// isn't a safe key for deal-level analysis).

const REAPI_BASE = "https://api.realestateapi.com"

function getApiKey(): string | null {
  return process.env.REALESTATEAPI_KEY || null
}

function normalizeAddressKey(address: string, city: string, state: string, zip: string): string {
  return [address, city, state, zip]
    .map((s) => (s || "").trim().toLowerCase().replace(/\s+/g, " "))
    .join("|")
}

function parseNum(v: any): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "string" ? Number(v.replace(/[,$]/g, "")) : Number(v)
  return Number.isFinite(n) ? n : null
}

function parseDate(v: any): string | null {
  if (!v) return null
  const m = String(v).match(/^\d{4}-\d{2}-\d{2}/)
  return m ? m[0] : null
}

async function reapiFetch<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = getApiKey()
  if (!key) throw new RealEstateApiError("RealEstateAPI key is not configured", 401)
  const res = await fetch(`${REAPI_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // fall through
  }
  if (!res.ok) {
    const msg = json?.statusMessage || json?.message || text || res.statusText
    throw new RealEstateApiError(`RealEstateAPI ${res.status}: ${msg}`, res.status)
  }
  return json as T
}

export type DealEnrichCandidate = {
  dealId: string
  contactId: string
  firstName: string | null
  lastName: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  erTerritory: string | null
  erSubRegion: string | null
  erRegion: string | null
  dealStage: string | null
}

function normalizeZip(raw: string): string {
  const m = (raw || "").trim().match(/\d{5}/)
  return m ? m[0] : ""
}

// Deals that have ever entered a Quoted stage or are closed (won or lost).
// Mirrors the scope used by app/api/hs/customer-analysis/route.ts.
export async function findQuotedOrClosedDeals(token: string): Promise<HubSpotDeal[]> {
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  const LOOKBACK_DAYS = 1460
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

  return deals.filter((d) => enteredAnyStage(d, QUOTED_STAGE_IDS) || isClosedWon(d) || isClosedLost(d))
}

// Resolve contact + address for a set of deals not yet in reapi_deal_enrichment.
export async function resolveEnrichmentCandidates(
  token: string,
  deals: HubSpotDeal[],
): Promise<DealEnrichCandidate[]> {
  if (!deals.length) return []

  const dealIds = deals.map((d) => d.id)
  const assocMap = await batchFetchAssocIds(token, dealIds, "contacts")

  const dealToContact = new Map<string, string>()
  const allContactIds = new Set<string>()
  for (const d of deals) {
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

  return deals.map((d) => {
    const contactId = dealToContact.get(d.id) || ""
    const c = contactMap.get(contactId)
    return {
      dealId: d.id,
      contactId,
      firstName: c?.properties.firstname || null,
      lastName: c?.properties.lastname || null,
      address: c?.properties.address || null,
      city: c?.properties.city || null,
      state: c?.properties.state || null,
      zip: normalizeZip(c?.properties.zip || d.properties.zip || ""),
      erTerritory: d.properties.er_territory || null,
      erSubRegion: d.properties.er_sub_region || null,
      erRegion: d.properties.er_region || null,
      dealStage: d.properties.dealstage || null,
    }
  })
}

// Deal ids already present in reapi_deal_enrichment (any source).
export async function getAlreadyEnrichedDealIds(dealIds: string[]): Promise<Set<string>> {
  if (!dealIds.length) return new Set()
  const rows = await sql`
    SELECT deal_id FROM reapi_deal_enrichment WHERE deal_id = ANY(${dealIds})
  `
  return new Set(rows.map((r: any) => String(r.deal_id)))
}

export type EnrichOneResult = {
  ok: boolean
  apiCallsMade: number // 0, 1 (one endpoint failed/skipped), or 2
  error?: string
}

// Look up PropertyDetail + SkipTrace for one candidate and upsert into
// reapi_deal_enrichment. Also mirrors into the address-keyed
// customer_property_enrichment cache so the legacy live-enrichment path
// (lib/realestate.ts) benefits from the same lookup instead of re-fetching.
export async function enrichAndStoreDeal(c: DealEnrichCandidate): Promise<EnrichOneResult> {
  if (!c.address || !c.zip) {
    await sql`
      INSERT INTO reapi_deal_enrichment (deal_id, contact_id, address, city, state, zip, er_territory, er_sub_region, er_region, deal_stage_at_enrich, property_fetch_error, owner_fetch_error, source)
      VALUES (${c.dealId}, ${c.contactId}, ${c.address}, ${c.city}, ${c.state}, ${c.zip}, ${c.erTerritory}, ${c.erSubRegion}, ${c.erRegion}, ${c.dealStage}, 'No street address on file', 'No street address on file', 'nightly_cron')
      ON CONFLICT (deal_id) DO UPDATE SET
        property_fetch_error = EXCLUDED.property_fetch_error,
        owner_fetch_error = EXCLUDED.owner_fetch_error,
        fetched_at = now()
    `
    return { ok: true, apiCallsMade: 0 }
  }

  const addressKey = normalizeAddressKey(c.address, c.city || "", c.state || "", c.zip)
  let apiCallsMade = 0

  let propertyRaw: any = null
  let propertyError: string | null = null
  try {
    propertyRaw = await reapiFetch("/v2/PropertyDetail", {
      address: `${c.address}, ${c.city}, ${c.state} ${c.zip}`,
    })
    apiCallsMade++
  } catch (e: any) {
    propertyError = e?.message || "PropertyDetail lookup failed"
  }

  let ownerRaw: any = null
  let ownerError: string | null = null
  try {
    const stBody: Record<string, unknown> = { address: c.address, city: c.city, state: c.state, zip: c.zip }
    if (c.firstName) stBody.first_name = c.firstName
    if (c.lastName) stBody.last_name = c.lastName
    ownerRaw = await reapiFetch("/v2/SkipTrace", stBody)
    apiCallsMade++
  } catch (e: any) {
    ownerError = e?.message || "SkipTrace lookup failed"
  }

  // PropertyDetail's useful fields are flat top-level keys under `data`
  // (matches analysis/build_reapi_contact_table.py's extract_property_fields).
  const d = propertyRaw?.data || {}

  const persons: any[] = ownerRaw?.persons || []
  const match = c.lastName
    ? persons.find((p) => (p.lastName || "").toLowerCase() === c.lastName!.toLowerCase())
    : null
  const owner = match || persons[0] || null
  const ownerPhonesRaw: any[] = owner?.phones || []
  const ownerEmails: string[] = owner?.emails || []
  const ownerPhones: string[] = ownerPhonesRaw.map((p) => p.phone).filter(Boolean)
  const ownerDncAllPhones = ownerPhonesRaw.length ? ownerPhonesRaw.every((p) => p.phoneFtcDnc) : null

  await sql`
    INSERT INTO reapi_deal_enrichment (
      deal_id, contact_id, address_key, address, city, state, zip,
      er_territory, er_sub_region, er_region, deal_stage_at_enrich,
      property_data_available, property_fetch_error,
      estimated_value, estimated_equity, equity_percent,
      estimated_mortgage_balance, estimated_mortgage_payment,
      last_sale_date, last_sale_price,
      owner_occupied, absentee_owner, out_of_state_absentee_owner, in_state_absentee_owner,
      vacant, free_clear, high_equity, corporate_owned,
      property_type, year_built, living_square_feet, bedrooms, bathrooms, lot_square_feet,
      flood_zone, flood_zone_type,
      mls_active, mls_listing_price, mls_status,
      owner_data_available, owner_fetch_error, owner_full_name,
      owner_age, owner_gender, owner_marital_status, owner_occupation,
      owner_emails, owner_phones, owner_dnc_all_phones,
      property_json, owner_json, source
    ) VALUES (
      ${c.dealId}, ${c.contactId}, ${addressKey}, ${c.address}, ${c.city}, ${c.state}, ${c.zip},
      ${c.erTerritory}, ${c.erSubRegion}, ${c.erRegion}, ${c.dealStage},
      ${!!propertyRaw}, ${propertyError},
      ${parseNum(d.estimatedValue)}, ${parseNum(d.estimatedEquity)}, ${parseNum(d.equityPercent)},
      ${parseNum(d.estimatedMortgageBalance)}, ${parseNum(d.estimatedMortgagePayment)},
      ${parseDate(d.lastSaleDate)}, ${parseNum(d.lastSalePrice)},
      ${typeof d.ownerOccupied === "boolean" ? d.ownerOccupied : null},
      ${typeof d.absenteeOwner === "boolean" ? d.absenteeOwner : null},
      ${typeof d.outOfStateAbsenteeOwner === "boolean" ? d.outOfStateAbsenteeOwner : null},
      ${typeof d.inStateAbsenteeOwner === "boolean" ? d.inStateAbsenteeOwner : null},
      ${typeof d.vacant === "boolean" ? d.vacant : null},
      ${typeof d.freeClear === "boolean" ? d.freeClear : null},
      ${typeof d.highEquity === "boolean" ? d.highEquity : null},
      ${typeof d.corporateOwned === "boolean" ? d.corporateOwned : null},
      ${d.propertyType || null}, ${parseNum(d.yearBuilt)},
      ${parseNum(d.livingSquareFeet)}, ${parseNum(d.bedrooms)}, ${parseNum(d.bathrooms)}, ${parseNum(d.lotSquareFeet)},
      ${typeof d.floodZone === "boolean" ? d.floodZone : null}, ${d.floodZoneType || null},
      ${typeof d.mlsActive === "boolean" ? d.mlsActive : null}, ${parseNum(d.mlsListingPrice)}, ${d.mlsStatus || null},
      ${!!owner}, ${ownerError}, ${owner?.fullName || null},
      ${owner ? String(parseNum(owner.age) ?? "") : null}, ${owner?.gender || null}, ${owner?.maritalStatusDescription || null}, ${owner?.occupationDescription || null},
      ${JSON.stringify(ownerEmails)}, ${JSON.stringify(ownerPhones)}, ${ownerDncAllPhones},
      ${propertyRaw ? JSON.stringify(propertyRaw) : null}, ${ownerRaw ? JSON.stringify(ownerRaw) : null}, 'nightly_cron'
    )
    ON CONFLICT (deal_id) DO UPDATE SET
      contact_id = EXCLUDED.contact_id,
      address_key = EXCLUDED.address_key,
      address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip,
      er_territory = EXCLUDED.er_territory, er_sub_region = EXCLUDED.er_sub_region, er_region = EXCLUDED.er_region,
      deal_stage_at_enrich = EXCLUDED.deal_stage_at_enrich,
      property_data_available = EXCLUDED.property_data_available, property_fetch_error = EXCLUDED.property_fetch_error,
      estimated_value = EXCLUDED.estimated_value, estimated_equity = EXCLUDED.estimated_equity, equity_percent = EXCLUDED.equity_percent,
      estimated_mortgage_balance = EXCLUDED.estimated_mortgage_balance, estimated_mortgage_payment = EXCLUDED.estimated_mortgage_payment,
      last_sale_date = EXCLUDED.last_sale_date, last_sale_price = EXCLUDED.last_sale_price,
      owner_occupied = EXCLUDED.owner_occupied, absentee_owner = EXCLUDED.absentee_owner,
      out_of_state_absentee_owner = EXCLUDED.out_of_state_absentee_owner, in_state_absentee_owner = EXCLUDED.in_state_absentee_owner,
      vacant = EXCLUDED.vacant, free_clear = EXCLUDED.free_clear, high_equity = EXCLUDED.high_equity, corporate_owned = EXCLUDED.corporate_owned,
      property_type = EXCLUDED.property_type, year_built = EXCLUDED.year_built, living_square_feet = EXCLUDED.living_square_feet,
      bedrooms = EXCLUDED.bedrooms, bathrooms = EXCLUDED.bathrooms, lot_square_feet = EXCLUDED.lot_square_feet,
      flood_zone = EXCLUDED.flood_zone, flood_zone_type = EXCLUDED.flood_zone_type,
      mls_active = EXCLUDED.mls_active, mls_listing_price = EXCLUDED.mls_listing_price, mls_status = EXCLUDED.mls_status,
      owner_data_available = EXCLUDED.owner_data_available, owner_fetch_error = EXCLUDED.owner_fetch_error, owner_full_name = EXCLUDED.owner_full_name,
      owner_age = EXCLUDED.owner_age, owner_gender = EXCLUDED.owner_gender, owner_marital_status = EXCLUDED.owner_marital_status, owner_occupation = EXCLUDED.owner_occupation,
      owner_emails = EXCLUDED.owner_emails, owner_phones = EXCLUDED.owner_phones, owner_dnc_all_phones = EXCLUDED.owner_dnc_all_phones,
      property_json = EXCLUDED.property_json, owner_json = EXCLUDED.owner_json,
      fetched_at = now(), source = 'nightly_cron'
  `

  // Mirror into the legacy address-keyed cache so existing live-enrichment
  // callers (lib/realestate.ts) don't re-fetch the same address.
  try {
    await sql`
      INSERT INTO customer_property_enrichment (address_key, address, city, state, zip, property_json, owner_json, property_error, skiptrace_error, fetched_at)
      VALUES (${addressKey}, ${c.address}, ${c.city}, ${c.state}, ${c.zip}, ${propertyRaw ? JSON.stringify(propertyRaw) : null}, ${ownerRaw ? JSON.stringify(ownerRaw) : null}, ${propertyError}, ${ownerError}, now())
      ON CONFLICT (address_key) DO UPDATE SET
        property_json = EXCLUDED.property_json, owner_json = EXCLUDED.owner_json,
        property_error = EXCLUDED.property_error, skiptrace_error = EXCLUDED.skiptrace_error,
        fetched_at = now()
    `
  } catch {
    // best-effort mirror only
  }

  return { ok: true, apiCallsMade }
}

// Batch-fetch enrichment rows for a set of deal ids, keyed by deal_id, for
// the customer-analysis API route to join against.
export async function getDealEnrichmentMap(
  dealIds: string[],
): Promise<Map<string, DealDetailEnrichment>> {
  const map = new Map<string, DealDetailEnrichment>()
  if (!dealIds.length) return map

  const rows = await sql`
    SELECT * FROM reapi_deal_enrichment WHERE deal_id = ANY(${dealIds})
  `
  for (const row of rows as any[]) {
    map.set(String(row.deal_id), {
      source: "table",
      propertyDataAvailable: !!row.property_data_available,
      ownerDataAvailable: !!row.owner_data_available,
      propertyError: row.property_fetch_error,
      ownerError: row.owner_fetch_error,
      estimatedValue: row.estimated_value != null ? Number(row.estimated_value) : null,
      estimatedEquity: row.estimated_equity != null ? Number(row.estimated_equity) : null,
      equityPercent: row.equity_percent != null ? Number(row.equity_percent) : null,
      lastSaleDate: row.last_sale_date,
      lastSalePrice: row.last_sale_price != null ? Number(row.last_sale_price) : null,
      ownerOccupied: row.owner_occupied,
      absenteeOwner: row.absentee_owner,
      vacant: row.vacant,
      highEquity: row.high_equity,
      propertyType: row.property_type,
      yearBuilt: row.year_built,
      livingSquareFeet: row.living_square_feet,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms != null ? Number(row.bathrooms) : null,
      lotSquareFeet: row.lot_square_feet,
      floodZone: row.flood_zone,
      mlsActive: row.mls_active,
      mlsListingPrice: row.mls_listing_price != null ? Number(row.mls_listing_price) : null,
      mlsStatus: row.mls_status,
      ownerFullName: row.owner_full_name,
      ownerAge: row.owner_age != null ? Number(row.owner_age) || null : null,
      ownerGender: row.owner_gender,
      ownerMaritalStatus: row.owner_marital_status,
      ownerOccupation: row.owner_occupation,
      ownerEmails: Array.isArray(row.owner_emails) ? row.owner_emails : [],
      ownerPhones: Array.isArray(row.owner_phones) ? row.owner_phones : [],
      ownerDncAllPhones: row.owner_dnc_all_phones,
      erTerritory: row.er_territory,
      erSubRegion: row.er_sub_region,
      erRegion: row.er_region,
      fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
    })
  }
  return map
}

export type NightlyRunResult = {
  candidateDeals: number
  apiCallsMade: number
  dealsEnriched: number
  capped: boolean
  errors: number
}

// Entry point for the nightly cron. `nightlyCap` bounds new RealEstateAPI
// calls (property+skiptrace pair counts as up to 2) to keep cost predictable.
export async function runNightlyEnrichment(token: string, nightlyCap = 200): Promise<NightlyRunResult> {
  const startedAt = new Date()
  const deals = await findQuotedOrClosedDeals(token)
  const dealIds = deals.map((d) => d.id)
  const alreadyEnriched = await getAlreadyEnrichedDealIds(dealIds)
  const pending = deals.filter((d) => !alreadyEnriched.has(d.id))

  const candidates = await resolveEnrichmentCandidates(token, pending)

  let apiCallsMade = 0
  let dealsEnriched = 0
  let errors = 0
  let capped = false

  for (const c of candidates) {
    if (apiCallsMade >= nightlyCap) {
      capped = true
      break
    }
    try {
      const result = await enrichAndStoreDeal(c)
      apiCallsMade += result.apiCallsMade
      dealsEnriched++
    } catch (e) {
      errors++
    }
  }

  await sql`
    INSERT INTO reapi_enrichment_runs (started_at, finished_at, candidate_deals, api_calls_made, deals_enriched, capped, errors, notes)
    VALUES (${startedAt.toISOString()}, now(), ${pending.length}, ${apiCallsMade}, ${dealsEnriched}, ${capped}, ${errors}, ${`scope=quoted_or_closed; total_deals_in_scope=${deals.length}`})
  `

  return { candidateDeals: pending.length, apiCallsMade, dealsEnriched, capped, errors }
}
