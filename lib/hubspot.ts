// Shared HubSpot constants + server-side fetch helper.
// All HubSpot calls go through the server using process.env.HUBSPOT_TOKEN.

export const HUBSPOT_API_BASE = "https://api.hubapi.com"

// Pipeline ID -> human label
export const PIPELINE_LABELS: Record<string, string> = {
  default: "Express Reface",
  "4358564": "Countertops",
  "1066318": "Multi Family Renovation",
  "1066325": "Multi Family Builder",
  "1066332": "Single Family Builder",
  "7735089": "Bath Vanity (archive)",
  "129150355": "Bath Vanity",
  "675386532": "Bath Vanity 2025",
}

export function pipelineLabel(id: string | undefined | null): string {
  if (!id) return "Unknown"
  return PIPELINE_LABELS[id] ?? id
}

// Pipeline ID -> short badge abbreviation (for the "Won by pipeline" column)
export const PIPELINE_ABBREV: Record<string, string> = {
  default: "ER",
  "4358564": "CT",
  "1066318": "MFR",
  "1066325": "MFB",
  "1066332": "SFB",
  "7735089": "BV-A",
  "129150355": "BV",
  "675386532": "BV25",
}

export function pipelineAbbrev(id: string | undefined | null): string {
  if (!id) return "?"
  return PIPELINE_ABBREV[id] ?? pipelineLabel(id).slice(0, 3).toUpperCase()
}

// Stage IDs that count as "Appointment Set" across pipelines
export const APPOINTMENT_STAGE_IDS = new Set<string>([
  "appointmentscheduled",
  "4358565",
  "7735090",
  "224864820",
  "1633204",
])

// Stage IDs that indicate a deal has reached the "Quoted" milestone
// (the quote/estimate stage or any forward non-won stage like contract sent).
// Won deals are counted separately via isClosedWon().
export const QUOTED_STAGE_IDS = new Set<string>([
  // Express Reface (default)
  "decisionmakerboughtin",
  "contractsent",
  // Countertops
  "4358566",
  "4358569",
  // Bath Vanity (archive)
  "7735115",
  // Bath Vanity
  "224864819",
  "224864823",
  // Bath Vanity 2025
  "990617452",
  "990617453",
  "990617454",
  "990698101",
  // Multi Family Renovation
  "1066321",
  "1066322",
  // Multi Family Builder
  "1066328",
  "1066329",
  // Single Family Builder
  "1066335",
  "1066336",
])

// Stage IDs for the post-sale "Scheduled" stage (job scheduled for install),
// one per pipeline that has it. Distinct from "Appointment scheduled".
export const SCHEDULED_STAGE_IDS = new Set<string>([
  "13018399", // Express Reface (default)
  "183685790", // Countertops
  "213130529", // Bath Vanity (archive)
  "225149726", // Bath Vanity
])

// Custom territory routing fields on the deal object
export const ER_TERRITORY_FIELDS = [
  "er_territory",
  "er_sub_region",
  "er_region",
  "er_super_region",
] as const

export const UNMAPPED = "UNMAPPED"

// HubSpot maintains a `hs_v2_date_entered_<stageId>` timestamp for every deal
// stage it has ever entered. We use these to compute funnel milestones as
// "ever reached this stage" rather than "currently sitting in this stage" —
// otherwise a won deal (now in a fulfillment stage) or a lost deal no longer
// counts as having set an appointment / been quoted, collapsing the funnel.
export const dateEnteredProp = (stageId: string) => `hs_v2_date_entered_${stageId}`

export const APPOINTMENT_DATE_PROPS = [...APPOINTMENT_STAGE_IDS].map(dateEnteredProp)
export const QUOTED_DATE_PROPS = [...QUOTED_STAGE_IDS].map(dateEnteredProp)
export const SCHEDULED_DATE_PROPS = [...SCHEDULED_STAGE_IDS].map(dateEnteredProp)

// True if the deal ever entered any of the given stages (per stage history).
export function enteredAnyStage(deal: HubSpotDeal, stageIds: Set<string>): boolean {
  for (const id of stageIds) {
    if (deal.properties[dateEnteredProp(id)]) return true
  }
  return false
}

// Default deal properties to request from HubSpot
export const DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "reface_amount",
  "countertop_amount",
  "job_type",
  "dealstage",
  "pipeline",
  "createdate",
  "closedate",
  "hs_is_closed_won",
  "hs_lastmodifieddate",
  "hubspot_owner_id",
  "zip",
  ...ER_TERRITORY_FIELDS,
  ...APPOINTMENT_DATE_PROPS,
  ...QUOTED_DATE_PROPS,
  ...SCHEDULED_DATE_PROPS,
]

export class HubSpotError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = "HubSpotError"
  }
}

export function getToken(req?: Request): string | null {
  const headerToken = req?.headers.get("x-hubspot-token")
  return headerToken || process.env.HUBSPOT_TOKEN || null
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Thin wrapper around the HubSpot REST API.
// Automatically retries on 429 (rate limit) and transient 5xx errors using
// exponential backoff, respecting the Retry-After header when present.
export async function hsFetch<T = any>(
  path: string,
  init: RequestInit & { token: string; maxRetries?: number },
): Promise<T> {
  const { token, maxRetries = 5, ...rest } = init

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HUBSPOT_API_BASE}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(rest.headers || {}),
      },
      cache: "no-store",
    })

    if (res.ok) return (await res.json()) as T

    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600)
    if (retryable && attempt < maxRetries) {
      // Prefer the server-provided Retry-After (seconds), else exponential backoff.
      const retryAfter = Number(res.headers.get("retry-after"))
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(500 * 2 ** attempt, 8000)
      // Add jitter so parallel callers don't retry in lockstep.
      await sleep(backoff + Math.random() * 250)
      continue
    }

    const text = await res.text().catch(() => "")
    throw new HubSpotError(
      `HubSpot ${res.status}: ${text || res.statusText}`,
      res.status,
    )
  }
}

// HubSpot account/portal id, used to build deep links to deal records
// (https://app.hubspot.com/contacts/<portalId>/record/0-3/<dealId>). Cached
// per-process since it never changes for a given token.
let _portalIdCache: string | null = null
export async function fetchPortalId(token: string): Promise<string | null> {
  if (_portalIdCache) return _portalIdCache
  try {
    const info = await hsFetch<{ portalId?: number | string }>("/account-info/v3/details", {
      method: "GET",
      token,
      maxRetries: 2,
    })
    if (info?.portalId != null) {
      _portalIdCache = String(info.portalId)
      return _portalIdCache
    }
  } catch {
    // Non-fatal: without a portal id the UI just omits the HubSpot link.
  }
  return null
}

export type HubSpotDeal = {
  id: string
  properties: Record<string, string | null>
}

// Paginate through a HubSpot CRM search query, gathering all results.
export async function searchAllDeals(
  token: string,
  filterGroups: any[],
  properties: string[] = DEAL_PROPERTIES,
  maxPages = 40,
): Promise<HubSpotDeal[]> {
  const results: HubSpotDeal[] = []
  let after: string | undefined = undefined
  let pages = 0

  do {
    const body: Record<string, unknown> = {
      filterGroups,
      properties,
      limit: 100,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    }
    if (after) body.after = after

    const data = await hsFetch<{
      results: HubSpotDeal[]
      paging?: { next?: { after: string } }
    }>("/crm/v3/objects/deals/search", {
      token,
      method: "POST",
      body: JSON.stringify(body),
    })

    results.push(...(data.results || []))
    after = data.paging?.next?.after
    pages++
    // Stay under the search API's per-second limit (~4 req/s).
    if (after) await sleep(300)
  } while (after && pages < maxPages)

  return results
}

// Contact territory routing properties (mirror the deal er_* fields).
export const CONTACT_TERRITORY_PROPERTIES = [
  "createdate",
  "zip",
  ...ER_TERRITORY_FIELDS,
]

export type HubSpotContact = {
  id: string
  properties: Record<string, string | null>
}

// Paginate through a HubSpot CRM contacts search query, gathering all results.
export async function searchAllContacts(
  token: string,
  filterGroups: any[],
  properties: string[] = CONTACT_TERRITORY_PROPERTIES,
  maxPages = 40,
): Promise<HubSpotContact[]> {
  const results: HubSpotContact[] = []
  let after: string | undefined = undefined
  let pages = 0

  do {
    const body: Record<string, unknown> = {
      filterGroups,
      properties,
      limit: 100,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    }
    if (after) body.after = after

    const data = await hsFetch<{
      results: HubSpotContact[]
      paging?: { next?: { after: string } }
    }>("/crm/v3/objects/contacts/search", {
      token,
      method: "POST",
      body: JSON.stringify(body),
    })

    results.push(...(data.results || []))
    after = data.paging?.next?.after
    pages++
    // Stay under the search API's per-second limit (~4 req/s).
    if (after) await sleep(300)
  } while (after && pages < maxPages)

  return results
}

// Resolve each requested ZIP to its territory (er_territory), independent of any
// date window, so even ZIPs with no records in the reporting window are labeled.
// Searches contacts by `zip IN [...]` requesting only zip + er_territory, then
// picks the most common non-empty territory per ZIP. Best-effort: ZIPs with no
// matching records (or no territory value) are simply omitted from the map.
export async function fetchZipTerritoryMap(
  token: string,
  zips: string[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  if (!zips.length) return map
  try {
    const contacts = await searchAllContacts(
      token,
      [{ filters: [{ propertyName: "zip", operator: "IN", values: zips }] }],
      ["zip", "er_territory"],
      15,
    )
    const tally = new Map<string, Map<string, number>>()
    for (const c of contacts) {
      const zm = (c.properties.zip || "").trim().match(/\d{5}/)
      const z = zm ? zm[0] : ""
      const terr = (c.properties.er_territory || "").trim()
      if (!z || !terr) continue
      let t = tally.get(z)
      if (!t) {
        t = new Map()
        tally.set(z, t)
      }
      t.set(terr, (t.get(terr) || 0) + 1)
    }
    for (const [z, t] of tally) {
      let best = ""
      let bestN = 0
      for (const [terr, n] of t) {
        if (n > bestN) {
          best = terr
          bestN = n
        }
      }
      if (best) map[z] = best
    }
  } catch {
    // best-effort; territory column will show a dash for unresolved zips
  }
  return map
}

// Resolve each requested ZIP to its full routing hierarchy (territory + sub-region),
// independent of any date window. Searches contacts by `zip IN [...]` requesting
// zip + er_territory + er_sub_region, then picks the most common non-empty value
// per ZIP for each level. Best-effort: unresolved ZIPs are omitted from the map.
export type ZipHierarchy = { territory: string; subRegion: string }

export async function fetchZipHierarchyMap(
  token: string,
  zips: string[],
): Promise<Record<string, ZipHierarchy>> {
  const map: Record<string, ZipHierarchy> = {}
  if (!zips.length) return map
  try {
    const contacts = await searchAllContacts(
      token,
      [{ filters: [{ propertyName: "zip", operator: "IN", values: zips }] }],
      ["zip", "er_territory", "er_sub_region"],
      15,
    )
    // Per zip, tally the mode of each hierarchy level independently.
    const terrTally = new Map<string, Map<string, number>>()
    const subTally = new Map<string, Map<string, number>>()
    const bump = (tally: Map<string, Map<string, number>>, zip: string, val: string) => {
      if (!val) return
      let t = tally.get(zip)
      if (!t) {
        t = new Map()
        tally.set(zip, t)
      }
      t.set(val, (t.get(val) || 0) + 1)
    }
    for (const c of contacts) {
      const zm = (c.properties.zip || "").trim().match(/\d{5}/)
      const z = zm ? zm[0] : ""
      if (!z) continue
      bump(terrTally, z, (c.properties.er_territory || "").trim())
      bump(subTally, z, (c.properties.er_sub_region || "").trim())
    }
    const mode = (t: Map<string, number> | undefined): string => {
      if (!t) return ""
      let best = ""
      let bestN = 0
      for (const [val, n] of t) {
        if (n > bestN) {
          best = val
          bestN = n
        }
      }
      return best
    }
    for (const z of zips) {
      const territory = mode(terrTally.get(z))
      const subRegion = mode(subTally.get(z))
      if (territory || subRegion) map[z] = { territory, subRegion }
    }
  } catch {
    // best-effort; unresolved zips fall back to "Unassigned" on the client
  }
  return map
}

// Fetch a map of HubSpot owner id -> display name (for sales-rep rollups).
export async function fetchOwnerMap(token: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  try {
    const data = await hsFetch<{ results: any[] }>("/crm/v3/owners?limit=500", {
      token,
      method: "GET",
    })
    for (const o of data.results || []) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || `Owner ${o.id}`
      map[String(o.id)] = name
    }
  } catch {
    // best-effort; unmapped owners fall back to "Unassigned"
  }
  return map
}

export function isClosedWon(deal: HubSpotDeal): boolean {
  const won = deal.properties.hs_is_closed_won
  return won === "true" || won === "1"
}

// Closed lost = the deal is closed but not won. Requires `hs_is_closed` to be
// among the requested deal properties (it is not in DEAL_PROPERTIES by default).
export function isClosedLost(deal: HubSpotDeal): boolean {
  const closed = deal.properties.hs_is_closed
  const isClosed = closed === "true" || closed === "1"
  return isClosed && !isClosedWon(deal)
}

export function dealAmount(deal: HubSpotDeal): number {
  const raw = deal.properties.amount
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) ? n : 0
}

// Read an arbitrary numeric deal property (e.g. reface_amount, countertop_amount),
// returning 0 when unset or non-numeric.
export function dealNumber(deal: HubSpotDeal, prop: string): number {
  const raw = deal.properties[prop]
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) ? n : 0
}

// The deal's job type(s). `job_type` is a HubSpot multi-select stored as a
// ";"-separated string (e.g. "Reface", "Countertops", "Countertops;Reface").
export function dealJobTypes(deal: HubSpotDeal): string[] {
  return (deal.properties.job_type || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
}

export function jobTypeHasReface(deal: HubSpotDeal): boolean {
  return dealJobTypes(deal).some((t) => /reface|cabinet/i.test(t))
}

export function jobTypeHasCountertop(deal: HubSpotDeal): boolean {
  return dealJobTypes(deal).some((t) => /countertop/i.test(t))
}

// Job-type-validated product amounts. Business rule (operator): the cabinet
// (reface) amount only counts when the job type includes Reface, and the
// countertop amount only counts when the job type includes Countertops. This
// prevents a countertop amount keyed on a Reface-only job (and vice-versa)
// from inflating the revenue split beyond the deal amount.
export function refaceAmountForJob(deal: HubSpotDeal): number {
  return jobTypeHasReface(deal) ? dealNumber(deal, "reface_amount") : 0
}

export function countertopAmountForJob(deal: HubSpotDeal): number {
  return jobTypeHasCountertop(deal) ? dealNumber(deal, "countertop_amount") : 0
}
