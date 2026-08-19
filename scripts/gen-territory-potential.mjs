// Regenerates data/territory-potential.ts from the Supabase-reconciled v2 workbook.
// Throwaway build script — run: node scripts/gen-territory-potential.mjs
import { readFileSync, writeFileSync } from "fs"
import { read, utils } from "xlsx"

const SRC = "data/SacBay-Territory-Potential-Supabase-Reconciled-v2-0763e2.xlsx"
const wb = read(readFileSync(SRC), { cellDates: true })

const AVG = 16500
const GM = 0.64
const GP_JOB = Math.round(AVG * GM) // 10560
const CEIL = 0.005 // 0.50% aggressive ceiling for the legacy *50 fields
const r0 = (n) => Math.round(Number(n) || 0)
const q = (s) => JSON.stringify(s)

// --- Sub-Region Rollup ---
// REGION(0) SUB-REGION(1) TERR(2) OO HH(3) LP LEADS(4) LP%OO(5) LIST COST(6)
// RATE(7) JOBS/YR(8) JOBS/MO(9) REVENUE(10) GROSS PROFIT(11) %OO(12)
const sr = utils.sheet_to_json(wb.Sheets["Sub-Region Rollup"], { header: 1, defval: null })
const sh = sr.findIndex((r) => r[0] === "REGION")
const subs = sr
  .slice(sh + 1)
  .filter((r) => r[0] && r[1] && typeof r[2] === "number" && String(r[0]).trim().toUpperCase() !== "TOTAL" && !/sub-regions?$/i.test(String(r[1]).trim()))
  .map((r) => ({ region: String(r[0]).trim(), sub: String(r[1]).trim(), terrCt: r[2], leads: r[4], jobs: r[8], rev: r[10], gp: r[11] }))

// --- Territory Detail ---
// REGION(0) SUB-REGION(1) RANK(2) TERRITORY(3) OO HH(4) LP LEADS(5) FILTER(6)
// LIST COST(7) QUOTE(8) RATE(9) JOBS/YR(10) JOBS/MO(11) REVENUE(12) GROSS PROFIT(13) %OO(14)
const td = utils.sheet_to_json(wb.Sheets["Territory Detail"], { header: 1, defval: null })
const th = td.findIndex((r) => r[0] === "REGION")
const terrs = td
  .slice(th + 1)
  .filter((r) => r[0] && r[1] && r[3] && typeof r[5] === "number")
  .map((r) => ({ region: String(r[0]).trim(), sub: String(r[1]).trim(), name: String(r[3]).trim(), leads: r[5], jobs: r[10], rev: r[12], gp: r[13] }))

// --- ZIP Universe: ZIP(0) REGION(1) SUB-REGION(2) TERRITORY(3) RANK(4) LP FILTER(5) TERRITORY ID(6)
const zu = utils.sheet_to_json(wb.Sheets["ZIP Universe"], { header: 1, defval: null })
const zh = zu.findIndex((r) => r[0] === "ZIP")
const zips = zu
  .slice(zh + 1)
  .filter((r) => r[0] && r[3])
  .map((r) => ({ zip: String(r[0]).trim().padStart(5, "0"), terr: String(r[3]).trim() }))

const subLine = (s) => {
  const j50 = r0(s.leads * CEIL)
  const rev50 = r0(j50 * AVG)
  return `  { sub: ${q(s.sub)}, region: ${q(s.region)}, terrCt: ${s.terrCt}, lpLeads: ${r0(s.leads)}, potJobs30: ${r0(s.jobs)}, potRev30: ${r0(s.rev)}, potGp30: ${r0(s.gp)}, potJobs50: ${j50}, potRev50: ${rev50}, potGp50: ${r0(j50 * GP_JOB)} },`
}
const terrLine = (t) => {
  const j50 = r0(t.leads * CEIL)
  const rev50 = r0(j50 * AVG)
  return `  { sub: ${q(t.sub)}, region: ${q(t.region)}, name: ${q(t.name)}, lpLeads: ${r0(t.leads)}, potJobs30: ${r0(t.jobs)}, potRev30: ${r0(t.rev)}, potGp30: ${r0(t.gp)}, potJobs50: ${j50}, potRev50: ${rev50} },`
}
const zipLine = (z) => `  ["${z.zip}", ${q(z.terr)}],`

const B = "`"
const today = new Date().toISOString().slice(0, 10)

const lines = [
  "// Territory potential model — Sac + Bay Area.",
  "// Source: data/SacBay-Territory-Potential-Supabase-Reconciled-v2-0763e2.xlsx",
  `// (\"SAC + BAY TERRITORY POTENTIAL — v2\", Supabase-reconciled 48-territory carve, updated ${today}).`,
  "//",
  "// Model: LeadsPlease qualified-lead universe at region TARGET conversion rates",
  "// (Sacramento 0.40%, Bay Area 0.30%). Avg ticket $16,500, 64% gross margin",
  `// => $${GP_JOB.toLocaleString()} GP/job. potJobs30/potRev30/potGp30 hold this single target scenario`,
  "// (field names kept for route/view compatibility). potJobs50/potRev50 are an aggressive",
  "// 0.50% ceiling derived from the same lead counts.",
  "//",
  `// JOIN: SAME 48-territory carve as HubSpot (reconciled to the Supabase territories table),`,
  `// so ${B}sub${B} == er_sub_region AND ${B}name${B} == er_territory match exactly. Actuals join by exact`,
  `// name; TERRITORY_ZIPS gives a ZIP -> territory fallback. HubSpot territories outside this`,
  "// Sac+Bay universe (Central Valley, Nevada) surface as \"out-of-model\" actuals.",
  "",
  "export const MODEL = {",
  `  avgSale: ${AVG},`,
  `  grossMargin: ${GM},`,
  `  gpPerJob: ${GP_JOB},`,
  '  scenarioLabel: "target rate (0.40% Sac / 0.30% Bay)",',
  `  pulledOn: "${today}",`,
  "} as const",
  "",
  "export type SubRegionPotential = {",
  "  sub: string",
  "  region: string",
  "  terrCt: number",
  "  lpLeads: number",
  "  /** Jobs/yr at the region target rate (the realistic target). */",
  "  potJobs30: number",
  "  potRev30: number",
  "  potGp30: number",
  "  /** Jobs/yr at the 0.50% aggressive ceiling. */",
  "  potJobs50: number",
  "  potRev50: number",
  "  potGp50: number",
  "}",
  "",
  "export const SUB_REGION_POTENTIAL: SubRegionPotential[] = [",
  ...subs.map(subLine),
  "]",
  "",
  "// ---------------------------------------------------------------------------",
  "// Territory-level potential. `name` == HubSpot `er_territory` (reconciled carve),",
  "// so territory actuals join by exact name.",
  "export type TerritoryPotential = {",
  "  sub: string",
  "  region: string",
  "  /** HubSpot `er_territory` label (exact match). */",
  "  name: string",
  "  lpLeads: number",
  "  potJobs30: number",
  "  potRev30: number",
  "  potGp30: number",
  "  potJobs50: number",
  "  potRev50: number",
  "}",
  "",
  "export const TERRITORY_POTENTIAL: TerritoryPotential[] = [",
  ...terrs.map(terrLine),
  "]",
  "",
  "// ZIP -> territory name (the 509 ZIPs called on LeadsPlease). Lets actuals be",
  "// attributed to a territory by a deal's ZIP when er_territory is blank.",
  "export const TERRITORY_ZIPS: ReadonlyArray<readonly [string, string]> = [",
  ...zips.map(zipLine),
  "]",
  "",
  'export type PerformanceStatus = "over" | "on_pace" | "under" | "no_potential"',
  "",
  "/**",
  " * Classify performance by jobs attainment vs the region target rate.",
  " *   over     >= 100%",
  " *   on_pace  50-99%",
  " *   under    < 50%",
  " */",
  "export function classifyAttainment(actualJobs: number, potentialJobs30: number): PerformanceStatus {",
  '  if (potentialJobs30 <= 0) return "no_potential"',
  "  const pct = actualJobs / potentialJobs30",
  '  if (pct >= 1) return "over"',
  '  if (pct >= 0.5) return "on_pace"',
  '  return "under"',
  "}",
  "",
  "export const STATUS_LABEL: Record<PerformanceStatus, string> = {",
  '  over: "Overperforming",',
  '  on_pace: "On pace",',
  '  under: "Underperforming",',
  '  no_potential: "Out of model",',
  "}",
  "",
]

writeFileSync("data/territory-potential.ts", lines.join("\n"))
console.log("WROTE data/territory-potential.ts")
console.log("sub-regions:", subs.length, "| territories:", terrs.length, "| zips:", zips.length)
console.log("GP/job:", GP_JOB, "| avg:", AVG, "| GM:", GM)
console.log("sub jobs:", r0(subs.reduce((a, s) => a + s.jobs, 0)), "| terr jobs:", r0(terrs.reduce((a, t) => a + t.jobs, 0)), "| sub rev:", r0(subs.reduce((a, s) => a + s.rev, 0)).toLocaleString())
