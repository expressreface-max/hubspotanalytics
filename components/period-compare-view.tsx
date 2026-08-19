"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download } from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { deltaPct, DeltaChip, ZERO_METRICS, type Metrics } from "@/components/funnel-kpi"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

// Job-type-gated revenue split for the window (cabinet = Reface jobs, countertop
// = Countertop jobs). Reface/countertop only populate for periods where those
// fields were tracked; older periods (e.g. 2023) come back all-zero.
type RevenueSplit = {
  reface: number
  countertop: number
  total: number
  refaceCount: number
  countertopCount: number
}

// Territory-report response. The in-period totals count each milestone by its
// OWN date falling inside the window, matching how HubSpot period reports count
// — the same basis the Funnel/Deal Analysis use.
type Report = { inPeriodTotals: Metrics; inPeriodRevenueSplit?: RevenueSplit }

// Per-period figures: the base in-period metrics plus the cabinet/countertop
// breakdown and the derived attach rate + average price per job.
type Derived = Metrics & {
  cabinetJobs: number
  countertopJobs: number
  cabinetRev: number
  countertopRev: number
  attachRate: number // countertop jobs ÷ cabinet jobs (fraction)
  avgReface: number // cabinet revenue ÷ cabinet jobs
  avgCountertop: number // countertop revenue ÷ countertop jobs
}

// Combine the in-period metrics with the revenue split into the derived figures.
// When a period has no split data (both job counts 0 — e.g. 2023, before the
// job-type/amount fields were tracked) we treat it as CABINETS ONLY: cabinet
// jobs = closed won and cabinet revenue = total revenue, countertops = 0.
function derive(m: Metrics, split?: RevenueSplit): Derived {
  const hasSplit = !!split && (split.refaceCount > 0 || split.countertopCount > 0)
  const cabinetJobs = hasSplit ? split!.refaceCount : m.closedWon
  const cabinetRev = hasSplit ? split!.reface : m.revenue
  const countertopJobs = hasSplit ? split!.countertopCount : 0
  const countertopRev = hasSplit ? split!.countertop : 0
  return {
    ...m,
    cabinetJobs,
    countertopJobs,
    cabinetRev,
    countertopRev,
    attachRate: cabinetJobs > 0 ? countertopJobs / cabinetJobs : Number.NaN,
    avgReface: cabinetJobs > 0 ? cabinetRev / cabinetJobs : Number.NaN,
    avgCountertop: countertopJobs > 0 ? countertopRev / countertopJobs : Number.NaN,
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MONTH_OPTIONS = MONTHS.map((m, i) => ({ value: String(i), label: m }))
const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
const YEARS = [2023, 2024, 2025, 2026]

type RowFmt = "number" | "currency" | "percent"
type MetricRow =
  | { group: string }
  | { key: keyof Derived; label: string; fmt: RowFmt }

// The rows of the comparison table. A `group` entry renders a subheader.
const METRIC_ROWS: MetricRow[] = [
  { key: "contactsCreated", label: "Contacts", fmt: "number" },
  { key: "created", label: "Deals", fmt: "number" },
  { key: "apptSet", label: "Appointments", fmt: "number" },
  { key: "closedWon", label: "Closed won", fmt: "number" },
  { key: "revenue", label: "Total revenue", fmt: "currency" },
  { group: "Cabinet & countertop breakdown" },
  { key: "cabinetJobs", label: "Cabinet jobs", fmt: "number" },
  { key: "countertopJobs", label: "Countertop jobs", fmt: "number" },
  { key: "cabinetRev", label: "Cabinet revenue", fmt: "currency" },
  { key: "countertopRev", label: "Countertop revenue", fmt: "currency" },
  { key: "attachRate", label: "Countertop attach rate", fmt: "percent" },
  { key: "avgReface", label: "Avg price / reface job", fmt: "currency" },
  { key: "avgCountertop", label: "Avg price / countertop job", fmt: "currency" },
]

function isGroup(r: MetricRow): r is { group: string } {
  return "group" in r
}

function fmtVal(v: number, fmt: RowFmt): string {
  if (!Number.isFinite(v)) return "—"
  if (fmt === "currency") return formatCurrency(v)
  if (fmt === "percent") return `${Math.round(v * 100)}%`
  return formatNumber(v)
}

// Clamp a day to the last valid day of the given month/year (handles Feb 29).
function clampDay(year: number, monthIdx: number, day: number) {
  const maxDay = new Date(year, monthIdx + 1, 0).getDate()
  return Math.min(day, maxDay)
}

// Resolve the concrete from/to ISO window for a calendar month/day range in one year.
function windowFor(year: number, fromM: number, fromD: number, toM: number, toD: number) {
  const start = new Date(year, fromM, clampDay(year, fromM, fromD), 0, 0, 0, 0)
  const end = new Date(year, toM, clampDay(year, toM, toD), 23, 59, 59, 999)
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() }
}

function periodLabel(year: number, fromM: number, fromD: number, toM: number, toD: number) {
  return `${MONTHS[fromM]} ${fromD} – ${MONTHS[toM]} ${toD}, ${year}`
}

function toCsvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function MiniSelect({
  value,
  onChange,
  options,
  ariaLabel,
  width,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  ariaLabel: string
  width: string
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger className={width} aria-label={ariaLabel}>
        <SelectValue>{(v) => options.find((o) => o.value === v)?.label ?? ""}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function PeriodCompareView() {
  // Defaults match the requested comparison: Mar 1 – Aug 30, 2023 vs 2026.
  const [fromM, setFromM] = useState(2) // March
  const [fromD, setFromD] = useState(1)
  const [toM, setToM] = useState(7) // August
  const [toD, setToD] = useState(30)
  const [yearA, setYearA] = useState(2023)
  const [yearB, setYearB] = useState(2026)

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })
  const configured = !!status.data?.configured

  const winA = useMemo(() => windowFor(yearA, fromM, fromD, toM, toD), [yearA, fromM, fromD, toM, toD])
  const winB = useMemo(() => windowFor(yearB, fromM, fromD, toM, toD), [yearB, fromM, fromD, toM, toD])

  // One report query per period. Cache key matches the Funnel/Deal Analysis
  // format so windows already fetched elsewhere are reused from cache.
  const reportA = useQuery({
    queryKey: ["territory-report", winA.dateFrom, winA.dateTo, "all"],
    queryFn: () => apiPost<Report>("/api/hs/territory-report", { ...winA, pipelines: [] }),
    enabled: configured,
  })
  const reportB = useQuery({
    queryKey: ["territory-report", winB.dateFrom, winB.dateTo, "all"],
    queryFn: () => apiPost<Report>("/api/hs/territory-report", { ...winB, pipelines: [] }),
    enabled: configured,
  })

  const a = useMemo(
    () => derive(reportA.data?.inPeriodTotals ?? ZERO_METRICS, reportA.data?.inPeriodRevenueSplit),
    [reportA.data],
  )
  const b = useMemo(
    () => derive(reportB.data?.inPeriodTotals ?? ZERO_METRICS, reportB.data?.inPeriodRevenueSplit),
    [reportB.data],
  )
  const loading = reportA.isLoading || reportB.isLoading
  const ready = !loading && !!reportA.data && !!reportB.data

  const labelA = periodLabel(yearA, fromM, fromD, toM, toD)
  const labelB = periodLabel(yearB, fromM, fromD, toM, toD)

  function exportCsv() {
    const header = ["Metric", labelA, labelB, "Change"]
    const body = METRIC_ROWS.map((r) => {
      if (isGroup(r)) return [r.group, "", "", ""]
      const av = a[r.key]
      const bv = b[r.key]
      const d = deltaPct(bv, av)
      return [r.label, fmtVal(av, r.fmt), fmtVal(bv, r.fmt), d == null ? "—" : `${Math.round(d * 100)}%`]
    })
    const csv = [header, ...body].map((row) => row.map(toCsvCell).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const inIframe = typeof window !== "undefined" && window.self !== window.top
    const download = () => {
      const el = document.createElement("a")
      el.href = url
      el.download = `period-compare-${yearA}-vs-${yearB}.csv`
      document.body.appendChild(el)
      el.click()
      el.remove()
    }
    if (inIframe) {
      const win = window.open(url, "_blank", "noopener")
      if (!win) download()
    } else {
      download()
    }
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  if (!status.isLoading && !configured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Period Compare" description="Compare two calendar periods side by side." />
        <NotConnected />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Period Compare"
        description={`${labelA}  vs  ${labelB}`}
      />

      {/* Controls: shared month/day window + a year for each period */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">From</span>
            <MiniSelect
              value={String(fromM)}
              onChange={(v) => setFromM(Number(v))}
              options={MONTH_OPTIONS}
              ariaLabel="From month"
              width="w-[5.5rem]"
            />
            <MiniSelect
              value={String(fromD)}
              onChange={(v) => setFromD(Number(v))}
              options={DAY_OPTIONS}
              ariaLabel="From day"
              width="w-[4.5rem]"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">To</span>
            <MiniSelect
              value={String(toM)}
              onChange={(v) => setToM(Number(v))}
              options={MONTH_OPTIONS}
              ariaLabel="To month"
              width="w-[5.5rem]"
            />
            <MiniSelect
              value={String(toD)}
              onChange={(v) => setToD(Number(v))}
              options={DAY_OPTIONS}
              ariaLabel="To day"
              width="w-[4.5rem]"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Period A</span>
            <MiniSelect
              value={String(yearA)}
              onChange={(v) => setYearA(Number(v))}
              options={YEARS.map((y) => ({ value: String(y), label: String(y) }))}
              ariaLabel="Period A year"
              width="w-[5rem]"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Period B</span>
            <MiniSelect
              value={String(yearB)}
              onChange={(v) => setYearB(Number(v))}
              options={YEARS.map((y) => ({ value: String(y), label: String(y) }))}
              ariaLabel="Period B year"
              width="w-[5rem]"
            />
          </div>
          <Button variant="outline" size="sm" className="ml-auto gap-2" onClick={exportCsv} disabled={!ready}>
            <Download className="size-4" />
            Export CSV
          </Button>
        </div>
      </Card>

      {/* The comparison table */}
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 text-left font-medium">Metric</th>
                <th className="px-4 py-3 text-right font-medium">{labelA}</th>
                <th className="px-4 py-3 text-right font-medium">{labelB}</th>
                <th className="px-4 py-3 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {METRIC_ROWS.map((r, i) => {
                if (isGroup(r)) {
                  return (
                    <tr key={`group-${i}`} className="border-b bg-muted/20">
                      <td
                        colSpan={4}
                        className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {r.group}
                      </td>
                    </tr>
                  )
                }
                const av = a[r.key]
                const bv = b[r.key]
                const d = ready ? deltaPct(bv, av) : null
                return (
                  <tr key={r.key} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium">{r.label}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {loading ? <Skeleton className="ml-auto h-5 w-20" /> : fmtVal(av, r.fmt)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">
                      {loading ? <Skeleton className="ml-auto h-5 w-20" /> : fmtVal(bv, r.fmt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {loading ? (
                        <Skeleton className="ml-auto h-5 w-12" />
                      ) : d != null ? (
                        <DeltaChip pct={d} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        Each metric is counted in-period — the milestone&apos;s own date (contact created, deal created,
        appointment set, deal closed-won) falls inside the selected window — matching how HubSpot period reports
        count. Cabinet vs countertop jobs and revenue come from each won deal&apos;s job type and product amounts;
        the attach rate is countertop jobs ÷ cabinet jobs. Periods before the job-type fields were tracked (e.g.
        2023) return no split, so they are treated as cabinets only (cabinet jobs = closed won, cabinet revenue =
        total revenue, countertops = 0). The Change column is the percentage change from Period A to Period B.
      </p>
    </div>
  )
}
