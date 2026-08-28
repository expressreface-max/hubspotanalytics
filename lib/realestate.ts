import "server-only"
import { sql } from "@/lib/db"

// Thin client for RealEstateAPI (REAPI) — PropertyDetail + SkipTrace v2.
// Every successful lookup is cached in Postgres keyed by the normalized
// address, since REAPI bills per record and customer addresses don't change.
const REAPI_BASE = "https://api.realestateapi.com"

export class RealEstateApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = "RealEstateApiError"
  }
}

function getApiKey(): string | null {
  return process.env.REALESTATEAPI_KEY || null
}

export function realEstateApiConfigured(): boolean {
  return !!getApiKey()
}

async function reapiFetch<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = getApiKey()
  if (!key) throw new RealEstateApiError("RealEstateAPI key is not configured", 401)

  const res = await fetch(`${REAPI_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  })

  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // fall through with json = null
  }

  if (!res.ok) {
    const msg = json?.statusMessage || json?.message || text || res.statusText
    throw new RealEstateApiError(`RealEstateAPI ${res.status}: ${msg}`, res.status)
  }
  return json as T
}

// Normalize an address for use as a stable cache key.
function normalizeAddress(address: string, city: string, state: string, zip: string): string {
  return [address, city, state, zip]
    .map((s) => (s || "").trim().toLowerCase().replace(/\s+/g, " "))
    .join("|")
}

export type PropertyDetail = {
  yearBuilt: number | null
  propertyType: string | null
  bedrooms: number | null
  bathrooms: number | null
  livingSquareFeet: number | null
  lotSquareFeet: number | null
  estimatedValue: number | null
  estimatedEquity: number | null
  equityPercent: number | null
  assessedValue: number | null
  taxAmount: number | null
  ownerOccupied: boolean | null
  absenteeOwner: boolean | null
  ownershipLength: number | null
  owner1FullName: string | null
  owner2FullName: string | null
  lastSaleDate: string | null
  lastSalePrice: number | null
  floodZone: boolean | null
  highEquity: boolean | null
  vacant: boolean | null
  medianIncomeArea: number | null
  hudAreaName: string | null
  subdivision: string | null
  raw: any
}

export type SkipTraceOwner = {
  fullName: string | null
  age: number | null
  gender: string | null
  maritalStatus: string | null
  occupation: string | null
  raw: any
}

export type PropertyEnrichment = {
  addressKey: string
  property: PropertyDetail | null
  owner: SkipTraceOwner | null
  propertyError: string | null
  skipTraceError: string | null
  fetchedAt: string
}

// Idempotent — safe to call on every request. Creates the enrichment cache
// table on first use so no separate migration step is required.
let _tableEnsured = false
async function ensureTable(): Promise<void> {
  if (_tableEnsured) return
  await sql`
    CREATE TABLE IF NOT EXISTS customer_property_enrichment (
      address_key TEXT PRIMARY KEY,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      property_json JSONB,
      owner_json JSONB,
      property_error TEXT,
      skiptrace_error TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  _tableEnsured = true
}

function parseNum(v: any): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "string" ? Number(v.replace(/[,$]/g, "")) : Number(v)
  return Number.isFinite(n) ? n : null
}

function mapPropertyDetail(raw: any): PropertyDetail {
  const d = raw?.data || {}
  const propertyInfo = d.propertyInfo || {}
  const ownerInfo = d.ownerInfo || {}
  const taxInfo = d.taxInfo || {}
  const demo = d.demographics || {}
  const lastSale = d.lastSale || {}

  return {
    yearBuilt: parseNum(propertyInfo.yearBuilt),
    propertyType: d.propertyType || propertyInfo.propertyUse || null,
    bedrooms: parseNum(propertyInfo.bedrooms),
    bathrooms: parseNum(propertyInfo.bathrooms),
    livingSquareFeet: parseNum(propertyInfo.livingSquareFeet),
    lotSquareFeet: parseNum(propertyInfo.lotSquareFeet),
    estimatedValue: parseNum(d.estimatedValue),
    estimatedEquity: parseNum(d.estimatedEquity),
    equityPercent: parseNum(d.equityPercent),
    assessedValue: parseNum(taxInfo.assessedValue),
    taxAmount: parseNum(taxInfo.taxAmount),
    ownerOccupied: typeof d.ownerOccupied === "boolean" ? d.ownerOccupied : null,
    absenteeOwner: typeof d.absenteeOwner === "boolean" ? d.absenteeOwner : null,
    ownershipLength: parseNum(ownerInfo.ownershipLength),
    owner1FullName: ownerInfo.owner1FullName || null,
    owner2FullName: ownerInfo.owner2FullName || null,
    lastSaleDate: lastSale.saleDate || d.lastSaleDate || null,
    lastSalePrice: parseNum(lastSale.saleAmount ?? d.lastSalePrice),
    floodZone: typeof d.floodZone === "boolean" ? d.floodZone : null,
    highEquity: typeof d.highEquity === "boolean" ? d.highEquity : null,
    vacant: typeof d.vacant === "boolean" ? d.vacant : null,
    medianIncomeArea: parseNum(demo.medianIncome),
    hudAreaName: demo.hudAreaName || null,
    subdivision: propertyInfo.address ? null : null,
    raw,
  }
}

function mapSkipTraceOwner(raw: any, ownerLastName?: string): SkipTraceOwner | null {
  const persons: any[] = raw?.persons || []
  if (!persons.length) return null
  // Prefer a person whose last name matches the known owner (reduces the
  // chance of picking a different household member), else take the first.
  const match = ownerLastName
    ? persons.find((p) => (p.lastName || "").toLowerCase() === ownerLastName.toLowerCase())
    : null
  const p = match || persons[0]
  return {
    fullName: p.fullName || null,
    age: parseNum(p.age),
    gender: p.gender || null,
    maritalStatus: p.maritalStatusDescription || null,
    occupation: p.occupationDescription || null,
    raw: p,
  }
}

// Fetch (or return cached) property + owner-demographic enrichment for one
// customer address. `firstName`/`lastName` improve SkipTrace match accuracy
// but are optional.
export async function enrichAddress(
  address: string,
  city: string,
  state: string,
  zip: string,
  firstName?: string,
  lastName?: string,
): Promise<PropertyEnrichment> {
  await ensureTable()
  const addressKey = normalizeAddress(address, city, state, zip)

  const cached = await sql`
    SELECT * FROM customer_property_enrichment WHERE address_key = ${addressKey}
  `
  if (cached.length) {
    const row = cached[0]
    return {
      addressKey,
      property: row.property_json || null,
      owner: row.owner_json || null,
      propertyError: row.property_error,
      skipTraceError: row.skiptrace_error,
      fetchedAt: row.fetched_at,
    }
  }

  let property: PropertyDetail | null = null
  let propertyError: string | null = null
  try {
    const raw = await reapiFetch("/v2/PropertyDetail", {
      address: `${address}, ${city}, ${state} ${zip}`,
    })
    property = mapPropertyDetail(raw)
  } catch (e: any) {
    propertyError = e?.message || "PropertyDetail lookup failed"
  }

  let owner: SkipTraceOwner | null = null
  let skipTraceError: string | null = null
  try {
    const stBody: Record<string, unknown> = { address, city, state, zip }
    if (firstName) stBody.first_name = firstName
    if (lastName) stBody.last_name = lastName
    const raw = await reapiFetch("/v2/SkipTrace", stBody)
    owner = mapSkipTraceOwner(raw, lastName)
  } catch (e: any) {
    skipTraceError = e?.message || "SkipTrace lookup failed"
  }

  const fetchedAt = new Date().toISOString()
  await sql`
    INSERT INTO customer_property_enrichment
      (address_key, address, city, state, zip, property_json, owner_json, property_error, skiptrace_error, fetched_at)
    VALUES
      (${addressKey}, ${address}, ${city}, ${state}, ${zip}, ${sql.json(property as any)}, ${sql.json(owner as any)}, ${propertyError}, ${skipTraceError}, ${fetchedAt})
    ON CONFLICT (address_key) DO UPDATE SET
      property_json = EXCLUDED.property_json,
      owner_json = EXCLUDED.owner_json,
      property_error = EXCLUDED.property_error,
      skiptrace_error = EXCLUDED.skiptrace_error,
      fetched_at = EXCLUDED.fetched_at
  `

  return { addressKey, property, owner, propertyError, skipTraceError, fetchedAt }
}

// Batch enrich with limited concurrency to stay within REAPI rate limits.
export async function enrichAddressesBatch(
  customers: { address: string; city: string; state: string; zip: string; firstName?: string; lastName?: string }[],
  concurrency = 5,
): Promise<PropertyEnrichment[]> {
  const results: PropertyEnrichment[] = new Array(customers.length)
  let idx = 0
  async function worker() {
    while (idx < customers.length) {
      const i = idx++
      const c = customers[i]
      if (!c.address || !c.zip) {
        results[i] = {
          addressKey: normalizeAddress(c.address, c.city, c.state, c.zip),
          property: null,
          owner: null,
          propertyError: "No street address on file",
          skipTraceError: "No street address on file",
          fetchedAt: new Date().toISOString(),
        }
        continue
      }
      results[i] = await enrichAddress(c.address, c.city, c.state, c.zip, c.firstName, c.lastName)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, customers.length || 1) }, worker))
  return results
}
