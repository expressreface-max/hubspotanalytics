"use client"

import { Fragment as FragmentRow, useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { TrendingUp, TrendingDown, Target, MapPinned, ChevronRight, Crosshair, X, Loader2 } from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { STATUS_LABEL, classifyAttainment, type PerformanceStatus } from "@/data/territory-potential"

const BASKET_STORAGE_KEY = "territory-potential:target-basket"

type TerritoryRow = {
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

type Row = {
  sub: string
  region: string
  terrCt: number
  lpLeads: number
  potJobs30: number
  potRev30: number
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

type OutOfModel = { name: string; region: string; jobs: number; rev: number; avgSale: number }

type Totals = Row & { jobsAtt: number; revAtt: number; avgSale: number }

type Report = {
  configured: boolean
  asOf?: string
  windowFrom?: string
  windowTo?: string
  model?: { avgSale: number; grossMargin: number; gpPerJob: number; scenarioLabel: string; pulledOn: string }
  rows: Row[]
  totals?: Totals
  outOfModel: OutOfModel[]
  dealCount?: number
  /** ISO timestamp of the nightly snapshot the numbers were computed from. */
  snapshotAt?: string
  error?: string
}

// Status -> tailwind treatments (design tokens only).
const STATUS_STYLE: Record<PerformanceStatus, { text: string; bg: string; bar: string }> = {
  over: { text: "text-chart-3", bg: "bg-chart-3/10", bar: "bg-chart-3" },
  on_pace: { text: "text-chart-4", bg: "bg-chart-4/10", bar: "bg-chart-4" },
  under: { text: "text-destructive", bg: "bg-destructive/10", bar: "bg-destructive" },
  no_potential: { text: "text-muted-foreground", bg: "bg-muted", bar: "bg-muted-foreground" },
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function Check({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  label: string
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="size-4 shrink-0 cursor-pointer accent-primary"
    />
  )
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  if (window.self !== window.top) window.open(url, "_blank")
  else {
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
  }
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function TerritoryPotentialView() {
  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })
  const configured = !!status.data?.configured

  const report = useQuery({
    queryKey: ["territory-potential"],
    queryFn: () => apiPost<Report>("/api/hs/territory-potential", {}),
    enabled: configured,
  })

  // Which sub-regions are expanded to show their territory-level breakdown.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (sub: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sub)) next.delete(sub)
      else next.add(sub)
      return next
    })

  // Territories the operator has added to their target basket (keyed by territory name).
  // Persisted to localStorage so the basket survives reloads and navigation.
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set()
    try {
      const raw = window.localStorage.getItem(BASKET_STORAGE_KEY)
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
    } catch {
      return new Set()
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(BASKET_STORAGE_KEY, JSON.stringify([...selected]))
    } catch {
      // ignore quota / unavailable storage
    }
  }, [selected])
  const toggleTerritory = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  const setMany = (names: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const n of names) {
        if (on) next.add(n)
        else next.delete(n)
      }
      return next
    })
  const clearSelection = () => setSelected(new Set())

  if (!status.isLoading && !configured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Territory Potential" description="Closed-won actuals vs modeled potential." />
        <NotConnected />
      </div>
    )
  }

  const data = report.data
  const rows = data?.rows ?? []
  const totals = data?.totals
  const outOfModel = data?.outOfModel ?? []
  const loading = report.isLoading

  const overCount = rows.filter((r) => r.status === "over").length
  const onPaceCount = rows.filter((r) => r.status === "on_pace").length
  const underCount = rows.filter((r) => r.status === "under").length

  const gpPerJob = data?.model?.gpPerJob ?? 10560

  // Flatten every territory once so the basket can aggregate across sub-regions.
  const allTerritories = useMemo(() => rows.flatMap((r) => (r.territories ?? []).map((t) => ({ ...t, sub: r.sub }))), [rows])

  // Aggregate the selected territories into a target: potential, current actual, and the
  // delta (jobs/revenue still to win) which becomes the goal for the chosen territories.
  const basket = useMemo(() => {
    const picks = allTerritories.filter((t) => selected.has(t.name))
    const potJobs = picks.reduce((a, t) => a + t.potJobs30, 0)
    const potRev = picks.reduce((a, t) => a + t.potRev30, 0)
    const actJobs = picks.reduce((a, t) => a + t.actJobs, 0)
    const actRev = picks.reduce((a, t) => a + t.actRev, 0)
    const jobsDelta = Math.max(0, potJobs - actJobs)
    const revDelta = Math.max(0, potRev - actRev)
    return {
      picks,
      count: picks.length,
      potJobs,
      potRev,
      actJobs,
      actRev,
      jobsDelta,
      revDelta,
      gpDelta: jobsDelta * gpPerJob,
      att: potJobs > 0 ? actJobs / potJobs : 0,
    }
  }, [allTerritories, selected, gpPerJob])

  const hasSelection = selected.size > 0

  // Revenue opportunity: revenue still on the table at the target rate (potential − actual).
  // When territories are selected, the card scopes to that basket; otherwise the full model.
  const revScope = hasSelection
    ? { potRev: basket.potRev, actRev: basket.actRev, jobGap: basket.jobsDelta, revOpp: basket.revDelta }
    : {
        potRev: totals?.potRev30 ?? 0,
        actRev: totals?.actRev ?? 0,
        jobGap: totals ? Math.max(0, totals.potJobs30 - totals.actJobs) : 0,
        revOpp: totals ? Math.max(0, totals.potRev30 - totals.actRev) : 0,
      }

  // When territories are selected, each sub-region row + the totals footer reflect ONLY the
  // selected territories (a live "target scope"). With nothing selected, they show the full model.
  const displayRows = useMemo(
    () =>
      rows.map((r) => {
        if (!hasSelection) {
          return { row: r, potJobs30: r.potJobs30, potRev30: r.potRev30, actJobs: r.actJobs, actRev: r.actRev, jobsAtt: r.jobsAtt, status: r.status, selCount: 0, inScope: true }
        }
        const picks = (r.territories ?? []).filter((t) => selected.has(t.name))
        const potJobs30 = picks.reduce((a, t) => a + t.potJobs30, 0)
        const potRev30 = picks.reduce((a, t) => a + t.potRev30, 0)
        const actJobs = picks.reduce((a, t) => a + t.actJobs, 0)
        const actRev = picks.reduce((a, t) => a + t.actRev, 0)
        const jobsAtt = potJobs30 > 0 ? actJobs / potJobs30 : 0
        return {
          row: r,
          potJobs30,
          potRev30,
          actJobs,
          actRev,
          jobsAtt,
          status: classifyAttainment(actJobs, potJobs30),
          selCount: picks.length,
          inScope: picks.length > 0,
        }
      }),
    [rows, selected, hasSelection],
  )

  // Footer totals: selected-scope aggregate when a selection is active, else the full model.
  const displayTotals = hasSelection
    ? { actJobs: basket.actJobs, potJobs30: basket.potJobs, actRev: basket.actRev, potRev30: basket.potRev, jobsAtt: basket.att, subCount: displayRows.filter((d) => d.inScope).length }
    : totals
    ? { actJobs: totals.actJobs, potJobs30: totals.potJobs30, actRev: totals.actRev, potRev30: totals.potRev30, jobsAtt: totals.jobsAtt, subCount: rows.length }
    : null

  const win =
    data?.windowFrom && data?.windowTo
      ? `${new Date(data.windowFrom).toLocaleDateString("en-US", { month: "short", year: "numeric" })} – ${new Date(
          data.windowTo,
        ).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`
      : "trailing 12 months"

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Territory Potential"
        description={`Trailing-12-month closed-won actuals vs the LeadsPlease target-rate potential model (0.40% Sac / 0.30% Bay), by sub-region and territory. Actuals ${win}.${
          data?.snapshotAt
            ? ` Snapshot as of ${new Date(data.snapshotAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })} · refreshes nightly.`
            : ""
        }`}
      />

      {report.error || data?.error ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {(report.error as Error)?.message || data?.error || "Failed to load territory potential."}
          </CardContent>
        </Card>
      ) : null}

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Target className="size-3.5" /> Jobs attainment
            </div>
            {loading ? (
              <div className="mt-2 flex h-8 items-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
              </div>
            ) : (
              <>
                <div className="mt-1 num text-2xl font-bold">{fmtPct(totals?.jobsAtt ?? 0)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatNumber(totals?.actJobs ?? 0)} of {formatNumber(totals?.potJobs30 ?? 0)} potential jobs/yr
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Actual revenue</div>
            {loading ? (
              <div className="mt-2 flex h-8 items-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
              </div>
            ) : (
              <>
                <div className="mt-1 num text-2xl font-bold">{formatCurrency(totals?.actRev ?? 0)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  of {formatCurrency(totals?.potRev30 ?? 0)} potential · {fmtPct(totals?.revAtt ?? 0)}
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <TrendingUp className="size-3.5 text-chart-3" /> Over / under
            </div>
            {loading ? (
              <div className="mt-2 flex h-8 items-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
              </div>
            ) : (
              <>
                <div className="mt-1 flex items-baseline gap-2 num text-2xl font-bold">
                  <span className="text-chart-3">{overCount}</span>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-destructive">{underCount}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {overCount} over · {onPaceCount} on pace · {underCount} under
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <TrendingDown className="size-3.5 text-destructive" /> Revenue opportunity
                {hasSelection ? (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    {basket.count} selected
                  </span>
                ) : null}
              </div>
              {loading ? (
                <div className="mt-2 flex h-8 items-center">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
                </div>
              ) : (
                <>
                  <div className="mt-1 num text-2xl font-bold">{formatCurrency(revScope.revOpp)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatNumber(revScope.jobGap)} jobs/yr below target · {formatCurrency(revScope.actRev)} of{" "}
                    {formatCurrency(revScope.potRev)} potential
                    {hasSelection ? " (selected)" : ""}
                  </div>
                </>
              )}
          </CardContent>
        </Card>
      </div>

      {/* Target basket: aggregate of the selected territories */}
      {basket.count > 0 ? (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader className="flex flex-col gap-2 pb-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Crosshair className="size-4 text-primary" />
              Target basket
              <span className="text-sm font-normal text-muted-foreground">
                {basket.count} {basket.count === 1 ? "territory" : "territories"} selected
              </span>
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={clearSelection} className="h-8 self-start sm:self-auto">
              Clear
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Target: jobs to win</div>
                <div className="mt-1 num text-2xl font-bold text-primary">+{formatNumber(basket.jobsDelta)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatNumber(basket.actJobs)} of {formatNumber(basket.potJobs)} potential · {fmtPct(basket.att)} attained
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Target: revenue to win
                </div>
                <div className="mt-1 num text-2xl font-bold text-primary">+{formatCurrency(basket.revDelta)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatCurrency(basket.actRev)} of {formatCurrency(basket.potRev)} potential
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">GP opportunity</div>
                <div className="mt-1 num text-2xl font-bold">{formatCurrency(basket.gpDelta)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatNumber(basket.jobsDelta)} jobs × ${formatNumber(gpPerJob)} GP
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current attainment</div>
                <div className="mt-1 num text-2xl font-bold">{fmtPct(basket.att)}</div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.round(basket.att * 100))}%` }} />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {basket.picks.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => toggleTerritory(t.name)}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground hover:border-primary/50 hover:bg-primary/5"
                >
                  {t.name}
                  <X className="size-3 text-muted-foreground" />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Main table */}
      <Card>
        <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">
            Sub-region performance
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              actual jobs/yr vs target-rate potential · check territories to build a target
            </span>
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            disabled={!rows.length}
            onClick={() =>
              downloadCsv("territory-potential-vs-actuals.csv", [
                ["Level", "Region", "Sub-Region / Territory", "LP Leads", "Potential Jobs/Yr", "Potential Rev/Yr", "Actual Jobs T12M", "Actual Rev T12M", "Jobs Attainment", "Status"],
                ...rows.flatMap((r) => [
                  ["Sub-Region", r.region, r.sub, r.lpLeads, r.potJobs30, r.potRev30, r.actJobs, r.actRev, fmtPct(r.jobsAtt), STATUS_LABEL[r.status]],
                  ...(r.territories ?? []).map((t) => ["Territory", r.region, `${r.sub} › ${t.name}`, t.lpLeads, t.potJobs30, t.potRev30, t.actJobs, t.actRev, fmtPct(t.jobsAtt), t.entered ? STATUS_LABEL[t.status] : "Not entered"]),
                ]),
                ...(outOfModel.length
                  ? [["— OUT OF MODEL —", "", "", "", "", "", "", "", "", ""], ...outOfModel.map((o) => ["Out of model", o.region || "—", o.name, "", "", "", o.jobs, o.rev, "", "Out of model"])]
                  : []),
              ])
            }
          >
            Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-96 w-full" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="w-8 py-2 pr-1 text-left font-medium" aria-label="Add to target" />
                    <th className="py-2 pr-2 text-left font-medium">Sub-Region</th>
                    <th className="px-2 py-2 text-left font-medium">Region</th>
                    <th className="px-2 py-2 text-right font-medium">Actual jobs</th>
                    <th className="px-2 py-2 text-right font-medium">Potential</th>
                    <th className="px-2 py-2 text-left font-medium">Jobs attainment</th>
                    <th className="px-2 py-2 text-right font-medium">Actual rev</th>
                    <th className="px-2 py-2 text-right font-medium">Potential rev</th>
                    <th className="pl-2 py-2 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((d) => {
                    const r = d.row
                    const s = STATUS_STYLE[d.status]
                    const barPct = Math.min(100, Math.round(d.jobsAtt * 100))
                    const hasDetail = !!r.territories?.length
                    const isOpen = expanded.has(r.sub)
                    const terrNames = (r.territories ?? []).map((t) => t.name)
                    const selCount = terrNames.filter((n) => selected.has(n)).length
                    const allSel = terrNames.length > 0 && selCount === terrNames.length
                    const dimmed = hasSelection && !d.inScope
                    return (
                      <FragmentRow key={r.sub}>
                        <tr
                          className={cn(
                            "border-b border-border/50",
                            hasDetail && "cursor-pointer hover:bg-muted/40",
                            dimmed && "opacity-45",
                          )}
                          onClick={hasDetail ? () => toggle(r.sub) : undefined}
                        >
                          <td className="py-2.5 pr-1">
                            {hasDetail ? (
                              <Check
                                checked={allSel}
                                indeterminate={selCount > 0}
                                onChange={() => setMany(terrNames, !allSel)}
                                label={`Add all ${r.sub} territories to target`}
                              />
                            ) : null}
                          </td>
                          <td className="py-2.5 pr-2 font-medium">
                            <span className="flex items-center gap-1.5">
                              {hasDetail ? (
                                <ChevronRight
                                  className={cn(
                                    "size-4 shrink-0 text-muted-foreground transition-transform",
                                    isOpen && "rotate-90",
                                  )}
                                />
                              ) : (
                                <span className="inline-block w-4 shrink-0" />
                              )}
                              {r.sub}
                              {hasSelection && d.inScope && selCount < terrNames.length ? (
                                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-primary">
                                  {selCount}/{terrNames.length}
                                </span>
                              ) : null}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 text-muted-foreground">{r.region}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums font-semibold">
                            {formatNumber(d.actJobs)}
                          </td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                            {formatNumber(d.potJobs30)}
                          </td>
                          <td className="px-2 py-2.5">
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                                <div className={cn("h-full rounded-full", s.bar)} style={{ width: `${barPct}%` }} />
                              </div>
                              <span className={cn("num text-xs font-semibold tabular-nums", s.text)}>
                                {fmtPct(d.jobsAtt)}
                              </span>
                            </div>
                          </td>
                          <td className="px-2 py-2.5 text-right tabular-nums font-semibold">
                            {formatCurrency(d.actRev)}
                          </td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                            {formatCurrency(d.potRev30)}
                          </td>
                          <td className="pl-2 py-2.5 text-right">
                            {dimmed ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              <span
                                className={cn(
                                  "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                                  s.bg,
                                  s.text,
                                )}
                              >
                                {STATUS_LABEL[d.status]}
                              </span>
                            )}
                          </td>
                        </tr>
                        {hasDetail && isOpen
                          ? r.territories!.map((t) => {
                              const ts = STATUS_STYLE[t.status]
                              const tBar = Math.min(100, Math.round(t.jobsAtt * 100))
                              const isSel = selected.has(t.name)
                              return (
                                <tr
                                  key={r.sub + t.name}
                                  className={cn(
                                    "border-b border-border/50 text-[0.8rem]",
                                    isSel ? "bg-primary/5" : "bg-muted/20",
                                  )}
                                >
                                  <td className="py-2 pl-2 pr-1">
                                    <Check
                                      checked={isSel}
                                      onChange={() => toggleTerritory(t.name)}
                                      label={`Add ${t.name} to target`}
                                    />
                                  </td>
                                  <td className="py-2 pr-2 pl-4 text-muted-foreground">
                                    <span className="block">{t.name}</span>
                                    <span className="block text-[0.7rem] text-muted-foreground/70">
                                      {t.entered
                                        ? `${formatNumber(t.lpLeads)} LP leads`
                                        : "not entered yet · no closed-won deals"}
                                    </span>
                                  </td>
                                  <td className="px-2 py-2 text-muted-foreground/60">{`${formatNumber(t.lpLeads)} leads`}</td>
                                  <td className="px-2 py-2 text-right tabular-nums">{formatNumber(t.actJobs)}</td>
                                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                                    {formatNumber(t.potJobs30)}
                                  </td>
                                  <td className="px-2 py-2">
                                    <div className="flex items-center gap-2">
                                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                                        <div
                                          className={cn("h-full rounded-full", ts.bar)}
                                          style={{ width: `${tBar}%` }}
                                        />
                                      </div>
                                      <span className={cn("num text-xs font-semibold tabular-nums", ts.text)}>
                                        {fmtPct(t.jobsAtt)}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-2 py-2 text-right tabular-nums">{formatCurrency(t.actRev)}</td>
                                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                                    {formatCurrency(t.potRev30)}
                                  </td>
                                  <td className="pl-2 py-2 text-right">
                                    <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs", ts.bg, ts.text)}>
                                      {STATUS_LABEL[t.status]}
                                    </span>
                                  </td>
                                </tr>
                              )
                            })
                          : null}
                      </FragmentRow>
                    )
                  })}
                </tbody>
                {displayTotals ? (
                  <tfoot>
                    <tr className={cn("border-t-2 font-semibold", hasSelection && "bg-primary/5")}>
                      <td className="py-2.5 pr-1" />
                      <td className="py-2.5 pr-2">{hasSelection ? "Total (selected)" : "Total (in model)"}</td>
                      <td className="px-2 py-2.5 text-muted-foreground">
                        {hasSelection
                          ? `${selected.size} ${selected.size === 1 ? "territory" : "territories"}`
                          : `${rows.length} sub-regions`}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{formatNumber(displayTotals.actJobs)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatNumber(displayTotals.potJobs30)}
                      </td>
                      <td className="px-2 py-2.5">
                        <span className="num text-xs font-bold">{fmtPct(displayTotals.jobsAtt)}</span>
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{formatCurrency(displayTotals.actRev)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatCurrency(displayTotals.potRev30)}
                      </td>
                      <td className="pl-2 py-2.5" />
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Out-of-model actuals */}
      {outOfModel.length ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              <span className="inline-flex items-center gap-1.5">
                <MapPinned className="size-4" /> Out-of-model actuals
              </span>
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                closed-won in sub-regions with no LP potential benchmark
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-2 text-left font-medium">Sub-Region</th>
                    <th className="px-2 py-2 text-left font-medium">Region</th>
                    <th className="px-2 py-2 text-right font-medium">Actual jobs</th>
                    <th className="px-2 py-2 text-right font-medium">Actual rev</th>
                    <th className="pl-2 py-2 text-right font-medium">Avg sale</th>
                  </tr>
                </thead>
                <tbody>
                  {outOfModel.map((o) => (
                    <tr key={o.name} className="border-b border-border/50">
                      <td className="py-2.5 pr-2 font-medium">{o.name}</td>
                      <td className="px-2 py-2.5 text-muted-foreground">{o.region || "—"}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{formatNumber(o.jobs)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{formatCurrency(o.rev)}</td>
                      <td className="pl-2 py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatCurrency(o.avgSale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Potential is the LeadsPlease target-rate model (Sacramento 0.40%, Bay Area 0.30%; $
        {(data?.model?.avgSale ?? 16500).toLocaleString()} avg ticket,{" "}
        {Math.round((data?.model?.grossMargin ?? 0.64) * 100)}% gross margin), reconciled to the Supabase 48-territory
        carve, updated {data?.model?.pulledOn ?? "2026-08-12"}. Actuals are HubSpot closed-won deals over the trailing 12
        months. This is the SAME territory carve as HubSpot, so both{" "}
        <code className="rounded bg-muted px-1">er_sub_region</code> and{" "}
        <code className="rounded bg-muted px-1">er_territory</code> join by exact name — every sub-region and territory
        reconciles. Each sub-region row expands to its territories with per-territory closed-won jobs and revenue; when a
        deal has no <code className="rounded bg-muted px-1">er_territory</code> it is attributed by its ZIP. Territories
        with no closed-won deals show as “not entered yet” (untapped potential). HubSpot territories outside this Sac + Bay
        universe (Lodi, Manteca, Stockton, Reno, …) appear under Out-of-model.{" "}
        <span className="text-chart-3">Overperforming</span> = at or above the target,{" "}
        <span className="text-chart-4">on pace</span> = 50–99%, <span className="text-destructive">underperforming</span>{" "}
        = below 50%.
      </p>
    </div>
  )
}
