"use client"

  import { Fragment, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, RefreshCw, AlertTriangle, Download, Search, Globe, Layers, Sparkles } from "lucide-react"
import { DealAnalysisDialog } from "@/components/deal-analysis-dialog"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { resolveRange, RANGE_OPTIONS, defaultCustomRange, type RangeKey, type CustomRange } from "@/lib/date-ranges"
import { DateRangeSelect } from "@/components/date-range-select"
import { FunnelKpi, KPI_CONFIG, ZERO_METRICS, deltaPct, type Metrics } from "@/components/funnel-kpi"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { ClosedWonSection } from "@/components/closed-won-section"
 import { ScheduledDealsSection } from "@/components/scheduled-deals-section"
import { ErContractDealsSection } from "@/components/er-contract-deals-section"
import { ApptNotQuotedSection } from "@/components/appt-not-quoted-section"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

type Node = {
  name: string
  metrics: Metrics
  wonByPipeline?: Record<string, number>
  children?: Node[]
}
type PanelRow = { name: string; contactsCreated: number; apptSet: number; closedWon: number; revenue: number }
type Penetration = {
  territory: string
  households: number
  jobs: number
  penetration: number
  dollarsPerHousehold: number
}
type RepDeal = {
  id: string
  name: string
  amount: number
  appt: boolean
  quoted: boolean
  won: boolean
  currentlyQuoted: boolean
  currentlyAppt: boolean
  quotedEnteredMs: number | null
  territory: string
}
type RepRow = {
  name: string
  created: number
  apptSet: number
  quoted: number
  closedWon: number
  revenue: number
  deals?: RepDeal[]
}
type Report = {
  dateFrom: string
  dateTo: string
  totals: Metrics
  inPeriodTotals: Metrics
  inPeriodRevenueSplit?: RevenueSplit
  dealCount: number
  contactCount: number
  unmappedRemaining: number
  hierarchy: Node[]
  topTerritories: PanelRow[]
  topSubRegions: PanelRow[]
  topRegions: PanelRow[]
  penetration: Penetration[]
  byRep: RepRow[]
}

// Stable badge colors for the "Won by pipeline" column.
const PIPELINE_BADGE_COLORS: Record<string, string> = {
  ER: "bg-primary/15 text-primary",
  BV: "bg-chart-2/15 text-chart-2",
  CT: "bg-chart-3/15 text-chart-3",
  "BV-A": "bg-chart-5/15 text-chart-5",
  BV25: "bg-chart-2/15 text-chart-2",
  MFR: "bg-chart-4/15 text-chart-4",
  MFB: "bg-chart-4/15 text-chart-4",
  SFB: "bg-chart-5/15 text-chart-5",
}

function ratio(num: number, den: number): string {
  if (!den) return "—"
  if (!num) return "0%"
  return `${Math.round((num / den) * 100)}%`
}

function PipelineBadges({ won }: { won?: Record<string, number> }) {
  const entries = Object.entries(won ?? {}).sort((a, b) => b[1] - a[1])
  if (!entries.length) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {entries.map(([abbr, count]) => (
        <span
          key={abbr}
          className={cn(
            "rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums",
            PIPELINE_BADGE_COLORS[abbr] ?? "bg-muted text-muted-foreground",
          )}
        >
          {abbr}: {count}
        </span>
      ))}
    </div>
  )
}

const DEPTH_ICON = [Globe, Layers, Layers, null]

function TreeRow({
  node,
  depth,
  defaultOpen,
}: {
  node: Node
  depth: number
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const hasChildren = !!node.children?.length
  const m = node.metrics
  const Icon = DEPTH_ICON[Math.min(depth, 3)]

  return (
    <>
      <tr className="border-b border-border/60 transition-colors hover:bg-muted/40">
        <td className="py-2.5 pr-2">
          <button
            type="button"
            onClick={() => hasChildren && setOpen((o) => !o)}
            className={cn("flex items-center gap-1.5 text-left", !hasChildren && "cursor-default")}
            style={{ paddingLeft: depth * 18 }}
          >
            {hasChildren ? (
              <ChevronRight
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90",
                )}
              />
            ) : (
              <span className="inline-block size-4 shrink-0" />
            )}
            {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
            <span className={cn("truncate", depth === 0 ? "font-bold" : depth === 1 ? "font-semibold" : "font-medium")}>
              {node.name}
            </span>
          </button>
        </td>
        <td className="px-2 text-right tabular-nums">{formatNumber(m.contactsCreated)}</td>
        <td className="px-2 text-right tabular-nums">{formatNumber(m.created)}</td>
        <td className="px-2 text-right tabular-nums">{formatNumber(m.apptSet)}</td>
        <td className="px-2 text-right tabular-nums text-muted-foreground">{ratio(m.apptSet, m.created)}</td>
        <td className="px-2 text-right tabular-nums">{formatNumber(m.quoted)}</td>
        <td className="px-2 text-right tabular-nums text-muted-foreground">{ratio(m.quoted, m.apptSet)}</td>
        <td className="px-2 text-right font-medium tabular-nums">{formatNumber(m.closedWon)}</td>
        <td className="px-2 text-right tabular-nums text-muted-foreground">{ratio(m.closedWon, m.created)}</td>
        <td className="px-2 text-right tabular-nums text-muted-foreground">{ratio(m.closedWon, m.apptSet)}</td>
        <td className="px-2 text-right tabular-nums text-muted-foreground">{ratio(m.closedWon, m.quoted)}</td>
        <td className="px-2 text-right">
          <PipelineBadges won={node.wonByPipeline} />
        </td>
        <td className="pl-2 text-right font-medium tabular-nums">{formatCurrency(m.revenue)}</td>
      </tr>
      {open && hasChildren
        ? node.children!.map((child, i) => (
            <TreeRow key={`${child.name}-${i}`} node={child} depth={depth + 1} defaultOpen={defaultOpen} />
          ))
        : null}
    </>
  )
}

type RevenueSplit = {
  reface: number
  countertop: number
  total: number
  refaceCount: number
  countertopCount: number
}

// Won revenue for the period, split into cabinet (reface) vs countertops.
// Uses the in-period split (won deals whose close date is in the window).
function RevenueSplitCard({
  split,
  wonCount,
  loading,
  periodText,
}: {
  split?: RevenueSplit
  wonCount?: number
  loading?: boolean
  periodText: string
}) {
  const s = split ?? { reface: 0, countertop: 0, total: 0, refaceCount: 0, countertopCount: 0 }
  const perJob = (amt: number, n: number) => (n > 0 ? formatCurrency(amt / n) : "—")
  const share = (amt: number) => (s.total > 0 ? `${Math.round((amt / s.total) * 100)}%` : "—")

  // Estimated gross-profit margins by product line.
  const CABINET_GP_RATE = 0.72
  const COUNTERTOP_GP_RATE = 0.35

  const segments = [
    {
      key: "cabinet",
      label: "Cabinet",
      amount: s.reface,
      count: s.refaceCount,
      gpRate: CABINET_GP_RATE,
      barClass: "bg-primary",
      dotClass: "bg-primary",
    },
    {
      key: "countertops",
      label: "Countertops",
      amount: s.countertop,
      count: s.countertopCount,
      gpRate: COUNTERTOP_GP_RATE,
      barClass: "bg-chart-2",
      dotClass: "bg-chart-2",
    },
  ]

  // Estimated gross profit: cabinet at 72%, countertops at 35%.
  const totalGrossProfit = segments.reduce((sum, seg) => sum + seg.amount * seg.gpRate, 0)
  const totalGpPct = s.total > 0 ? (totalGrossProfit / s.total) * 100 : 0

  // Total won jobs = won deal count in period (segment counts double-count deals
  // that carry both a cabinet and a countertop amount).
  const jobs = wonCount ?? 0
  const revenuePerJob = jobs > 0 ? s.total / jobs : 0
  const gpPerJob = jobs > 0 ? totalGrossProfit / jobs : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Won revenue split
          <span className="ml-2 text-sm font-normal text-muted-foreground">cabinet vs countertops · {periodText}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-2 w-full" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Total won revenue
                </div>
                <div className="mt-1 num text-3xl font-bold">{formatCurrency(s.total)}</div>
              </div>
              <div className="sm:border-l sm:pl-4">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Est. gross profit
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="num text-3xl font-bold text-chart-3">{formatCurrency(totalGrossProfit)}</span>
                  <span className="text-sm font-medium text-muted-foreground">{totalGpPct.toFixed(1)}% margin</span>
                </div>
              </div>
            </div>

            {/* Per-job metrics across all won jobs in the period */}
            <div className="grid grid-cols-3 gap-4 rounded-lg border bg-muted/30 p-4">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Jobs won</div>
                <div className="mt-1 num text-xl font-bold">{formatNumber(jobs)}</div>
              </div>
              <div className="border-l pl-4">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Revenue / job</div>
                <div className="mt-1 num text-xl font-bold">{jobs > 0 ? formatCurrency(revenuePerJob) : "—"}</div>
              </div>
              <div className="border-l pl-4">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Est. GP / job
                </div>
                <div className="mt-1 num text-xl font-bold text-chart-3">
                  {jobs > 0 ? formatCurrency(gpPerJob) : "—"}
                </div>
              </div>
            </div>

            {/* Proportional bar */}
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
              {segments.map((seg) =>
                s.total > 0 && seg.amount > 0 ? (
                  <div
                    key={seg.key}
                    className={cn("h-full", seg.barClass)}
                    style={{ width: `${Math.min(100, (seg.amount / s.total) * 100)}%` }}
                  />
                ) : null,
              )}
            </div>

            {/* Segment detail */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {segments.map((seg) => (
                <div key={seg.key} className="rounded-lg border bg-muted/30 p-4">
                  <div className="flex items-center gap-2">
                    <span className={cn("size-2.5 rounded-full", seg.dotClass)} aria-hidden />
                    <span className="text-sm font-medium">{seg.label}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{share(seg.amount)} of total</span>
                  </div>
                  <div className="mt-2 num text-2xl font-bold">{formatCurrency(seg.amount)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatNumber(seg.count)} jobs · {perJob(seg.amount, seg.count)}/job
                  </div>
                  <div className="mt-2 flex items-baseline gap-2 border-t pt-2">
                    <span className="num text-sm font-semibold text-chart-3">
                      {formatCurrency(seg.amount * seg.gpRate)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      est. GP · {Math.round(seg.gpRate * 100)}% margin
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// Each tab ranks the panel by a single metric.
const PANEL_METRICS = [
  { key: "contactsCreated", label: "Contacts", header: "Contacts", format: formatNumber },
  { key: "apptSet", label: "Appointments", header: "Appts", format: formatNumber },
  { key: "revenue", label: "Revenue", header: "Revenue", format: formatCurrency },
] as const
type PanelMetricKey = (typeof PANEL_METRICS)[number]["key"]

function TopPanel({
  title,
  rows,
  loading,
  limit,
}: {
  title: string
  rows: PanelRow[]
  loading?: boolean
  limit: number
}) {
  const [metric, setMetric] = useState<PanelMetricKey>("revenue")
  const active = PANEL_METRICS.find((m) => m.key === metric)!

  const ranked = useMemo(
    () => [...rows].sort((a, b) => b[metric] - a[metric]).slice(0, limit),
    [rows, metric, limit],
  )

  return (
    <Card>
      <CardHeader className="gap-3 pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <Tabs value={metric} onValueChange={(v) => setMetric((v as PanelMetricKey) ?? "revenue")}>
          <TabsList className="w-full">
            {PANEL_METRICS.map((m) => (
              <TabsTrigger key={m.key} value={m.key} className="flex-1 text-xs">
                {m.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th className="w-6 py-1.5 text-left font-medium">#</th>
                <th className="py-1.5 text-left font-medium">Name</th>
                <th className="w-28 py-1.5 text-right font-medium">{active.header}</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((r, i) => (
                <tr key={r.name} className={cn("border-b border-border/50", i === 0 && "bg-primary/5")}>
                  <td className="py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
                  <td className="max-w-0 truncate py-1.5 pr-2" title={r.name}>
                    {r.name}
                  </td>
                  <td className="py-1.5 text-right font-medium tabular-nums">{active.format(r[metric])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}

function PenetrationCard({
  rows,
  loading,
  rangeLabel,
}: {
  rows: Penetration[]
  loading?: boolean
  rangeLabel: string
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Territory Penetration — {rangeLabel}</CardTitle>
        <p className="text-sm text-muted-foreground">Jobs won ÷ owner-occupied HH · ranked by penetration %</p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No household data available for these territories.</p>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="w-6 py-1.5 text-left font-medium">#</th>
                  <th className="py-1.5 text-left font-medium">Territory</th>
                  <th className="px-2 py-1.5 text-right font-medium">HH</th>
                  <th className="px-2 py-1.5 text-right font-medium">Jobs</th>
                  <th className="px-2 py-1.5 text-right font-medium">Penet.</th>
                  <th className="py-1.5 text-right font-medium">$/HH</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.territory} className={cn("border-b border-border/50", i === 0 && "bg-primary/5")}>
                    <td className="py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
                    <td className="truncate py-1.5 pr-2">{r.territory}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatNumber(r.households)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(r.jobs)}</td>
                    <td className="px-2 py-1.5 text-right font-medium tabular-nums text-chart-3">
                      {(r.penetration * 100).toFixed(3)}%
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {formatCurrency(r.dollarsPerHousehold)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const REP_METRICS = [
  { key: "apptSet", label: "Appointments" },
  { key: "quoted", label: "Quoted" },
  { key: "closedWon", label: "Closed Won" },
  { key: "wonPerQuoted", label: "Won/Quoted %" },
  { key: "closeRate", label: "Close %" },
  { key: "revenue", label: "Revenue" },
  { key: "avgSale", label: "Avg Sale" },
] as const
type RepMetricKey = (typeof REP_METRICS)[number]["key"]

// Close % = closed won / appointments (0 when no appointments).
function repCloseRate(r: { closedWon: number; apptSet: number }): number {
  return r.apptSet > 0 ? r.closedWon / r.apptSet : 0
}

// Won/Quoted % = closed won / quoted (0 when nothing quoted).
function repWonPerQuoted(r: { closedWon: number; quoted: number }): number {
  return r.quoted > 0 ? r.closedWon / r.quoted : 0
}

// Avg sale = revenue / closed won (0 when no wins).
function repAvgSale(r: { revenue: number; closedWon: number }): number {
  return r.closedWon > 0 ? r.revenue / r.closedWon : 0
}

function repMetricValue(r: RepRow, key: RepMetricKey): number {
  if (key === "closeRate") return repCloseRate(r)
  if (key === "wonPerQuoted") return repWonPerQuoted(r)
  if (key === "avgSale") return repAvgSale(r)
  return r[key]
}

// Days a deal has been sitting in its current Quoted stage (now - entered date).
function daysInQuoted(d: RepDeal): number | null {
  if (d.quotedEnteredMs == null) return null
  return Math.max(0, Math.round((Date.now() - d.quotedEnteredMs) / 86_400_000))
}

// Expanded deal detail for one rep. Closed won is in-period funnel activity, but
// the other two groups are CURRENT-STATE snapshots of this rep's live pipeline:
//   - Quoted (open)  = deals whose current stage is a Quoted stage right now,
//     showing days in the Quoted stage (sorted oldest -> newest) + deal amount.
//   - Appointment    = deals whose current stage is Appointment scheduled, with
//     deal amount (if any).
function RepDealDetail({ deals }: { deals: RepDeal[] }) {
  const [analyzeDeal, setAnalyzeDeal] = useState<RepDeal | null>(null)

  const quotedItems = deals
    .filter((d) => d.currentlyQuoted)
    // Oldest first: most days in the Quoted stage at the top (nulls last).
    .sort((a, b) => (daysInQuoted(b) ?? -1) - (daysInQuoted(a) ?? -1))
  const apptItems = deals
    .filter((d) => d.currentlyAppt)
    .sort((a, b) => b.amount - a.amount)

  const groups = [
    { key: "won", label: "Closed won", dotClass: "bg-chart-3", showDays: false, canAnalyze: false, items: deals.filter((d) => d.won) },
    { key: "quoted", label: "Quoted (open)", dotClass: "bg-primary", showDays: true, canAnalyze: true, items: quotedItems },
    {
      key: "appt",
      label: "Appointment scheduled",
      dotClass: "bg-muted-foreground",
      showDays: false,
      canAnalyze: false,
      items: apptItems,
    },
  ].filter((g) => g.items.length > 0)

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {groups.map((g) => (
        <div key={g.key} className="rounded-md border bg-card p-2">
          <div className="mb-1.5 flex items-center gap-1.5 border-b pb-1.5">
            <span className={cn("size-2 rounded-full", g.dotClass)} aria-hidden />
            <span className="text-xs font-semibold">{g.label}</span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">{g.items.length}</span>
          </div>
          <ul className="flex flex-col gap-1">
            {g.items.map((d) => {
              const days = g.showDays ? daysInQuoted(d) : null
              return (
                <li key={d.id} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={d.name}>
                      {d.name}
                    </span>
                    <span className="block truncate text-[0.7rem] text-muted-foreground">
                      {g.showDays ? (days == null ? "—" : `${days}d in quoted`) : d.territory && d.territory !== "Unmapped" ? d.territory : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="tabular-nums text-muted-foreground">
                      {d.amount > 0 ? formatCurrency(d.amount) : "—"}
                    </span>
                    {g.canAnalyze && (
                      <button
                        type="button"
                        onClick={() => setAnalyzeDeal(d)}
                        title="AI analyze this deal"
                        aria-label={`AI analyze ${d.name}`}
                        className="flex size-6 items-center justify-center rounded-md border border-primary/30 bg-primary/5 text-primary transition-colors hover:bg-primary/15"
                      >
                        <Sparkles className="size-3.5" aria-hidden />
                      </button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      <DealAnalysisDialog
        dealId={analyzeDeal?.id ?? null}
        dealName={analyzeDeal?.name ?? null}
        open={!!analyzeDeal}
        onOpenChange={(v) => {
          if (!v) setAnalyzeDeal(null)
        }}
      />
    </div>
  )
}

function SalesRepCard({ rows, loading }: { rows: RepRow[]; loading?: boolean }) {
  const [sortBy, setSortBy] = useState<RepMetricKey>("revenue")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const ranked = useMemo(
    () => [...rows].sort((a, b) => repMetricValue(b, sortBy) - repMetricValue(a, sortBy)),
    [rows, sortBy],
  )

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.apptSet += r.apptSet
          acc.quoted += r.quoted
          acc.closedWon += r.closedWon
          acc.revenue += r.revenue
          return acc
        },
        { apptSet: 0, quoted: 0, closedWon: 0, revenue: 0 },
      ),
    [rows],
  )

  const th = (m: (typeof REP_METRICS)[number]) => (
    <th key={m.key} className="px-2 py-1.5 text-right font-medium">
      <button
        type="button"
        onClick={() => setSortBy(m.key)}
        className={cn(
          "uppercase tracking-wide transition-colors hover:text-foreground",
          sortBy === m.key ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {m.label}
        {sortBy === m.key ? " ↓" : ""}
      </button>
    </th>
  )

  const formatRep = (value: number, key: RepMetricKey) =>
    key === "revenue" || key === "avgSale"
      ? formatCurrency(value)
      : key === "closeRate" || key === "wonPerQuoted"
        ? `${Math.round(value * 100)}%`
        : formatNumber(value)

  const cell = (r: RepRow, key: RepMetricKey) => (
    <td
      key={key}
      className={cn(
        "px-2 py-1.5 text-right tabular-nums",
        key === "revenue" ? "font-medium" : "",
        sortBy === key ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {formatRep(repMetricValue(r, key), key)}
    </td>
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">By Sales Rep</CardTitle>
        <p className="text-sm text-muted-foreground">
          Appointments, quoted, closed won, won/quoted %, close %, revenue &amp; avg sale by HubSpot deal owner · tap a
          column to rank · tap a rep to see their deals
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No deal-owner data in this period.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-xs">
                  <th className="w-6 py-1.5 text-left font-medium text-muted-foreground">#</th>
                  <th className="py-1.5 text-left font-medium uppercase tracking-wide text-muted-foreground">
                    Sales Rep
                  </th>
                  {REP_METRICS.map(th)}
                </tr>
              </thead>
              <tbody>
                {ranked.map((r, i) => {
                  const isOpen = expanded.has(r.name)
                  const hasDeals = !!r.deals && r.deals.length > 0
                  return (
                    <Fragment key={r.name}>
                      <tr
                        className={cn(
                          "border-b border-border/50",
                          i === 0 && "bg-primary/5",
                          hasDeals && "cursor-pointer hover:bg-muted/50",
                        )}
                        onClick={hasDeals ? () => toggle(r.name) : undefined}
                      >
                        <td className="py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
                        <td className="max-w-[10rem] py-1.5 pr-2">
                          <span className="flex items-center gap-1">
                            {hasDeals ? (
                              <ChevronRight
                                className={cn(
                                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                                  isOpen && "rotate-90",
                                )}
                              />
                            ) : (
                              <span className="w-3.5 shrink-0" />
                            )}
                            <span className="truncate" title={r.name}>
                              {r.name}
                            </span>
                          </span>
                        </td>
                        {REP_METRICS.map((m) => cell(r, m.key))}
                      </tr>
                      {isOpen && hasDeals && (
                        <tr className="border-b border-border/50 bg-muted/20">
                          <td />
                          <td colSpan={REP_METRICS.length + 1} className="py-2 pr-2">
                            <RepDealDetail deals={r.deals!} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
              <tfoot className="sticky bottom-0 bg-card">
                <tr className="border-t font-medium">
                  <td />
                  <td className="py-1.5 pr-2 text-muted-foreground">Total ({rows.length})</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(totals.apptSet)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(totals.quoted)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(totals.closedWon)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {totals.quoted > 0 ? `${Math.round((totals.closedWon / totals.quoted) * 100)}%` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {totals.apptSet > 0 ? `${Math.round((totals.closedWon / totals.apptSet) * 100)}%` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(totals.revenue)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {totals.closedWon > 0 ? formatCurrency(totals.revenue / totals.closedWon) : "—"}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function flattenForCsv(nodes: Node[], depth = 0, rows: string[][] = []): string[][] {
  for (const n of nodes) {
    const m = n.metrics
    rows.push([
      `${"  ".repeat(depth)}${n.name}`,
      String(m.contactsCreated),
      String(m.created),
      String(m.apptSet),
      String(m.quoted),
      String(m.closedWon),
      String(Math.round(m.revenue)),
    ])
    if (n.children) flattenForCsv(n.children, depth + 1, rows)
  }
  return rows
}

function exportCsv(report: Report) {
  const header = ["Territory", "Contacts", "Deals Created", "Appt Set", "Quoted", "Won", "Revenue"]
  const rows = flattenForCsv(report.hierarchy)
  const csv = [header, ...rows].map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `funnel-${report.dateFrom.slice(0, 10)}-to-${report.dateTo.slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function fmtDate(iso?: string) {
  if (!iso) return ""
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// Human-friendly label for a selected period: the preset name, or a date range
// for a custom selection.
function periodLabel(range: RangeKey, custom: CustomRange): string {
  if (range === "custom") {
    const { dateFrom, dateTo } = resolveRange(range, custom)
    return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`
  }
  return RANGE_OPTIONS.find((o) => o.key === range)?.label ?? ""
}

// Filter the hierarchy: keep any node whose name (or a descendant's name) matches.
function filterTree(nodes: Node[], q: string): Node[] {
  if (!q) return nodes
  const needle = q.toLowerCase()
  const walk = (node: Node): Node | null => {
    const selfMatch = node.name.toLowerCase().includes(needle)
    const kids = node.children?.map(walk).filter((n): n is Node => n !== null) ?? []
    if (selfMatch || kids.length) return { ...node, children: kids.length ? kids : node.children }
    return null
  }
  return nodes.map(walk).filter((n): n is Node => n !== null)
}

export function TerritoryView() {
  const [range, setRange] = useState<RangeKey>("last12")
  const [custom, setCustom] = useState<CustomRange>(defaultCustomRange())
  // Compare-to-period: same date-selector scheme as the primary range.
  const [compareEnabled, setCompareEnabled] = useState(false)
  const [compareRange, setCompareRange] = useState<RangeKey>("lastYear")
  const [compareCustom, setCompareCustom] = useState<CustomRange>(defaultCustomRange())
  const [pipeline, setPipeline] = useState("all")
  const [filter, setFilter] = useState("")
  // Bumping this key remounts the table body, resetting every row's open state.
  const [treeKey, setTreeKey] = useState(0)
  const [defaultOpen, setDefaultOpen] = useState(false)

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })

  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiGet<{ pipelines: { id: string; label: string }[] }>("/api/hs/pipelines"),
    enabled: !!status.data?.configured,
  })

  const body = useMemo(() => {
    const { dateFrom, dateTo } = resolveRange(range, custom)
    return { dateFrom, dateTo, pipelines: pipeline === "all" ? [] : [pipeline] }
  }, [range, custom, pipeline])

  const report = useQuery({
    queryKey: ["territory-report", body.dateFrom, body.dateTo, pipeline],
    queryFn: () => apiPost<Report>("/api/hs/territory-report", body),
    enabled: !!status.data?.configured,
  })

  const compareBody = useMemo(() => {
    const { dateFrom, dateTo } = resolveRange(compareRange, compareCustom)
    return { dateFrom, dateTo, pipelines: pipeline === "all" ? [] : [pipeline] }
  }, [compareRange, compareCustom, pipeline])

  const compareReport = useQuery({
    queryKey: ["territory-report", compareBody.dateFrom, compareBody.dateTo, pipeline],
    queryFn: () => apiPost<Report>("/api/hs/territory-report", compareBody),
    enabled: !!status.data?.configured && compareEnabled,
  })

  const filtered = useMemo(() => filterTree(report.data?.hierarchy ?? [], filter), [report.data, filter])

  if (!status.isLoading && !status.data?.configured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Funnel" description="Deals created, appointments set, and closed won — rolled up by territory hierarchy." />
        <NotConnected />
      </div>
    )
  }

  // KPI cards report IN-PERIOD actions (appt/quoted/won by their own date in the
  // window, matching the hierarchy below and HubSpot's period reports).
  const t = report.data?.inPeriodTotals
  const c = compareReport.data?.inPeriodTotals
  const rangeLabel = RANGE_OPTIONS.find((o) => o.key === range)?.label ?? ""
  const primaryPeriodLabel = periodLabel(range, custom)
  const comparePeriodLabel = periodLabel(compareRange, compareCustom)
  const isFiltering = filter.trim().length > 0

  const expandAll = () => {
    setDefaultOpen(true)
    setTreeKey((k) => k + 1)
  }
  const collapseAll = () => {
    setDefaultOpen(false)
    setTreeKey((k) => k + 1)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Funnel"
        description="Deals created, appointments set, and closed won — rolled up by territory hierarchy"
      >
        <DateRangeSelect
          value={range}
          onValueChange={setRange}
          custom={custom}
          onCustomChange={setCustom}
          triggerClassName="w-[170px]"
        />
        <Button variant="outline" onClick={() => report.data && exportCsv(report.data)} disabled={!report.data}>
          <Download className="size-4" />
          Export CSV
        </Button>
        <Button variant="outline" size="icon" onClick={() => report.refetch()} aria-label="Refresh">
          <RefreshCw className={cn("size-4", report.isFetching && "animate-spin")} />
        </Button>
      </PageHeader>

      {/* Compare-to-period controls */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Compare</span>
        <Pill active={compareEnabled} onClick={() => setCompareEnabled((v) => !v)}>
          {compareEnabled ? "Comparing" : "Off"}
        </Pill>
        {compareEnabled ? (
          <>
            <span className="text-xs text-muted-foreground">vs</span>
            <DateRangeSelect
              value={compareRange}
              onValueChange={setCompareRange}
              custom={compareCustom}
              onCustomChange={setCompareCustom}
              triggerClassName="w-[170px]"
            />
            {compareReport.isError ? (
              <span className="text-xs text-destructive">Failed to load compare period.</span>
            ) : null}
          </>
        ) : null}
      </div>

      {/* Pipeline filter pills */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pipeline</span>
        <Pill active={pipeline === "all"} onClick={() => setPipeline("all")}>
          All
        </Pill>
        {pipelines.data?.pipelines.map((p) => (
          <Pill key={p.id} active={pipeline === p.id} onClick={() => setPipeline(p.id)}>
            {p.label}
          </Pill>
        ))}
      </div>

      {report.isError ? (
        <Card className="border-destructive/40">
          <CardContent className="py-6 text-sm text-destructive">
            Failed to load funnel report: {(report.error as Error)?.message}
          </CardContent>
        </Card>
      ) : null}

      {/* KPI cards */}
      <div
        className={cn(
          "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
          compareEnabled ? "xl:grid-cols-3" : "xl:grid-cols-6",
        )}
      >
        {KPI_CONFIG.map((k) => {
          const pm = t ?? ZERO_METRICS
          const cm = c ?? ZERO_METRICS
          return (
            <FunnelKpi
              key={k.label}
              label={k.label}
              value={k.main(pm)}
              stats={k.stats(pm)}
              loading={report.isLoading}
              primaryLabel={compareEnabled ? primaryPeriodLabel : undefined}
              delta={compareEnabled ? deltaPct(k.raw(pm), k.raw(cm)) : null}
              compare={
                compareEnabled
                  ? {
                      value: k.main(cm),
                      stats: k.stats(cm),
                      loading: compareReport.isLoading,
                      periodLabel: comparePeriodLabel,
                    }
                  : undefined
              }
            />
          )
        })}
      </div>

      {/* Won revenue split — total won revenue broken into cabinet (reface) vs countertops */}
      <RevenueSplitCard
        split={report.data?.inPeriodRevenueSplit}
        wonCount={report.data?.inPeriodTotals?.closedWon}
        loading={report.isLoading}
        periodText={primaryPeriodLabel}
      />

      {/* Top-N panels */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <TopPanel title="Top 10 Territories" rows={report.data?.topTerritories ?? []} loading={report.isLoading} limit={10} />
        <TopPanel title="Top 10 Sub-Regions" rows={report.data?.topSubRegions ?? []} loading={report.isLoading} limit={10} />
        <TopPanel title="Top Regions" rows={report.data?.topRegions ?? []} loading={report.isLoading} limit={9} />
      </div>

      {/* Sales rep breakdown */}
      <SalesRepCard rows={report.data?.byRep ?? []} loading={report.isLoading} />

      {/* Territory penetration */}
      <PenetrationCard rows={report.data?.penetration ?? []} loading={report.isLoading} rangeLabel={rangeLabel} />

      {/* Appt scheduled but not quoted — own date range, independent of the funnel above */}
      <ApptNotQuotedSection configured={!!status.data?.configured} />

      {/* Closed-won deals — follows the Funnel page's selected date range + pipeline */}
      <ClosedWonSection
        configured={!!status.data?.configured}
        dateFrom={body.dateFrom}
        dateTo={body.dateTo}
        pipelines={body.pipelines}
        periodText={primaryPeriodLabel}
      />

      {/* Deals that entered the Scheduled stage — follows the Funnel page's selected date range + pipeline */}
      <ScheduledDealsSection
        configured={!!status.data?.configured}
        dateFrom={body.dateFrom}
        dateTo={body.dateTo}
        pipelines={body.pipelines}
        periodText={primaryPeriodLabel}
      />

      {/* Express Reface deals — cabinet/countertop vs deal & contract amount (fixed last-12mo, ER pipeline) */}
      <ErContractDealsSection configured={!!status.data?.configured} />

      {report.data?.unmappedRemaining ? (
        <div className="flex items-center gap-2 rounded-md border border-chart-4/40 bg-chart-4/5 px-3 py-2 text-sm text-muted-foreground">
          <AlertTriangle className="size-4 text-chart-4" />
          {formatNumber(report.data.unmappedRemaining)} deal(s) could not be mapped to a territory and are grouped under "UNMAPPED".
        </div>
      ) : null}

      {/* Filter + expand controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter territories…"
            className="pl-9"
          />
        </div>
        <button type="button" onClick={expandAll} className="text-sm font-medium text-muted-foreground hover:text-foreground">
          Expand all
        </button>
        <button type="button" onClick={collapseAll} className="text-sm font-medium text-muted-foreground hover:text-foreground">
          Collapse all
        </button>
      </div>

      {/* Hierarchy table */}
      <Card>
        <CardContent className="pt-6">
          {report.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No territories found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-2 text-left font-medium">Territory</th>
                    <th className="px-2 text-right font-medium">Contacts</th>
                    <th className="px-2 text-right font-medium">Deals Created</th>
                    <th className="px-2 text-right font-medium">Appt Set</th>
                    <th className="px-2 text-right font-medium">Appt %</th>
                    <th className="px-2 text-right font-medium">Quoted</th>
                    <th className="px-2 text-right font-medium">Quoted / Appt</th>
                    <th className="px-2 text-right font-medium">Won</th>
                    <th className="px-2 text-right font-medium">Won %</th>
                    <th className="px-2 text-right font-medium">Won / Appt</th>
                    <th className="px-2 text-right font-medium">Won / Quoted</th>
                    <th className="px-2 text-right font-medium">Won by Pipeline</th>
                    <th className="pl-2 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody key={`${treeKey}-${filter}`}>
                  {filtered.map((node, i) => (
                    <TreeRow key={`${node.name}-${i}`} node={node} depth={0} defaultOpen={isFiltering || defaultOpen} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {report.data ? (
            <div className="mt-4 flex flex-col gap-1 border-t pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>{formatNumber(report.data.dealCount)} total deals scanned in period</span>
              <span>
                {fmtDate(report.data.dateFrom)} – {fmtDate(report.data.dateTo)}
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Pipeline key */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold">Won by pipeline key:</span>
        <span className="rounded bg-primary/15 px-1.5 py-0.5 font-semibold text-primary">ER</span> = Express Reface
        <span className="rounded bg-chart-2/15 px-1.5 py-0.5 font-semibold text-chart-2">BV</span> = Bath Vanity
        <span className="rounded bg-chart-3/15 px-1.5 py-0.5 font-semibold text-chart-3">CT</span> = Countertops
      </div>
    </div>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  )
}
