"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw, AlertTriangle, Download, ChevronRight, Loader2 } from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { resolveRange, RANGE_OPTIONS, defaultCustomRange, type RangeKey, type CustomRange } from "@/lib/date-ranges"
import { DateRangeSelect } from "@/components/date-range-select"
import { FunnelKpi, ZERO_METRICS, pct, type Metrics, type KpiStat } from "@/components/funnel-kpi"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

type DealDetail = {
  id: string
  name: string
  ownerId: string
  ownerName: string
  pipeline: string
  stage: string
  region: string
  subRegion: string
  territory: string
  amount: number
  won: boolean
  quoted: boolean
  apptSet: boolean
  createDate: string | null
  apptDate: string | null
  quotedDate: string | null
  wonDate: string | null
}

type Report = {
  dateFrom: string
  dateTo: string
  owners: { id: string; name: string }[]
  deals: DealDetail[]
}

const ALL = "all"
const UNASSIGNED = "__unassigned__"

// Appointment-centric KPI cards for this page (Contacts / Deals-created are
// intentionally omitted — the report is filtered by appointment date, so the
// meaningful funnel base is Appt set).
const REP_KPIS: { label: string; main: (m: Metrics) => string; stats: (m: Metrics) => KpiStat[] }[] = [
  { label: "Appt set", main: (m) => formatNumber(m.apptSet), stats: () => [] },
  {
    label: "Quoted",
    main: (m) => formatNumber(m.quoted),
    stats: (m) => [{ label: "% of appt", value: pct(m.quoted, m.apptSet) }],
  },
  {
    label: "Closed won",
    main: (m) => formatNumber(m.closedWon),
    stats: (m) => [
      { label: "% of appt", value: pct(m.closedWon, m.apptSet) },
      { label: "% of quoted", value: pct(m.closedWon, m.quoted) },
    ],
  },
  {
    label: "Won revenue",
    main: (m) => formatCurrency(m.revenue),
    stats: (m) => [
      { label: "avg per closed won", value: formatCurrency(m.revenue / Math.max(1, m.closedWon)) },
      { label: "per appt", value: formatCurrency(m.revenue / Math.max(1, m.apptSet)) },
    ],
  },
]

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// Whole days between two ISO dates (null when either is missing).
function daysBetween(aIso: string | null, bIso: string | null): number | null {
  if (!aIso || !bIso) return null
  const a = Date.parse(aIso)
  const b = Date.parse(bIso)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

// Days from creation to close (won) or to today (still open).
function daysInPipeline(d: DealDetail): number | null {
  if (!d.createDate) return null
  const end = d.won && d.wonDate ? d.wonDate : new Date().toISOString()
  return daysBetween(d.createDate, end)
}

// Preset name, or a date range string for a custom selection.
function periodLabel(range: RangeKey, custom: CustomRange): string {
  if (range === "custom") {
    const { dateFrom, dateTo } = resolveRange(range, custom)
    return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
  }
  return RANGE_OPTIONS.find((o) => o.key === range)?.label ?? ""
}

// Newest appointment-scheduled date first; deals with no appointment go last.
function byApptDesc(a: DealDetail, b: DealDetail): number {
  const at = a.apptDate ? Date.parse(a.apptDate) : Number.NEGATIVE_INFINITY
  const bt = b.apptDate ? Date.parse(b.apptDate) : Number.NEGATIVE_INFINITY
  return bt - at
}

export function SalesRepView() {
  const [range, setRange] = useState<RangeKey>("last12")
  const [custom, setCustom] = useState<CustomRange>(defaultCustomRange())
  const [rep, setRep] = useState<string>(ALL)
  const [isExporting, setIsExporting] = useState(false)

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })

  const resolved = useMemo(() => resolveRange(range, custom), [range, custom])

  const report = useQuery({
    queryKey: ["sales-rep-report", resolved.dateFrom, resolved.dateTo],
    queryFn: () =>
      apiPost<Report>("/api/hs/sales-rep-report", { dateFrom: resolved.dateFrom, dateTo: resolved.dateTo }),
    enabled: !!status.data?.configured,
  })

  const deals = report.data?.deals ?? []
  const owners = report.data?.owners ?? []

  // Resolve the selected rep to an owner id (null = all reps).
  const selectedOwnerId = rep === ALL ? null : rep === UNASSIGNED ? "" : rep
  const repLabel = rep === ALL ? "All reps" : owners.find((o) => (o.id || UNASSIGNED) === rep)?.name ?? "Unknown"

  const filtered = useMemo(
    () => (selectedOwnerId === null ? deals : deals.filter((d) => d.ownerId === selectedOwnerId)),
    [deals, selectedOwnerId],
  )

  const sortedDeals = useMemo(() => [...filtered].sort(byApptDesc), [filtered])

  // Appointment-centric funnel metrics for the selected rep. Every deal in the
  // set has an appointment in-range, so apptSet is the base.
  const metrics: Metrics = useMemo(() => {
    let apptSet = 0
    let quoted = 0
    let closedWon = 0
    let revenue = 0
    for (const d of filtered) {
      apptSet++
      if (d.quoted) quoted++
      if (d.won) {
        closedWon++
        revenue += d.amount
      }
    }
    return { ...ZERO_METRICS, apptSet, quoted, closedWon, revenue }
  }, [filtered])

  const periodText = periodLabel(range, custom)

  async function exportPdf() {
    if (isExporting) return
    setIsExporting(true)
    try {
      await buildPdf()
    } catch (err) {
      console.error("[v0] sales-rep PDF export failed:", err)
    } finally {
      setIsExporting(false)
    }
  }

  async function buildPdf() {
    const { default: jsPDF } = await import("jspdf")
    const { default: autoTable } = await import("jspdf-autotable")
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" })

    doc.setFontSize(16)
    doc.setTextColor(30)
    doc.text("Sales Rep Funnel", 40, 42)
    doc.setFontSize(10)
    doc.setTextColor(90)
    doc.text(`${repLabel}  ·  ${periodText}`, 40, 60)
    doc.text(
      `Appt set ${formatNumber(metrics.apptSet)}    Quoted ${formatNumber(
        metrics.quoted,
      )}    Closed won ${formatNumber(metrics.closedWon)}    Won revenue ${formatCurrency(metrics.revenue)}`,
      40,
      76,
    )

    autoTable(doc, {
      startY: 92,
      head: [
        [
          "Deal",
          "Sales rep",
          "Stage",
          "Created",
          "Appt scheduled",
          "Quoted",
          "Closed won",
          "Days in pipeline",
          "Appt -> Won",
          "Amount",
        ],
      ],
      body: sortedDeals.map((d) => {
        const pipe = daysInPipeline(d)
        const aToW = d.won ? daysBetween(d.apptDate, d.wonDate) : null
        return [
          d.name,
          d.ownerName,
          d.stage,
          fmtDate(d.createDate),
          fmtDate(d.apptDate),
          fmtDate(d.quotedDate),
          fmtDate(d.wonDate),
          pipe === null ? "—" : `${pipe}d`,
          aToW === null ? "—" : `${aToW}d`,
          formatCurrency(d.amount),
        ]
      }),
      styles: { fontSize: 8, cellPadding: 3, overflow: "linebreak" },
      headStyles: { fillColor: [241, 88, 45], textColor: 255 },
      columnStyles: { 7: { halign: "right" }, 8: { halign: "right" }, 9: { halign: "right" } },
      margin: { left: 40, right: 40 },
    })

    const slug = repLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "all"
    const filename = `sales-rep-funnel-${slug}.pdf`

    const blob = doc.output("blob")
    const url = URL.createObjectURL(blob)
    const inIframe = typeof window !== "undefined" && window.self !== window.top

    const download = () => {
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
    }

    if (inIframe) {
      // The v0 preview runs inside a sandboxed iframe where a programmatic
      // anchor-download is blocked silently, so open the PDF in a new tab
      // (the user can view/save from there). If the popup is blocked, fall back
      // to the direct download. Outside the iframe, download directly.
      const win = window.open(url, "_blank", "noopener")
      if (!win) download()
    } else {
      download()
    }
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  // Export the deal-detail table (respecting current rep filter + sort) to CSV.
  function exportDealsCsv() {
    const esc = (v: string | number) => {
      const s = String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = [
      "Deal",
      "Sales rep",
      "Pipeline",
      "Stage",
      "Region",
      "Sub-region",
      "Territory",
      "Created",
      "Appt scheduled",
      "Quoted",
      "Closed won",
      "Days in pipeline",
      "Appt to won (days)",
      "Amount",
    ]
    const rows = sortedDeals.map((d) => {
      const pipe = daysInPipeline(d)
      const aToW = d.won ? daysBetween(d.apptDate, d.wonDate) : null
      return [
        d.name,
        d.ownerName,
        d.pipeline,
        d.stage,
        d.region,
        d.subRegion,
        d.territory,
        fmtDate(d.createDate),
        fmtDate(d.apptDate),
        fmtDate(d.quotedDate),
        fmtDate(d.wonDate),
        pipe === null ? "" : pipe,
        aToW === null ? "" : aToW,
        d.amount.toFixed(2),
      ].map(esc).join(",")
    })
    const csv = [header.map(esc).join(","), ...rows].join("\n")
    const slug = repLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "all"
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const inIframe = typeof window !== "undefined" && window.self !== window.top

    const download = () => {
      const a = document.createElement("a")
      a.href = url
      a.download = `sales-rep-deals-${slug}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
    }

    // The v0 preview runs inside a sandboxed iframe where a programmatic
    // anchor-download is blocked silently, so open the CSV in a new tab there
    // (the user can save from it). If the popup is blocked, fall back to the
    // direct download. Outside the iframe, download directly.
    if (inIframe) {
      const win = window.open(url, "_blank", "noopener")
      if (!win) download()
    } else {
      download()
    }
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  if (!status.isLoading && !status.data?.configured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Sales Rep" description="Funnel by sales rep with deal detail." />
        <NotConnected />
      </div>
    )
  }

  const loading = report.isLoading

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Sales Rep" description="Funnel by sales rep with deal-level detail.">
        <DateRangeSelect
          value={range}
          onValueChange={setRange}
          custom={custom}
          onCustomChange={setCustom}
          triggerClassName="w-[170px]"
        />
        <Select value={rep} onValueChange={(v) => v && setRep(v)}>
          <SelectTrigger className="w-[190px]" aria-label="Sales rep">
            <SelectValue>
              {(val) =>
                val === ALL ? "All reps" : owners.find((o) => (o.id || UNASSIGNED) === val)?.name ?? String(val)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All reps</SelectItem>
            {owners.map((o) => (
              <SelectItem key={o.id || UNASSIGNED} value={o.id || UNASSIGNED}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          onClick={exportPdf}
          disabled={!report.data || sortedDeals.length === 0 || report.isFetching || isExporting}
        >
          {isExporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {report.isFetching ? "Loading data…" : isExporting ? "Generating…" : "Export PDF"}
        </Button>
        <Button variant="outline" size="icon" onClick={() => report.refetch()} aria-label="Refresh">
          <RefreshCw className={cn("size-4", report.isFetching && "animate-spin")} />
        </Button>
      </PageHeader>

      {report.isError ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-3 py-4 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {(report.error as Error)?.message || "Failed to load report."}
          </CardContent>
        </Card>
      ) : null}

      {/* KPI cards — appointment funnel (Contacts / Deals created omitted) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {REP_KPIS.map((k) => (
          <FunnelKpi key={k.label} label={k.label} value={k.main(metrics)} stats={k.stats(metrics)} loading={loading} />
        ))}
      </div>

      {/* KPIs by territory hierarchy — same rep + date selection */}
      <TerritoryBreakdown deals={filtered} loading={loading} />

      {/* Deal detail */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            Deal detail
            {!loading ? (
              <span className="text-sm font-normal text-muted-foreground">
                {sortedDeals.length} deals · sorted by appointment date (newest first)
              </span>
            ) : (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />
            )}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={exportDealsCsv}
            disabled={loading || sortedDeals.length === 0}
          >
            <Download className="size-4" />
            Export deal details
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : sortedDeals.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No appointments scheduled for this rep in the selected period.
            </p>
          ) : (
            <div className="max-h-[600px] overflow-auto">
              <table className="w-full min-w-[1040px] text-sm">
                <thead className="sticky top-0 z-10 bg-card">
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-2 text-left font-medium">Deal</th>
                    {rep === ALL ? <th className="px-2 py-2 text-left font-medium">Sales rep</th> : null}
                    <th className="px-2 py-2 text-left font-medium">Stage</th>
                    <th className="px-2 py-2 text-right font-medium">Created</th>
                    <th className="px-2 py-2 text-right font-medium">Appt scheduled</th>
                    <th className="px-2 py-2 text-right font-medium">Quoted</th>
                    <th className="px-2 py-2 text-right font-medium">Closed won</th>
                    <th className="px-2 py-2 text-right font-medium">Days in pipeline</th>
                    <th className="px-2 py-2 text-right font-medium">Appt → Won</th>
                    <th className="pl-2 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedDeals.map((d) => {
                    const pipe = daysInPipeline(d)
                    const aToW = d.won ? daysBetween(d.apptDate, d.wonDate) : null
                    return (
                      <tr key={d.id} className="border-b border-border/50 transition-colors hover:bg-muted/40">
                        <td className="max-w-[16rem] truncate py-1.5 pr-2" title={d.name}>
                          {d.name}
                        </td>
                        {rep === ALL ? (
                          <td className="max-w-[10rem] truncate px-2 py-1.5 text-muted-foreground" title={d.ownerName}>
                            {d.ownerName}
                          </td>
                        ) : null}
                        <td className="px-2 py-1.5">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-xs font-medium",
                              d.won ? "bg-chart-3/15 text-chart-3" : "bg-muted text-muted-foreground",
                            )}
                          >
                            {d.stage}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {fmtDate(d.createDate)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtDate(d.apptDate)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {fmtDate(d.quotedDate)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {fmtDate(d.wonDate)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{pipe === null ? "—" : `${pipe}d`}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {aToW === null ? "—" : `${aToW}d`}
                        </td>
                        <td className="pl-2 py-1.5 text-right font-medium tabular-nums">{formatCurrency(d.amount)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot className="sticky bottom-0 z-10 bg-card">
                  <tr className="border-t-2 bg-muted/40 font-semibold">
                    <td className="py-1.5 pr-2 text-muted-foreground">Total ({sortedDeals.length})</td>
                    {rep === ALL ? <td /> : null}
                    <td />
                    <td />
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(metrics.apptSet)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(metrics.quoted)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      <div>{formatNumber(metrics.closedWon)}</div>
                      <div className="text-[0.7rem] font-normal text-muted-foreground" title="Closed won ÷ quoted">
                        {pct(metrics.closedWon, metrics.quoted)} close/quoted
                      </div>
                    </td>
                    <td />
                    <td />
                    <td className="pl-2 py-1.5 text-right tabular-nums">{formatCurrency(metrics.revenue)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ---- Territory hierarchy breakdown --------------------------------------

type Agg = { appt: number; quoted: number; won: number; revenue: number }
type TerrNode = { name: string; agg: Agg }
type SubNode = { name: string; agg: Agg; territories: TerrNode[] }
type RegionNode = { name: string; agg: Agg; subRegions: SubNode[] }

function emptyAgg(): Agg {
  return { appt: 0, quoted: 0, won: 0, revenue: 0 }
}
function addTo(a: Agg, d: DealDetail) {
  a.appt++
  if (d.quoted) a.quoted++
  if (d.won) {
    a.won++
    a.revenue += d.amount
  }
}
const byRevDesc = (a: { agg: Agg }, b: { agg: Agg }) => b.agg.revenue - a.agg.revenue || b.agg.appt - a.agg.appt

// Build region -> sub-region -> territory tree from the deal set.
function buildTree(deals: DealDetail[]): RegionNode[] {
  const regions = new Map<string, { agg: Agg; subs: Map<string, { agg: Agg; terrs: Map<string, Agg> }> }>()
  for (const d of deals) {
    let r = regions.get(d.region)
    if (!r) {
      r = { agg: emptyAgg(), subs: new Map() }
      regions.set(d.region, r)
    }
    addTo(r.agg, d)
    let s = r.subs.get(d.subRegion)
    if (!s) {
      s = { agg: emptyAgg(), terrs: new Map() }
      r.subs.set(d.subRegion, s)
    }
    addTo(s.agg, d)
    let t = s.terrs.get(d.territory)
    if (!t) {
      t = emptyAgg()
      s.terrs.set(d.territory, t)
    }
    addTo(t, d)
  }
  return Array.from(regions, ([name, r]) => ({
    name,
    agg: r.agg,
    subRegions: Array.from(r.subs, ([sn, s]) => ({
      name: sn,
      agg: s.agg,
      territories: Array.from(s.terrs, ([tn, agg]) => ({ name: tn, agg })).sort(byRevDesc),
    })).sort(byRevDesc),
  })).sort(byRevDesc)
}

function AggCells({ agg }: { agg: Agg }) {
  return (
    <>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(agg.appt)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(agg.quoted)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(agg.won)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{pct(agg.won, agg.appt)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{pct(agg.won, agg.quoted)}</td>
      <td className="pl-2 py-1.5 text-right font-medium tabular-nums">{formatCurrency(agg.revenue)}</td>
    </>
  )
}

function TerritoryBreakdown({ deals, loading }: { deals: DealDetail[]; loading?: boolean }) {
  const tree = useMemo(() => buildTree(deals), [deals])
  const total = useMemo(() => {
    const a = emptyAgg()
    for (const d of deals) addTo(a, d)
    return a
  }, [deals])
  // Default collapsed: an empty set means nothing is expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          By territory
          {!loading ? (
            <span className="text-sm font-normal text-muted-foreground">
              region › sub-region › territory · same period &amp; rep
            </span>
          ) : (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : deals.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No territory data for the current selection.</p>
        ) : (
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-2 text-left font-medium">Territory</th>
                  <th className="px-2 py-2 text-right font-medium">Appt</th>
                  <th className="px-2 py-2 text-right font-medium">Quoted</th>
                  <th className="px-2 py-2 text-right font-medium">Closed won</th>
                  <th className="px-2 py-2 text-right font-medium" title="Closed won ÷ appointments">
                    Won %
                  </th>
                  <th className="px-2 py-2 text-right font-medium" title="Closed won ÷ quoted">
                    Close/Quoted %
                  </th>
                  <th className="pl-2 py-2 text-right font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {tree.map((region) => {
                  const rKey = region.name
                  const rOpen = expanded.has(rKey)
                  return (
                    <FragmentRegion
                      key={rKey}
                      region={region}
                      rKey={rKey}
                      rOpen={rOpen}
                      expanded={expanded}
                      toggle={toggle}
                    />
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="py-1.5 pr-2 text-muted-foreground">Total</td>
                  <AggCells agg={total} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function FragmentRegion({
  region,
  rKey,
  rOpen,
  expanded,
  toggle,
}: {
  region: RegionNode
  rKey: string
  rOpen: boolean
  expanded: Set<string>
  toggle: (key: string) => void
}) {
  return (
    <>
      <tr className="cursor-pointer border-b bg-muted/60 font-semibold hover:bg-muted" onClick={() => toggle(rKey)}>
        <td className="py-1.5 pr-2">
          <span className="flex items-center gap-1">
            <ChevronRight className={cn("size-3.5 transition-transform", rOpen && "rotate-90")} />
            <span className="truncate">{region.name}</span>
          </span>
        </td>
        <AggCells agg={region.agg} />
      </tr>
      {rOpen
        ? region.subRegions.map((sub) => {
            const sKey = `${rKey}|||${sub.name}`
            const sOpen = expanded.has(sKey)
            return (
              <FragmentSub key={sKey} sub={sub} sKey={sKey} sOpen={sOpen} toggle={toggle} />
            )
          })
        : null}
    </>
  )
}

function FragmentSub({
  sub,
  sKey,
  sOpen,
  toggle,
}: {
  sub: SubNode
  sKey: string
  sOpen: boolean
  toggle: (key: string) => void
}) {
  return (
    <>
      <tr className="cursor-pointer border-b border-border/60 bg-muted/20 hover:bg-muted/40" onClick={() => toggle(sKey)}>
        <td className="py-1.5 pl-6 pr-2">
          <span className="flex items-center gap-1">
            <ChevronRight className={cn("size-3.5 transition-transform", sOpen && "rotate-90")} />
            <span className="truncate">{sub.name}</span>
          </span>
        </td>
        <AggCells agg={sub.agg} />
      </tr>
      {sOpen
        ? sub.territories.map((terr) => (
            <tr key={`${sKey}|||${terr.name}`} className="border-b border-border/40 hover:bg-muted/30">
              <td className="max-w-[18rem] truncate py-1.5 pl-10 pr-2 text-muted-foreground" title={terr.name}>
                {terr.name}
              </td>
              <AggCells agg={terr.agg} />
            </tr>
          ))
        : null}
    </>
  )
}
