import "server-only"
import { sql } from "@/lib/db"
import { searchAllDeals, isClosedWon, dealAmount } from "@/lib/hubspot"
import {
  SUB_REGION_POTENTIAL,
  TERRITORY_POTENTIAL,
  TERRITORY_ZIPS,
  MODEL,
  classifyAttainment,
  type PerformanceStatus,
} from "@/data/territory-potential"

const norm = (s: string) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

// ZIP -> territory name lookup (built once from the reconciled carve).
const ZIP_TO_TERRITORY = new Map<string, string>(TERRITORY_ZIPS.map(([zip, terr]) => [zip, terr]))

export type TerritoryRow = {
  name: string
  lpLeads: number
  potJobs30: number
  potRev30: number
  actJobs: number
  actRev: number
  jobsAtt: number
  avgSale: number
  status: PerformanceStatus
  entered: boolean
}

export type Row = {
  sub: string
  region: string
  terrCt: number
  lpLeads: number
  potJobs30: number
  potRev30: number
  potGp30: number
  potJobs50: number
  potRev50: number
  actJobs: number
  actRev: number
  jobsAtt: number
  revAtt: number
  avgSale: number
  status: PerformanceStatus
  territories?: TerritoryRow[]
}

export type TerritoryPotentialReport = {
  configured: true
  asOf: string
  windowFrom: string
  windowTo: string
  model: typeof MODEL
  rows: Row[]
  totals: Row extends never
    ? never
    : {
        terrCt: number
        lpLeads: number
        potJobs30: number
        potRev30: number
        potGp30: number
        potJobs50: number
        potRev50: number
        actJobs: number
        actRev: number
        jobsAtt: number
        revAtt: number
        avgSale: number
      }
  outOfModel: { name: string; region: string; jobs: number; rev: number; avgSale: number }[]
  dealCount: number
}

// Compute the trailing-12-month closed-won actuals and join them to the LP
// potential model. Actuals attribute to a territory by the deal's er_territory
// (exact name match against the reconciled carve); when er_territory is blank
// or unmapped we fall back to the deal's ZIP via the LP ZIP universe.
export async function computeTerritoryPotential(token: string): Promise<TerritoryPotentialReport> {
  const now = Date.now()
  const from = now - 365 * 24 * 3600 * 1000

  const deals = await searchAllDeals(
    token,
    [
      {
        filters: [
          { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
          { propertyName: "closedate", operator: "GTE", value: String(from) },
          { propertyName: "closedate", operator: "LTE", value: String(now) },
        ],
      },
    ],
    ["amount", "er_sub_region", "er_territory", "er_region", "zip", "hs_is_closed_won", "closedate"],
  )

  // Valid territory names (normalized) from the model.
  const modelTerrByNorm = new Map(TERRITORY_POTENTIAL.map((t) => [norm(t.name), t]))

  // Actuals rolled up by sub-region and by territory.
  const actMap = new Map<string, { name: string; region: string; jobs: number; rev: number }>()
  const terrActMap = new Map<string, { jobs: number; rev: number }>()

  for (const d of deals) {
    if (!isClosedWon(d)) continue
    const rev = dealAmount(d)

    // Resolve the territory: prefer er_territory, else ZIP -> territory.
    let terrName = (d.properties.er_territory || "").trim()
    let terrKey = norm(terrName)
    const isMapped = terrName && terrName.toUpperCase() !== "UNMAPPED" && modelTerrByNorm.has(terrKey)
    if (!isMapped) {
      const zip = (d.properties.zip || "").trim().padStart(5, "0")
      const zTerr = ZIP_TO_TERRITORY.get(zip)
      if (zTerr) {
        terrName = zTerr
        terrKey = norm(zTerr)
      }
    }
    if (terrName && modelTerrByNorm.has(terrKey)) {
      const tc = terrActMap.get(terrKey) || { jobs: 0, rev: 0 }
      tc.jobs++
      tc.rev += rev
      terrActMap.set(terrKey, tc)
    }

    // Resolve the sub-region: prefer er_sub_region, else the resolved
    // territory's sub-region (so ZIP-recovered deals still roll up).
    let sub = (d.properties.er_sub_region || "").trim()
    if (!sub && modelTerrByNorm.has(terrKey)) sub = modelTerrByNorm.get(terrKey)!.sub
    if (sub) {
      const key = norm(sub)
      const region =
        (d.properties.er_region || "").trim() ||
        SUB_REGION_POTENTIAL.find((p) => norm(p.sub) === key)?.region ||
        ""
      const c = actMap.get(key) || { name: sub, region, jobs: 0, rev: 0 }
      c.jobs++
      c.rev += rev
      actMap.set(key, c)
    }
  }

  // Territory detail per sub-region (join by exact name).
  const territoryDetail = new Map<string, TerritoryRow[]>()
  for (const p of SUB_REGION_POTENTIAL) {
    const terrs: TerritoryRow[] = TERRITORY_POTENTIAL.filter((t) => t.sub === p.sub).map((t) => {
      const a = terrActMap.get(norm(t.name))
      const actJobs = a?.jobs ?? 0
      const actRev = a?.rev ?? 0
      return {
        name: t.name,
        lpLeads: t.lpLeads,
        potJobs30: t.potJobs30,
        potRev30: t.potRev30,
        actJobs,
        actRev,
        jobsAtt: t.potJobs30 > 0 ? actJobs / t.potJobs30 : 0,
        avgSale: actJobs > 0 ? actRev / actJobs : 0,
        status: classifyAttainment(actJobs, t.potJobs30),
        entered: actJobs > 0,
      }
    })
    terrs.sort((x, y) => y.jobsAtt - x.jobsAtt)
    territoryDetail.set(norm(p.sub), terrs)
  }

  const rows: Row[] = SUB_REGION_POTENTIAL.map((p) => {
    const a = actMap.get(norm(p.sub))
    const actJobs = a?.jobs ?? 0
    const actRev = a?.rev ?? 0
    return {
      sub: p.sub,
      region: p.region,
      terrCt: p.terrCt,
      lpLeads: p.lpLeads,
      potJobs30: p.potJobs30,
      potRev30: p.potRev30,
      potGp30: p.potGp30,
      potJobs50: p.potJobs50,
      potRev50: p.potRev50,
      actJobs,
      actRev,
      jobsAtt: p.potJobs30 > 0 ? actJobs / p.potJobs30 : 0,
      revAtt: p.potRev30 > 0 ? actRev / p.potRev30 : 0,
      avgSale: actJobs > 0 ? actRev / actJobs : 0,
      status: classifyAttainment(actJobs, p.potJobs30),
      territories: territoryDetail.get(norm(p.sub)),
    }
  }).sort((x, y) => y.jobsAtt - x.jobsAtt)

  const modeled = new Set(SUB_REGION_POTENTIAL.map((p) => norm(p.sub)))
  const outOfModel = [...actMap.values()]
    .filter((a) => !modeled.has(norm(a.name)))
    .map((a) => ({ name: a.name, region: a.region, jobs: a.jobs, rev: a.rev, avgSale: a.jobs > 0 ? a.rev / a.jobs : 0 }))
    .sort((x, y) => y.jobs - x.jobs)

  const totals = rows.reduce(
    (acc, r) => ({
      terrCt: acc.terrCt + r.terrCt,
      lpLeads: acc.lpLeads + r.lpLeads,
      potJobs30: acc.potJobs30 + r.potJobs30,
      potRev30: acc.potRev30 + r.potRev30,
      potGp30: acc.potGp30 + r.potGp30,
      potJobs50: acc.potJobs50 + r.potJobs50,
      potRev50: acc.potRev50 + r.potRev50,
      actJobs: acc.actJobs + r.actJobs,
      actRev: acc.actRev + r.actRev,
    }),
    { terrCt: 0, lpLeads: 0, potJobs30: 0, potRev30: 0, potGp30: 0, potJobs50: 0, potRev50: 0, actJobs: 0, actRev: 0 },
  )

  return {
    configured: true,
    asOf: new Date(now).toISOString(),
    windowFrom: new Date(from).toISOString(),
    windowTo: new Date(now).toISOString(),
    model: MODEL,
    rows,
    totals: {
      ...totals,
      jobsAtt: totals.potJobs30 > 0 ? totals.actJobs / totals.potJobs30 : 0,
      revAtt: totals.potRev30 > 0 ? totals.actRev / totals.potRev30 : 0,
      avgSale: totals.actJobs > 0 ? totals.actRev / totals.actJobs : 0,
    },
    outOfModel,
    dealCount: deals.length,
  }
}

// --- Nightly snapshot persistence (Supabase) --------------------------------

const SNAPSHOT_KEY = "territory_potential"

// Recompute and store the report as a snapshot. Called by the nightly cron.
export async function refreshTerritoryPotentialSnapshot(token: string): Promise<{ ok: boolean }> {
  const report = await computeTerritoryPotential(token)
  await sql`
    insert into sales_manager_snapshots (section, payload, updated_at)
    values (${SNAPSHOT_KEY}, ${sql.json(report as any)}, now())
    on conflict (section) do update set
      payload = excluded.payload,
      updated_at = now()
  `
  return { ok: true }
}

export async function readTerritoryPotentialSnapshot(): Promise<{
  report: TerritoryPotentialReport
  updatedAt: string
} | null> {
  const rows = await sql<{ payload: TerritoryPotentialReport; updated_at: string }[]>`
    select payload, updated_at from sales_manager_snapshots where section = ${SNAPSHOT_KEY}
  `
  if (!rows.length) return null
  return { report: rows[0].payload, updatedAt: rows[0].updated_at }
}
