import "server-only"
import { sql } from "@/lib/db"
import {
  hsFetch,
  searchAllDeals,
  isClosedWon,
  dealAmount,
  APPOINTMENT_DATE_PROPS,
  QUOTED_DATE_PROPS,
} from "@/lib/hubspot"
import { resolveRange, type RangeKey } from "@/lib/date-ranges"

// The 7 matrix columns, in display order.
export const SALES_MANAGER_PERIODS: { key: RangeKey; label: string }[] = [
  { key: "yesterday", label: "Yesterday" },
  { key: "thisWeek", label: "This week" },
  { key: "lastWeek", label: "Last week" },
  { key: "mtd", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "ytd", label: "Year to date" },
  { key: "lastYearYtd", label: "Last year same YTD" },
]

export type WindowMetrics = {
  contacts: number
  appointments: number
  quotes: number
  closedWon: number
  wonRevenue: number
}

// A datetime-range filter group on a single property (values are ms-epoch
// strings, which HubSpot accepts unambiguously for datetime properties).
function rangeGroup(prop: string, fromMs: number, toMs: number) {
  return {
    filters: [
      { propertyName: prop, operator: "GTE", value: String(fromMs) },
      { propertyName: prop, operator: "LTE", value: String(toMs) },
    ],
  }
}

// Count-only search: read `total` without paginating any records.
async function countSearch(token: string, object: "contacts" | "deals", filterGroups: any[]): Promise<number> {
  const data = await hsFetch<{ total: number }>(`/crm/v3/objects/${object}/search`, {
    token,
    method: "POST",
    body: JSON.stringify({ filterGroups, properties: [], limit: 1 }),
  })
  return data.total ?? 0
}

// Collect the distinct deal ids matching the given filter groups (ids only, no
// properties). Used to dedupe across chunked searches.
async function collectDealIds(token: string, filterGroups: any[]): Promise<Set<string>> {
  const ids = new Set<string>()
  let after: string | undefined
  let pages = 0
  do {
    const body: Record<string, unknown> = { filterGroups, properties: [], limit: 100 }
    if (after) body.after = after
    const data = await hsFetch<{
      results: { id: string }[]
      paging?: { next?: { after: string } }
    }>("/crm/v3/objects/deals/search", { token, method: "POST", body: JSON.stringify(body) })
    for (const r of data.results ?? []) ids.add(r.id)
    after = data.paging?.next?.after
    pages++
  } while (after && pages < 60)
  return ids
}

// Compute the 5 metrics for a single [fromMs, toMs] window using lightweight
// searches (count-only where possible), so all 7 windows can run sequentially
// without hammering HubSpot's rate limit.
export async function computeWindowMetrics(token: string, fromMs: number, toMs: number): Promise<WindowMetrics> {
  // Contacts created in the window.
  const contacts = await countSearch(token, "contacts", [rangeGroup("createdate", fromMs, toMs)])

  // Appointments = deals that entered an appointment stage in the window. The 5
  // appointment date props fit within HubSpot's 5-filterGroup cap, and an OR'd
  // search returns the distinct deal count directly.
  const appointments = await countSearch(
    token,
    "deals",
    APPOINTMENT_DATE_PROPS.map((p) => rangeGroup(p, fromMs, toMs)),
  )

  // Quotes = deals that entered a quoted stage in the window. There are 17
  // quoted date props — more than the 5-group cap — so search in chunks of 5
  // and union the deal ids to dedupe deals whose stage props span chunks.
  const quoteIds = new Set<string>()
  for (let i = 0; i < QUOTED_DATE_PROPS.length; i += 5) {
    const chunk = QUOTED_DATE_PROPS.slice(i, i + 5).map((p) => rangeGroup(p, fromMs, toMs))
    const ids = await collectDealIds(token, chunk)
    for (const id of ids) quoteIds.add(id)
  }
  const quotes = quoteIds.size

  // Closed won + won revenue = deals closed-won with a close date in the window.
  const wonDeals = await searchAllDeals(
    token,
    [
      {
        filters: [
          { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
          { propertyName: "closedate", operator: "GTE", value: String(fromMs) },
          { propertyName: "closedate", operator: "LTE", value: String(toMs) },
        ],
      },
    ],
    ["amount", "hs_is_closed_won", "closedate", "dealname"],
  )
  let closedWon = 0
  let wonRevenue = 0
  for (const d of wonDeals) {
    if (!isClosedWon(d)) continue
    const cd = d.properties.closedate ? Date.parse(d.properties.closedate) : NaN
    if (Number.isNaN(cd) || cd < fromMs || cd > toMs) continue
    closedWon++
    wonRevenue += dealAmount(d)
  }

  return { contacts, appointments, quotes, closedWon, wonRevenue }
}

// Recompute every window SEQUENTIALLY (never in parallel — parallel heavy
// searches are what rate-limited HubSpot) and upsert each into the DB.
export async function refreshAllPeriods(token: string): Promise<{ period: string; metrics: WindowMetrics }[]> {
  const out: { period: string; metrics: WindowMetrics }[] = []
  for (const { key, label } of SALES_MANAGER_PERIODS) {
    const { dateFrom, dateTo } = resolveRange(key)
    const fromMs = Date.parse(dateFrom)
    const toMs = Date.parse(dateTo)
    const m = await computeWindowMetrics(token, fromMs, toMs)
    await sql`
      insert into sales_manager_metrics
        (period_key, label, date_from, date_to, contacts, appointments, quotes, closed_won, won_revenue, updated_at)
      values
        (${key}, ${label}, ${dateFrom}, ${dateTo}, ${m.contacts}, ${m.appointments}, ${m.quotes},
         ${m.closedWon}, ${m.wonRevenue}, now())
      on conflict (period_key) do update set
        label = excluded.label,
        date_from = excluded.date_from,
        date_to = excluded.date_to,
        contacts = excluded.contacts,
        appointments = excluded.appointments,
        quotes = excluded.quotes,
        closed_won = excluded.closed_won,
        won_revenue = excluded.won_revenue,
        updated_at = now()
    `
    out.push({ period: key, metrics: m })
  }
  return out
}

// --- Section snapshots (Meetings, Open Quote Pipeline, Sales Rep YTD) ---------
//
// The Sales Manager page is a static nightly snapshot: every section reads
// pre-computed JSON written by the cron, so the page never triggers a live
// HubSpot query. Each section's payload is stored verbatim under a section key.

export type SnapshotSection =
  | "meetings_weeks"
  | "open_quote_pipeline"
  | "sales_rep_ytd"
  | "consult_no_quote"
  | "open_quotes_list"

export async function saveSnapshot(section: SnapshotSection, payload: unknown): Promise<void> {
  await sql`
    insert into sales_manager_snapshots (section, payload, updated_at)
    values (${section}, ${sql.json(payload as any)}, now())
    on conflict (section) do update set
      payload = excluded.payload,
      updated_at = now()
  `
}

export async function readSnapshot<T = unknown>(
  section: SnapshotSection,
): Promise<{ payload: T; updatedAt: string } | null> {
  const rows = await sql<{ payload: T; updated_at: string }[]>`
    select payload, updated_at from sales_manager_snapshots where section = ${section}
  `
  if (!rows.length) return null
  return { payload: rows[0].payload, updatedAt: rows[0].updated_at }
}

export async function readAllSnapshots(): Promise<
  Record<SnapshotSection, { payload: unknown; updatedAt: string } | null>
> {
  const rows = await sql<{ section: SnapshotSection; payload: unknown; updated_at: string }[]>`
    select section, payload, updated_at from sales_manager_snapshots
  `
  const byKey = new Map(rows.map((r) => [r.section, { payload: r.payload, updatedAt: r.updated_at }]))
  return {
    meetings_weeks: byKey.get("meetings_weeks") ?? null,
    open_quote_pipeline: byKey.get("open_quote_pipeline") ?? null,
    sales_rep_ytd: byKey.get("sales_rep_ytd") ?? null,
    consult_no_quote: byKey.get("consult_no_quote") ?? null,
    open_quotes_list: byKey.get("open_quotes_list") ?? null,
  }
}

export type StoredRow = {
  periodKey: string
  label: string
  contacts: number
  appointments: number
  quotes: number
  closedWon: number
  wonRevenue: number
  updatedAt: string
}

// Read the stored rows in the matrix's display order.
export async function readStoredMetrics(): Promise<{ rows: StoredRow[]; updatedAt: string | null }> {
  const rows = await sql<
    {
      period_key: string
      label: string
      contacts: number
      appointments: number
      quotes: number
      closed_won: number
      won_revenue: string
      updated_at: string
    }[]
  >`select period_key, label, contacts, appointments, quotes, closed_won, won_revenue, updated_at
    from sales_manager_metrics`

  const order = SALES_MANAGER_PERIODS.map((p) => p.key)
  const byKey = new Map(rows.map((r) => [r.period_key, r]))
  const ordered: StoredRow[] = []
  for (const key of order) {
    const r = byKey.get(key)
    if (!r) continue
    ordered.push({
      periodKey: r.period_key,
      label: r.label,
      contacts: r.contacts,
      appointments: r.appointments,
      quotes: r.quotes,
      closedWon: r.closed_won,
      wonRevenue: Number(r.won_revenue),
      updatedAt: r.updated_at,
    })
  }
  const updatedAt = ordered.length ? ordered[0].updatedAt : null
  return { rows: ordered, updatedAt }
}
