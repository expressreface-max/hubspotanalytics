"use client"

import { useMemo, useState } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import {
  KPI_CONFIG,
  ZERO_METRICS,
  deltaPct,
  DeltaChip,
  pct,
  type Metrics,
} from "@/components/funnel-kpi"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { ContactLtvCard } from "@/components/contact-ltv-card"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

// Cohort of deals created in the window, split by whether each milestone was
// reached DURING the window or AFTER the window end. Percentages use `created`
// as the denominator (the created-in-period cohort size).
type Cohort = {
  contactsCreated: number
  created: number
  apptDuring: number
  apptAfter: number
  quotedDuring: number
  quotedAfter: number
  wonDuring: number
  wonAfter: number
  revenueDuring: number
  revenueAfter: number
  refaceRevDuring: number
  refaceRevAfter: number
  refaceCountDuring: number
  refaceCountAfter: number
  countertopRevDuring: number
  countertopRevAfter: number
  countertopCountDuring: number
  countertopCountAfter: number
}

const ZERO_COHORT: Cohort = {
  contactsCreated: 0,
  created: 0,
  apptDuring: 0,
  apptAfter: 0,
  quotedDuring: 0,
  quotedAfter: 0,
  wonDuring: 0,
  wonAfter: 0,
  revenueDuring: 0,
  revenueAfter: 0,
  refaceRevDuring: 0,
  refaceRevAfter: 0,
  refaceCountDuring: 0,
  refaceCountAfter: 0,
  countertopRevDuring: 0,
  countertopRevAfter: 0,
  countertopCountDuring: 0,
  countertopCountAfter: 0,
}

// Won revenue split by product amount field. `total` is the full won revenue;
// reface + countertop only cover deals where those fields are populated.
type RevenueSplit = {
  reface: number
  countertop: number
  total: number
  refaceCount: number
  countertopCount: number
}
const ZERO_SPLIT: RevenueSplit = { reface: 0, countertop: 0, total: 0, refaceCount: 0, countertopCount: 0 }

// Territory-report response. `totals` = as-reported (matches the Funnel page);
// `inPeriodTotals` = milestones counted only when their own date is in the window;
// `cohort` = created-in-period deals split into during/after the window;
// `revenueSplit`/`inPeriodRevenueSplit` = won revenue by reface vs countertop.
type Report = {
  totals: Metrics
  inPeriodTotals: Metrics
  cohort: Cohort
  revenueSplit: RevenueSplit
  inPeriodRevenueSplit: RevenueSplit
}

const YEARS = [2023, 2024, 2025, 2026] as const

// KPI_CONFIG indices shown with strict in-period counting (headline) + the
// as-reported value beneath: Contacts(0), Deals created(1), Appt set(2), Quoted(3),
// Closed won(4). Appt set is window-scoped by appointment stage-entered date;
// as-reported counts any deal in the created∪closed set that ever set an
// appointment, which inflates a partial year via deals created earlier but
// closed in-window. Won revenue(5) stays as-reported only.
const IN_PERIOD_METRICS = new Set([0, 1, 2, 3, 4])
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MONTH_OPTIONS = MONTHS.map((m, i) => ({ value: String(i), label: m }))
const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))

// Clamp a day to the last valid day of the given month/year (handles Feb 29).
function clampDay(year: number, monthIdx: number, day: number) {
  const maxDay = new Date(year, monthIdx + 1, 0).getDate()
  return Math.min(day, maxDay)
}

// Resolve the concrete from/to ISO window for a calendar month/day range within
// a single year. If the two endpoints are inverted, use the earlier as start.
function windowFor(year: number, fromM: number, fromD: number, toM: number, toD: number) {
  const a = new Date(year, fromM, clampDay(year, fromM, fromD))
  const b = new Date(year, toM, clampDay(year, toM, toD))
  const [start, end] = a <= b ? [a, b] : [b, a]
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0)
  const to = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999)
  return { dateFrom: from.toISOString(), dateTo: to.toISOString() }
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-3 py-1.5 text-sm font-medium tabular-nums transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-muted",
      )}
      aria-pressed={active}
    >
      {children}
    </button>
  )
}

function MdSelect({
  monthValue,
  dayValue,
  onMonthChange,
  onDayChange,
  label,
}: {
  monthValue: number
  dayValue: number
  onMonthChange: (m: number) => void
  onDayChange: (d: number) => void
  label: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <Select value={String(monthValue)} onValueChange={(v) => v && onMonthChange(Number(v))}>
        <SelectTrigger className="w-[5.5rem]" aria-label={`${label} month`}>
          <SelectValue>{(v) => MONTHS[Number(v)] ?? ""}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {MONTH_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(dayValue)} onValueChange={(v) => v && onDayChange(Number(v))}>
        <SelectTrigger className="w-[4.5rem]" aria-label={`${label} day`}>
          <SelectValue>{(v) => String(v)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {DAY_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

type YearData = {
  year: number
  metrics: Metrics // as-reported
  inPeriod: Metrics // strict in-window
  cohort: Cohort // created-in-period, split during/after
  revSplit: RevenueSplit // won revenue by reface vs countertop (in-period, close date in window)
  revSplitReported: RevenueSplit // same, as-reported ("ever reached" won set)
  loading: boolean
  error: boolean
}

// One KPI card comparing a single funnel metric across every selected year.
// When `dual` is set the headline is the strict in-period value, and the
// as-reported value is shown beneath it (muted) whenever the two differ.
// The YoY delta and conversion sub-stat are derived from the headline source.
function YearCompareCard({
  label,
  main,
  raw,
  substat,
  dual,
  years,
}: {
  label: string
  main: (m: Metrics) => string
  raw: (m: Metrics) => number
  substat?: (m: Metrics) => { label: string; value: string }
  dual?: boolean
  years: YearData[]
}) {
  const source = (y: YearData) => (dual ? y.inPeriod : y.metrics)
  return (
    <Card className="p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-4 space-y-3">
        {years.map((y, i) => {
          const prev = years[i - 1]
          const showDelta = prev && !y.loading && !prev.loading && !y.error && !prev.error
          const d = showDelta ? deltaPct(raw(source(y)), raw(source(prev!))) : null
          const sub = substat ? substat(source(y)) : null
          const reportedDiffers = dual && raw(y.inPeriod) !== raw(y.metrics)
          return (
            <div key={y.year} className="grid grid-cols-[3rem_1fr_auto] items-baseline gap-2">
              <span className="text-sm font-semibold tabular-nums">{y.year}</span>
              {y.loading ? (
                <Skeleton className="h-6 w-20 justify-self-end" />
              ) : y.error ? (
                <span className="justify-self-end text-sm text-destructive">error</span>
              ) : (
                <div className="flex flex-col items-end">
                  <span className="num text-xl font-bold leading-tight">{main(source(y))}</span>
                  {reportedDiffers ? (
                    <span className="text-[11px] text-muted-foreground">{main(y.metrics)} reported</span>
                  ) : null}
                  {sub ? (
                    <span className="text-[11px] text-muted-foreground">
                      {sub.value} {sub.label}
                    </span>
                  ) : null}
                </div>
              )}
              <span className="justify-self-end self-center">
                {d != null ? (
                  <DeltaChip pct={d} />
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// Won revenue card that splits each year's total into its Reface and Countertop
// amount components. Headline = total won revenue (with YoY delta); beneath it,
// the reface and countertop portions with their share of the total.
function RevenueSplitCard({ years }: { years: YearData[] }) {
  return (
    <Card className="p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Won revenue split</div>
      <div className="mt-4 space-y-3">
        {years.map((y, i) => {
          const prev = years[i - 1]
          const s = y.revSplit
          const showDelta = prev && !y.loading && !prev.loading && !y.error && !prev.error
          const d = showDelta ? deltaPct(s.total, prev!.revSplit.total) : null
          return (
            <div key={y.year} className="grid grid-cols-[3rem_1fr_auto] items-baseline gap-2">
              <span className="text-sm font-semibold tabular-nums">{y.year}</span>
              {y.loading ? (
                <Skeleton className="h-6 w-24 justify-self-end" />
              ) : y.error ? (
                <span className="justify-self-end text-sm text-destructive">error</span>
              ) : (
                <div className="flex flex-col items-end gap-0.5">
                  <span className="num text-xl font-bold leading-tight">{formatCurrency(s.total)}</span>
                  {y.revSplitReported.total !== s.total ? (
                    <span className="text-[11px] text-muted-foreground">
                      {formatCurrency(y.revSplitReported.total)} reported
                    </span>
                  ) : null}
                  <span className="text-[11px] text-muted-foreground">
                    Reface {formatCurrency(s.reface)} · {formatNumber(s.refaceCount)} jobs ·{" "}
                    {formatCurrency(avg(s.reface, s.refaceCount))}/job
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Countertops {formatCurrency(s.countertop)} · {formatNumber(s.countertopCount)} jobs ·{" "}
                    {formatCurrency(avg(s.countertop, s.countertopCount))}/job
                  </span>
                </div>
              )}
              <span className="justify-self-end self-center">
                {d != null ? <DeltaChip pct={d} /> : <span className="text-xs text-muted-foreground">—</span>}
              </span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// Safe average: total divided by count, 0 when count is 0.
function avg(total: number, count: number): number {
  return count > 0 ? total / count : 0
}

// A numeric cell: bold count with a muted sub-line beneath. The sub-line is
// either an explicit `subText` (e.g. avg revenue per won) or a conversion
// percentage of `base` when provided.
function CohortCell({
  value,
  base,
  currency,
  subText,
}: {
  value: number
  base?: number
  currency?: boolean
  subText?: string
}) {
  return (
    <td className="px-2 py-2 text-right align-top tabular-nums">
      <div className="font-semibold">{currency ? formatCurrency(value) : formatNumber(value)}</div>
      <div className="text-[11px] text-muted-foreground">
        {subText ?? (base != null ? pct(value, base) : null)}
      </div>
    </td>
  )
}

// A won-revenue cell for the cohort table: total headline with Reface and
// Countertop split beneath (each with job count and revenue-per-job).
function CohortRevCell({
  total,
  refaceRev,
  refaceCount,
  countertopRev,
  countertopCount,
}: {
  total: number
  refaceRev: number
  refaceCount: number
  countertopRev: number
  countertopCount: number
}) {
  return (
    <td className="px-2 py-2 text-right align-top tabular-nums">
      <div className="font-semibold">{formatCurrency(total)}</div>
      <div className="text-[11px] text-muted-foreground">
        Reface {formatCurrency(refaceRev)} · {formatNumber(refaceCount)} jobs ·{" "}
        {formatCurrency(avg(refaceRev, refaceCount))}/job
      </div>
      <div className="text-[11px] text-muted-foreground">
        Ctop {formatCurrency(countertopRev)} · {formatNumber(countertopCount)} jobs ·{" "}
        {formatCurrency(avg(countertopRev, countertopCount))}/job
      </div>
    </td>
  )
}

// Cohort detail card: for the deals CREATED in the window each year, show how
// many reached each milestone during vs after the window, with conversion %.
// Count percentages are of deals created in period; revenue % is of the cohort's
// total closed-won revenue (during + after).
function CohortCard({ years, windowLabel }: { years: YearData[]; windowLabel: string }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-base font-semibold">Created-in-period cohort: during vs after</h2>
        <p className="text-xs text-muted-foreground">
          Deals created within {windowLabel}
          {" each year, split by whether the milestone was reached during the "}
          same window or afterward. Deals created and Closed won are shown as a percentage of contacts;
          Appointments and Quoted as a percentage of deals created; Won revenue shows the total with the
          Reface and Countertop job counts and revenue-per-job beneath.
        </p>
      </div>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="px-2 py-1.5 text-left font-medium" rowSpan={2}>
                Year
              </th>
              <th className="border-l px-2 py-1.5 text-center font-medium" colSpan={2}>
                Created
              </th>
              <th className="border-l px-2 py-1.5 text-center font-medium" colSpan={2}>
                Appointments
              </th>
              <th className="border-l px-2 py-1.5 text-center font-medium" colSpan={2}>
                Quoted
              </th>
              <th className="border-l px-2 py-1.5 text-center font-medium" colSpan={2}>
                Closed won
              </th>
              <th className="border-l px-2 py-1.5 text-center font-medium" colSpan={2}>
                Won revenue
              </th>
            </tr>
            <tr className="border-b text-[11px] text-muted-foreground">
              <th className="border-l px-2 py-1.5 text-right font-medium">Contacts</th>
              <th className="px-2 py-1.5 text-right font-medium">Deals</th>
              <th className="border-l px-2 py-1.5 text-right font-medium">During</th>
              <th className="px-2 py-1.5 text-right font-medium">After</th>
              <th className="border-l px-2 py-1.5 text-right font-medium">During</th>
              <th className="px-2 py-1.5 text-right font-medium">After</th>
              <th className="border-l px-2 py-1.5 text-right font-medium">During</th>
              <th className="px-2 py-1.5 text-right font-medium">After</th>
              <th className="border-l px-2 py-1.5 text-right font-medium">During</th>
              <th className="px-2 py-1.5 text-right font-medium">After</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => {
              const c = y.cohort
              const created = c.created || 0
              if (y.loading) {
                return (
                  <tr key={y.year} className="border-b">
                    <td className="px-2 py-2 font-semibold tabular-nums">{y.year}</td>
                    <td colSpan={10} className="px-2 py-2">
                      <Skeleton className="h-5 w-full" />
                    </td>
                  </tr>
                )
              }
              if (y.error) {
                return (
                  <tr key={y.year} className="border-b">
                    <td className="px-2 py-2 font-semibold tabular-nums">{y.year}</td>
                    <td colSpan={10} className="px-2 py-2 text-sm text-destructive">
                      error loading data
                    </td>
                  </tr>
                )
              }
              return (
                <tr key={y.year} className="border-b">
                  <td className="px-2 py-2 font-semibold tabular-nums">{y.year}</td>
                  {/* Contacts: raw top-of-funnel count. Deals: % of contacts. */}
                  <td className="border-l px-2 py-2 text-right align-top font-semibold tabular-nums">
                    {formatNumber(c.contactsCreated)}
                  </td>
                  <CohortCell value={c.created} base={c.contactsCreated} />
                  <CohortCell value={c.apptDuring} base={created} />
                  <CohortCell value={c.apptAfter} base={created} />
                  <CohortCell value={c.quotedDuring} base={created} />
                  <CohortCell value={c.quotedAfter} base={created} />
                  {/* Closed won: % of contacts */}
                  <CohortCell value={c.wonDuring} base={c.contactsCreated} />
                  <CohortCell value={c.wonAfter} base={c.contactsCreated} />
                  {/* Won revenue: total with Reface/Countertop split (count + rev/job) */}
                  <CohortRevCell
                    total={c.revenueDuring}
                    refaceRev={c.refaceRevDuring}
                    refaceCount={c.refaceCountDuring}
                    countertopRev={c.countertopRevDuring}
                    countertopCount={c.countertopCountDuring}
                  />
                  <CohortRevCell
                    total={c.revenueAfter}
                    refaceRev={c.refaceRevAfter}
                    refaceCount={c.refaceCountAfter}
                    countertopRev={c.countertopRevAfter}
                    countertopCount={c.countertopCountAfter}
                  />
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function DealAnalysisView() {
  const now = useMemo(() => new Date(), [])
  // Default window: Jan 1 through today's month/day (YTD-comparable across years).
  const [fromM, setFromM] = useState(0)
  const [fromD, setFromD] = useState(1)
  const [toM, setToM] = useState(now.getMonth())
  const [toD, setToD] = useState(now.getDate())
  const [selectedYears, setSelectedYears] = useState<number[]>([2024, 2025, 2026])

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })

  const sortedYears = useMemo(() => [...selectedYears].sort((a, b) => a - b), [selectedYears])

  // One report query per selected year over the identical month/day window.
  // Keyed to match the Funnel page so ranges can share the react-query cache.
  const results = useQueries({
    queries: sortedYears.map((year) => {
      const { dateFrom, dateTo } = windowFor(year, fromM, fromD, toM, toD)
      return {
        queryKey: ["territory-report", dateFrom, dateTo, "all"],
        queryFn: () => apiPost<Report>("/api/hs/territory-report", { dateFrom, dateTo, pipelines: [] }),
        enabled: !!status.data?.configured,
      }
    }),
  })

  const years: YearData[] = sortedYears.map((year, i) => ({
    year,
    metrics: results[i]?.data?.totals ?? ZERO_METRICS,
    inPeriod: results[i]?.data?.inPeriodTotals ?? ZERO_METRICS,
    cohort: results[i]?.data?.cohort ?? ZERO_COHORT,
    revSplit: results[i]?.data?.inPeriodRevenueSplit ?? ZERO_SPLIT,
    revSplitReported: results[i]?.data?.revenueSplit ?? ZERO_SPLIT,
    loading: results[i]?.isLoading ?? false,
    error: results[i]?.isError ?? false,
  }))

  const windowLabel = `${MONTHS[fromM]} ${fromD} – ${MONTHS[toM]} ${toD}`

  const toggleYear = (year: number) =>
    setSelectedYears((prev) =>
      prev.includes(year) ? (prev.length > 1 ? prev.filter((y) => y !== year) : prev) : [...prev, year],
    )

  if (!status.isLoading && !status.data?.configured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Deal Analysis"
          description="Compare the funnel across multiple years for the same calendar window."
        />
        <NotConnected />
      </div>
    )
  }

  // The primary conversion sub-stat per KPI (first entry of its stats list).
  const substatFor = (m: Metrics, idx: number) => {
    const stats = KPI_CONFIG[idx].stats(m)
    return stats.length ? stats[0] : undefined
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Deal Analysis"
        description={`Funnel comparison for ${windowLabel} across ${sortedYears.join(", ")}`}
      />

      {/* Controls: calendar month/day window + multi-year selector */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <MdSelect
            label="From"
            monthValue={fromM}
            dayValue={fromD}
            onMonthChange={setFromM}
            onDayChange={setFromD}
          />
          <MdSelect label="To" monthValue={toM} dayValue={toD} onMonthChange={setToM} onDayChange={setToD} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Years</span>
          {YEARS.map((y) => (
            <Pill key={y} active={selectedYears.includes(y)} onClick={() => toggleYear(y)}>
              {y}
            </Pill>
          ))}
        </div>
      </Card>

      {/* KPI compare cards — one per funnel metric, all selected years inside */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {KPI_CONFIG.map((k, idx) =>
          // The Won revenue card (idx 5) is replaced with a reface/countertop split.
          idx === 5 ? (
            <RevenueSplitCard key={k.label} years={years} />
          ) : (
            <YearCompareCard
              key={k.label}
              label={k.label}
              main={k.main}
              raw={k.raw}
              substat={idx === 0 ? undefined : (m) => substatFor(m, idx)!}
              dual={IN_PERIOD_METRICS.has(idx)}
              years={years}
            />
          ),
        )}
      </div>

      {/* Cohort detail: created-in-period deals split during vs after the window */}
      <CohortCard years={years} windowLabel={windowLabel} />

      {/* Contact lifetime value by monthly creation cohort (2023 -> now, own query) */}
      <ContactLtvCard configured={!!status.data?.configured} />

      <p className="text-xs text-muted-foreground">
        Each card compares the same {windowLabel}
        {" window across the selected years; the delta chip shows the "}
        change versus the prior selected year. Contacts, Deals created, Quoted and Closed won are counted
        strictly in-period (the milestone&apos;s own date falls inside the window), with the as-reported value
        shown beneath when it differs. Appt set and Won revenue remain as-reported (matching the Funnel page).
        As-reported closed won can include deals that closed outside the window but were created in it. Won
        revenue is split by the Reface Amount and Countertop Amount deal fields; because those fields are only
        set on some deals (and change orders can push them past the deal amount), they may not sum exactly to
        the total.
      </p>
    </div>
  )
}
