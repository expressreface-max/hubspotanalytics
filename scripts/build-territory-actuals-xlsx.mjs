// Builds a styled workbook that adds trailing-12-month closed-won ACTUALS (from HubSpot)
// to the Supabase-reconciled 48-territory potential model, with over/under-performance
// highlighting. Joins actuals by EXACT territory name (er_territory) since the reconciled
// carve names match HubSpot 1:1. Preserves all original sheets and adds an analysis sheet
// with sub-region rows + indented territory rows for every sub-region.
//
// Run: set -a; . /vercel/share/.env.project; set +a; node scripts/build-territory-actuals-xlsx.mjs
import { read, utils } from "xlsx"
import ExcelJS from "exceljs"
import fs from "fs"

const SRC = "data/sacbay_territory_potential_reconciled-fce222.xlsx"
const OUT = "data/territory_potential_with_actuals.xlsx"
const TOKEN = process.env.HUBSPOT_TOKEN
if (!TOKEN) throw new Error("HUBSPOT_TOKEN not set")

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

// --- 1. Potential (0.30% calibrated) from the reconciled Territory Detail sheet ---
// cols: 0 REGION,1 SUB-REGION,3 TERRITORY,7 LP LEADS,12 JOBS/YR(0.3),14 REVENUE(0.3),15 GP(0.3)
const wb = read(fs.readFileSync(SRC), { cellDates: true })
const td = utils.sheet_to_json(wb.Sheets["Territory Detail"], { header: 1, blankrows: false })
const territories = []
const subMap = new Map()
for (let i = 4; i < td.length; i++) {
  const r = td[i]
  if (!r || !r[3]) continue
  const region = String(r[0]).trim(), sub = String(r[1]).trim(), name = String(r[3]).trim()
  const lp = Number(r[7] || 0), j30 = Number(r[12] || 0), rv30 = Number(r[14] || 0)
  territories.push({ region, sub, name, lp, jobs30: j30, rev30: rv30 })
  const c = subMap.get(sub) || { sub, region, terrCt: 0, lp: 0, jobs30: 0, rev30: 0 }
  c.terrCt++
  c.lp += lp
  c.jobs30 += j30
  c.rev30 += rv30
  subMap.set(sub, c)
}

// --- 2. HubSpot T12M closed-won actuals by er_sub_region AND er_territory ---
const now = Date.now()
const from = now - 365 * 24 * 3600 * 1000
async function searchAll() {
  let after
  const out = []
  for (let pg = 0; pg < 60; pg++) {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
        { propertyName: "closedate", operator: "GTE", value: String(from) },
        { propertyName: "closedate", operator: "LTE", value: String(now) },
      ] }],
      properties: ["amount", "er_sub_region", "er_territory", "er_region"],
      limit: 100,
    }
    if (after) body.after = after
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const j = await res.json()
    if (j.status === "error") throw new Error(j.message)
    out.push(...(j.results || []))
    after = j.paging?.next?.after
    if (!after) break
  }
  return out
}
const deals = await searchAll()
const actMap = new Map()
const terrActMap = new Map()
for (const d of deals) {
  const s = (d.properties.er_sub_region || "").trim()
  if (s) {
    const c = actMap.get(norm(s)) || { name: s, region: (d.properties.er_region || "").trim(), jobs: 0, rev: 0 }
    c.jobs++
    c.rev += Number(d.properties.amount || 0)
    actMap.set(norm(s), c)
  }
  const t = (d.properties.er_territory || "").trim()
  if (t) {
    const tc = terrActMap.get(norm(t)) || { jobs: 0, rev: 0 }
    tc.jobs++
    tc.rev += Number(d.properties.amount || 0)
    terrActMap.set(norm(t), tc)
  }
}

const statusOf = (aj, pj) => (pj <= 0 ? "under" : aj >= pj ? "over" : aj >= 0.5 * pj ? "on_pace" : "under")

// Territory-level rows per sub-region (exact-name join).
function territoriesFor(sub) {
  return territories
    .filter((t) => norm(t.sub) === norm(sub))
    .map((t) => {
      const a = terrActMap.get(norm(t.name)) || { jobs: 0, rev: 0 }
      return { ...t, actJobs: a.jobs, actRev: a.rev, jobsAtt: t.jobs30 > 0 ? a.jobs / t.jobs30 : 0, status: statusOf(a.jobs, t.jobs30), entered: a.jobs > 0 }
    })
    .sort((x, y) => y.jobsAtt - x.jobsAtt)
}

// --- 3. Join: potential sub-regions + their actuals ---
const rows = [...subMap.values()].map((p) => {
  const a = actMap.get(norm(p.sub)) || { jobs: 0, rev: 0 }
  return { ...p, actJobs: a.jobs, actRev: a.rev, jobsAtt: p.jobs30 > 0 ? a.jobs / p.jobs30 : 0, revAtt: p.rev30 > 0 ? a.rev / p.rev30 : 0, status: statusOf(a.jobs, p.jobs30) }
})
rows.sort((x, y) => y.jobsAtt - x.jobsAtt)

const matched = new Set([...subMap.values()].map((p) => norm(p.sub)))
const outOfModel = [...actMap.values()].filter((a) => !matched.has(norm(a.name))).sort((x, y) => y.jobs - x.jobs)

// --- 4. Write styled workbook (load original to preserve sheets, add analysis sheet) ---
const out = new ExcelJS.Workbook()
await out.xlsx.readFile(SRC)

const ws = out.addWorksheet("Actuals vs Potential (T12M)", { views: [{ state: "frozen", ySplit: 5 }] })
const FILL = { over: "FFC6EFCE", on_pace: "FFFFEB9C", under: "FFFFC7CE", header: "FF1F2937", total: "FFE5E7EB", none: "FFF3F4F6" }
const FONT = { over: "FF006100", on_pace: "FF9C6500", under: "FF9C0006" }
const STATUS_LABEL = { over: "Overperforming", on_pace: "On pace", under: "Underperforming" }

const win = `${new Date(from).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)}`
ws.mergeCells("A1:L1")
ws.getCell("A1").value = "ACTUALS vs POTENTIAL — trailing 12 months closed-won (Supabase-reconciled 48-territory carve)"
ws.getCell("A1").font = { bold: true, size: 14 }
ws.mergeCells("A2:L2")
ws.getCell("A2").value = `Potential = 0.30% calibrated scenario · Actuals = HubSpot closed-won ${win} · joined by exact er_territory · $16,000 avg sale · 65% GM`
ws.getCell("A2").font = { italic: true, color: { argb: "FF6B7280" } }
ws.mergeCells("A3:L3")
ws.getCell("A3").value = "Bold rows = sub-regions; indented rows = territories. Green = at/above 0.30% target · amber = 50-99% (on pace) · red = below 50%"
ws.getCell("A3").font = { italic: true, color: { argb: "FF6B7280" } }

const headers = ["Region", "Sub-Region / Territory", "Terr Ct", "LP Leads", "Potential Jobs/Yr", "Potential Rev/Yr", "Actual Jobs (T12M)", "Actual Rev (T12M)", "Jobs Attainment", "Rev Attainment", "Actual Avg Sale", "Status"]
const headerRow = ws.getRow(5)
headers.forEach((h, i) => {
  const c = headerRow.getCell(i + 1)
  c.value = h
  c.font = { bold: true, color: { argb: "FFFFFFFF" } }
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL.header } }
  c.alignment = { vertical: "middle", wrapText: true, horizontal: i < 2 ? "left" : "center" }
})
headerRow.height = 30

let rIdx = 6
for (const r of rows) {
  const row = ws.getRow(rIdx++)
  row.values = [r.region, r.sub, r.terrCt, r.lp, r.jobs30, r.rev30, r.actJobs, r.actRev, r.jobsAtt, r.revAtt, r.actJobs > 0 ? r.actRev / r.actJobs : 0, STATUS_LABEL[r.status]]
  row.getCell(2).font = { bold: true }
  row.getCell(6).numFmt = "$#,##0"
  row.getCell(8).numFmt = "$#,##0"
  row.getCell(11).numFmt = "$#,##0"
  row.getCell(9).numFmt = "0%"
  row.getCell(10).numFmt = "0%"
  const statusCell = row.getCell(12)
  statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[r.status] } }
  statusCell.font = { bold: true, color: { argb: FONT[r.status] } }
  row.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[r.status] } }
  row.getCell(9).font = { bold: true, color: { argb: FONT[r.status] } }

  // Territory-level breakdown for every sub-region (exact-name join).
  for (const t of territoriesFor(r.sub)) {
    const trow = ws.getRow(rIdx++)
    const statusLabel = t.entered ? STATUS_LABEL[t.status] : "Not entered yet"
    trow.values = ["", `    ${t.name}`, "", t.lp, t.jobs30, t.rev30, t.actJobs, t.actRev, t.jobsAtt, t.rev30 > 0 ? t.actRev / t.rev30 : 0, t.actJobs > 0 ? t.actRev / t.actJobs : 0, statusLabel]
    trow.getCell(2).font = { italic: true, color: { argb: "FF6B7280" } }
    trow.getCell(6).numFmt = "$#,##0"
    trow.getCell(8).numFmt = "$#,##0"
    trow.getCell(11).numFmt = "$#,##0"
    trow.getCell(9).numFmt = "0%"
    trow.getCell(10).numFmt = "0%"
    const fill = t.entered ? FILL[t.status] : FILL.none
    const font = t.entered ? FONT[t.status] : "FF9CA3AF"
    trow.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } }
    trow.getCell(9).font = { color: { argb: font } }
    trow.getCell(12).font = { italic: true, size: 10, color: { argb: font } }
  }
}

// totals
const tot = rows.reduce((a, r) => ({ lp: a.lp + r.lp, pj: a.pj + r.jobs30, pr: a.pr + r.rev30, aj: a.aj + r.actJobs, ar: a.ar + r.actRev, tc: a.tc + r.terrCt }), { lp: 0, pj: 0, pr: 0, aj: 0, ar: 0, tc: 0 })
const totRow = ws.getRow(rIdx++)
totRow.values = ["", "TOTAL (in model)", tot.tc, tot.lp, tot.pj, tot.pr, tot.aj, tot.ar, tot.pj > 0 ? tot.aj / tot.pj : 0, tot.pr > 0 ? tot.ar / tot.pr : 0, tot.aj > 0 ? tot.ar / tot.aj : 0, ""]
totRow.eachCell((c) => { c.font = { bold: true }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL.total } } })
totRow.getCell(6).numFmt = "$#,##0"
totRow.getCell(8).numFmt = "$#,##0"
totRow.getCell(11).numFmt = "$#,##0"
totRow.getCell(9).numFmt = "0%"
totRow.getCell(10).numFmt = "0%"

// out-of-model block
rIdx++
const omTitle = ws.getRow(rIdx++)
omTitle.getCell(1).value = "OUT-OF-MODEL ACTUALS (HubSpot sub-regions outside the Sac + Bay LP universe)"
omTitle.getCell(1).font = { bold: true, italic: true, color: { argb: "FF6B7280" } }
for (const a of outOfModel) {
  const row = ws.getRow(rIdx++)
  row.values = [a.region || "—", a.name, "", "", "", "", a.jobs, a.rev, "", "", a.jobs > 0 ? a.rev / a.jobs : 0, "Out of model"]
  row.getCell(8).numFmt = "$#,##0"
  row.getCell(11).numFmt = "$#,##0"
  row.getCell(12).font = { italic: true, color: { argb: "FF6B7280" } }
}

ws.columns.forEach((col, i) => { col.width = i < 2 ? 40 : 15 })

await out.xlsx.writeFile(OUT)
console.log("Wrote", OUT)
console.log("In-model sub-regions:", rows.length, "| territories:", territories.length, "| deals:", deals.length)
const totalAct = rows.reduce((a, r) => a + r.actJobs, 0)
console.log("in-model actual jobs:", totalAct, "| attainment", Math.round((totalAct / tot.pj) * 100) + "%", "(" + totalAct + "/" + tot.pj + ")")
console.log("Over:", rows.filter((r) => r.status === "over").map((r) => r.sub).join(", ") || "(none)")
console.log("On pace:", rows.filter((r) => r.status === "on_pace").map((r) => r.sub).join(", "))
console.log("Out-of-model:", outOfModel.map((a) => `${a.name} (${a.jobs})`).join(", "))
