"use client"

import { Fragment, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  FileText,
  Sparkles,
  ChevronDown,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Clock,
  ArrowRight,
  ExternalLink,
  Download,
} from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AnalysisMarkdown } from "@/components/analysis-markdown"
import { cn } from "@/lib/utils"

export type OpenQuoteRow = {
  dealId: string
  dealName: string
  pipeline: string
  stage: string
  amount: number
  quotedDate: string | null
  ageDays: number | null
  lastContacted: string | null
  daysSinceContact: number | null
}
type RepGroup = { rep: string; count: number; amount: number; deals: OpenQuoteRow[] }

export type OpenQuotesData = {
  configured: boolean
  asOf: string
  totalCount: number
  totalAmount: number
  byRep: RepGroup[]
  error?: string
}

type StoredScan = {
  dealId: string
  scanDate: string
  scanType: "baseline" | "update"
  changesDetected: boolean
  engagementCount: number
  markdown: string
  model: string | null
  createdAt: string
}
type ScanHistory = { dealId: string; scans: StoredScan[] }
type DealHealth = "Green" | "Yellow" | "Red"
type DealState = {
  health: DealHealth | null
  probability: number | null
  clearNextStep: boolean | null
  managementAttention: boolean
  managementReason: string
  summary: string
  nextAction: string
  coaching: string
  scanType: "baseline" | "update"
  scanDate: string
  changesDetected: boolean
}
type ScanSummary = {
  dealsScanned: number
  lastScanAt: string | null
  scannedToday: number
  changedToday: number
  states?: Record<string, DealState>
  portalId?: string | null
}

// Deep link to a deal's record in HubSpot (0-3 = deal object type). Returns
// null when we don't know the portal id, so callers can omit the link.
function hubspotDealUrl(portalId: string | null | undefined, dealId: string): string | null {
  if (!portalId) return null
  return `https://app.hubspot.com/contacts/${portalId}/record/0-3/${dealId}`
}

// Quote a value for CSV output, escaping embedded quotes/commas/newlines.
function toCsvCell(v: string | number): string {
  const s = String(v ?? "")
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const HEALTH_DOT: Record<DealHealth, string> = {
  Green: "bg-chart-3",
  Yellow: "bg-chart-4",
  Red: "bg-destructive",
}
const HEALTH_LABEL: Record<DealHealth, string> = {
  Green: "On track",
  Yellow: "Needs attention",
  Red: "At risk",
}

// Small colored health dot + label for a scored deal.
function HealthBadge({ health, className }: { health: DealHealth; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", className)}>
      <span className={cn("size-2 shrink-0 rounded-full", HEALTH_DOT[health])} aria-hidden />
      {HEALTH_LABEL[health]}
    </span>
  )
}

// Full-width daily-scan line item shown directly beneath a deal's data row,
// spanning all columns. Surfaces the deal health, the 1-2 line AI summary, and
// the single recommended next action from that quote's most recent scan, plus
// controls to expand the full 10-field framework analysis and open the deal in
// HubSpot. Renders nothing until the deal has been scanned.
function DealStateRow({
  state,
  colSpan,
  analysisOpen,
  onToggleAnalysis,
  hubspotUrl,
}: {
  state: DealState | undefined
  colSpan: number
  analysisOpen: boolean
  onToggleAnalysis: () => void
  hubspotUrl: string | null
}) {
  if (!state || (!state.summary && !state.nextAction && !state.health)) return null
  const accent =
    state.health === "Red"
      ? "border-destructive/40"
      : state.health === "Yellow"
        ? "border-chart-4/50"
        : state.health === "Green"
          ? "border-chart-3/50"
          : "border-primary/30"
  return (
    <tr className="border-b last:border-0 bg-primary/[0.03]">
      <td colSpan={colSpan} className="px-4 pb-3 pt-0 align-top">
        <div className={cn("flex flex-col gap-1.5 border-l-2 pl-3 text-xs leading-snug", accent)}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex shrink-0 items-center gap-1 font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="size-3 text-primary" aria-hidden />
              Summary
            </span>
            {state.health && <HealthBadge health={state.health} />}
            {state.probability != null && (
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground tabular-nums">{state.probability}%</span> to close
              </span>
            )}
            {state.clearNextStep === false && (
              <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
                <AlertTriangle className="size-3" aria-hidden /> No next step set
              </span>
            )}
          </div>
          {state.summary && <span className="text-pretty text-foreground">{state.summary}</span>}
          {state.nextAction && (
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex shrink-0 items-center gap-1 font-semibold uppercase tracking-wide text-primary">
                <ArrowRight className="size-3" aria-hidden />
                Next action
              </span>
              <span className="text-pretty text-foreground">{state.nextAction}</span>
            </div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            <button
              type="button"
              onClick={onToggleAnalysis}
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              aria-expanded={analysisOpen}
            >
              <ChevronDown className={cn("size-3.5 transition-transform", analysisOpen && "rotate-180")} aria-hidden />
              {analysisOpen ? "Hide full analysis" : "View full analysis"}
            </button>
            {hubspotUrl && (
              <a
                href={hubspotUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground hover:underline"
              >
                <ExternalLink className="size-3.5" aria-hidden />
                Open in HubSpot
              </a>
            )}
          </div>
        </div>
      </td>
    </tr>
  )
}

type FlaggedDeal = { dealId: string; dealName: string; rep: string; amount: number; state: DealState }

// Pinned callout at the top of the section listing every open quote the latest
// scan flagged for manager intervention (Management attention = Yes, or Red
// health). Gives managers a single triage list before the per-rep tables.
function ManagementAttention({
  flagged,
  onJump,
  portalId,
}: {
  flagged: FlaggedDeal[]
  onJump: (dealId: string) => void
  portalId: string | null
}) {
  if (flagged.length === 0) return null
  const total = flagged.reduce((s, f) => s + (f.amount > 0 ? f.amount : 0), 0)

  function exportCsv() {
    const header = [
      "Deal",
      "Sales rep",
      "Health",
      "Probability to close (%)",
      "Amount",
      "Management reason",
      "HubSpot link",
    ]
    const body = flagged.map((f) => [
      f.dealName,
      f.rep,
      f.state.health ?? "",
      f.state.probability ?? "",
      f.amount > 0 ? f.amount : "",
      f.state.managementReason || f.state.summary || "Flagged by the latest AI scan.",
      hubspotDealUrl(portalId, f.dealId) ?? "",
    ])
    const csv = [header, ...body].map((r) => r.map(toCsvCell).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const inIframe = typeof window !== "undefined" && window.self !== window.top

    const download = () => {
      const a = document.createElement("a")
      a.href = url
      a.download = `management-attention-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    // The v0 preview runs in a sandboxed iframe where a programmatic
    // anchor-download is blocked silently, so open the CSV in a new tab there.
    if (inIframe) {
      const win = window.open(url, "_blank", "noopener")
      if (!win) download()
    } else {
      download()
    }
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-destructive" aria-hidden />
          <span className="text-sm font-semibold text-destructive">Deals requiring management attention</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {formatNumber(flagged.length)} {flagged.length === 1 ? "deal" : "deals"}
            {total > 0 ? ` · ${formatCurrency(total)}` : ""}
          </span>
          <Button size="sm" variant="outline" onClick={exportCsv}>
            <Download className="size-4" aria-hidden />
            Export CSV
          </Button>
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-destructive/15">
        {flagged.map((f) => {
          const url = hubspotDealUrl(portalId, f.dealId)
          return (
            <li key={f.dealId} className="py-2 first:pt-0 last:pb-0">
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  {f.state.health && (
                    <span className={cn("size-2 shrink-0 rounded-full", HEALTH_DOT[f.state.health])} aria-hidden />
                  )}
                  <button
                    type="button"
                    onClick={() => onJump(f.dealId)}
                    className="font-medium text-foreground hover:underline"
                  >
                    {f.dealName}
                  </button>
                  <span className="text-xs text-muted-foreground">· {f.rep}</span>
                  {f.amount > 0 && (
                    <span className="text-xs text-muted-foreground tabular-nums">· {formatCurrency(f.amount)}</span>
                  )}
                  {f.state.probability != null && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      · {f.state.probability}% to close
                    </span>
                  )}
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-primary"
                      aria-label={`Open ${f.dealName} in HubSpot`}
                    >
                      <ExternalLink className="size-3" aria-hidden /> HubSpot
                    </a>
                  )}
                </div>
                <button type="button" onClick={() => onJump(f.dealId)} className="text-left">
                  <span className="text-pretty text-xs text-foreground">
                    {f.state.managementReason || f.state.summary || "Flagged by the latest AI scan."}
                  </span>
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const QUIET_DAYS = 14

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "never"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "never"
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

// One stored scan, rendered with a type/date/changes header.
function ScanEntry({ scan, defaultOpen }: { scan: StoredScan; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const isBaseline = scan.scanType === "baseline"
  return (
    <div className="rounded-md border bg-background">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide",
              isBaseline ? "bg-primary/10 text-primary" : "bg-muted text-foreground",
            )}
          >
            {isBaseline ? "Baseline" : "Daily update"}
          </span>
          <span className="text-muted-foreground tabular-nums">{fmtDate(scan.scanDate)}</span>
          {!isBaseline &&
            (scan.changesDetected ? (
              <span className="rounded-full bg-chart-3/15 px-2 py-0.5 font-medium text-chart-3">New activity</span>
            ) : (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">No change</span>
            ))}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="border-t px-3 py-3">
          <AnalysisMarkdown text={scan.markdown} />
        </div>
      )}
    </div>
  )
}

// Daily-scan timeline for one open quote: baseline summary + evaluation, then
// each day's change/action-item update. Reads the stored scans; lets the rep
// run a scan on demand.
function ScanPanel({ dealId }: { dealId: string }) {
  const queryClient = useQueryClient()
  const [scanning, setScanning] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ["open-quote-scans", dealId],
    queryFn: () => apiGet<ScanHistory>(`/api/hs/open-quotes/scans?dealId=${dealId}`),
    staleTime: 60_000,
  })

  const runScan = async () => {
    setScanning(true)
    setErr(null)
    try {
      const res = await apiPost<{ error?: string }>("/api/hs/open-quotes/daily-scan", { dealId })
      if (res?.error) setErr(res.error)
      await queryClient.invalidateQueries({ queryKey: ["open-quote-scans", dealId] })
      queryClient.invalidateQueries({ queryKey: ["open-quote-scan-summary"] })
    } catch (e) {
      setErr((e as Error).message || "Scan failed.")
    } finally {
      setScanning(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
        Loading scan history…
      </div>
    )
  }

  const scans = data?.scans ?? []

  if (scans.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 py-2">
        <p className="text-sm text-muted-foreground">
          This quote hasn&apos;t been scanned yet. Run the first scan to generate a summary and evaluation. After that,
          the nightly scan tracks what changes and gives daily action items.
        </p>
        {err && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{err}</span>
          </div>
        )}
        <Button size="sm" onClick={runScan} disabled={scanning}>
          {scanning ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Scanning…
            </>
          ) : (
            <>
              <Sparkles className="size-4" aria-hidden /> Run summary &amp; evaluation
            </>
          )}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {scans.length} scan{scans.length === 1 ? "" : "s"} · last {fmtDateTime(scans[0].createdAt)}
          {scans[0].model ? ` · ${scans[0].model}` : ""}
        </p>
        <Button size="sm" variant="outline" onClick={runScan} disabled={scanning}>
          {scanning ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden /> Scanning…
            </>
          ) : (
            <>
              <RefreshCw className="size-4" aria-hidden /> Re-scan now
            </>
          )}
        </Button>
      </div>
      {err && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{err}</span>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {scans.map((s, i) => (
          <ScanEntry key={s.scanDate + s.createdAt} scan={s} defaultOpen={i === 0} />
        ))}
      </div>
      <p className="text-[0.7rem] text-muted-foreground">Generated by AI from HubSpot deal data. Review before acting.</p>
    </div>
  )
}

// All deals currently sitting in the Quoted stage (Express Reface pipeline),
// grouped by the deal owner. Prop-driven from the nightly Sales Manager
// snapshot; each row expands to the deal's daily AI-scan timeline.
export function OpenQuotesSection({ data, loading }: { data: OpenQuotesData | null; loading: boolean }) {
  const byRep = data?.byRep ?? []
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [scanningAll, setScanningAll] = useState(false)
  const [allResult, setAllResult] = useState<string | null>(null)

  const summary = useQuery({
    queryKey: ["open-quote-scan-summary"],
    queryFn: () => apiGet<ScanSummary>("/api/hs/open-quotes/scans"),
    enabled: !!data && !data.error,
    staleTime: 60_000,
  })

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const states = summary.data?.states
  const portalId = summary.data?.portalId ?? null

  // Deals the latest scan flagged for manager intervention (explicit flag or
  // Red health), sorted by amount so the biggest at-risk deals lead.
  const flagged = useMemo<FlaggedDeal[]>(() => {
    if (!states) return []
    const out: FlaggedDeal[] = []
    for (const g of byRep) {
      for (const d of g.deals) {
        const state = states[d.dealId]
        if (state && (state.managementAttention || state.health === "Red")) {
          out.push({ dealId: d.dealId, dealName: d.dealName, rep: g.rep, amount: d.amount, state })
        }
      }
    }
    return out.sort((a, b) => b.amount - a.amount)
  }, [states, byRep])

  const jumpToDeal = (id: string) => {
    setExpanded((prev) => new Set(prev).add(id))
    requestAnimationFrame(() => {
      document.getElementById(`oq-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    })
  }

  const scanAll = async () => {
    setScanningAll(true)
    setAllResult(null)
    try {
      const r = await apiPost<{
        scanned: number
        baselines: number
        updates: number
        changed: number
        skipped: number
        total: number
        timedOut: boolean
        error?: string
      }>("/api/hs/open-quotes/daily-scan", {})
      if (r?.error) {
        setAllResult(r.error)
      } else {
        setAllResult(
          `Scanned ${r.scanned} of ${r.total} · ${r.baselines} new, ${r.updates} updated · ${r.changed} with changes` +
            (r.timedOut ? ` · ${r.skipped} left for the next run` : ""),
        )
      }
      queryClient.invalidateQueries({ queryKey: ["open-quote-scan-summary"] })
      queryClient.invalidateQueries({ queryKey: ["open-quote-scans"] })
    } catch (e) {
      setAllResult((e as Error).message || "Scan failed.")
    } finally {
      setScanningAll(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="text-base">
            Open quotes
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              every deal currently in the Quoted stage, by rep · expand a row for its daily AI scan
            </span>
          </CardTitle>
          {!!data && !data.error && (
            <div className="flex items-center gap-3">
              <span className="hidden text-xs text-muted-foreground sm:flex sm:items-center sm:gap-1">
                <Clock className="size-3.5" aria-hidden />
                {summary.data?.lastScanAt
                  ? `Scanned ${summary.data.scannedToday} today · ${summary.data.changedToday} changed`
                  : "Not scanned yet"}
              </span>
              <Button size="sm" variant="outline" onClick={scanAll} disabled={scanningAll}>
                {scanningAll ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Scanning all…
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" aria-hidden /> Scan all quotes now
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
        {allResult && <p className="mt-2 text-xs text-muted-foreground">{allResult}</p>}
      </CardHeader>
      <CardContent>
        {data?.error ? (
          <div className="py-2 text-sm text-destructive">{data.error || "Failed to load open quotes."}</div>
        ) : loading ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : byRep.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No open quotes right now.</div>
        ) : (
          <div className="flex flex-col gap-5">
            <ManagementAttention flagged={flagged} onJump={jumpToDeal} portalId={portalId} />

            {/* Totals strip */}
            <div className="flex flex-wrap gap-6 rounded-lg border bg-muted/30 p-4">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Open quotes</div>
                <div className="mt-1 num text-2xl font-bold">{formatNumber(data?.totalCount ?? 0)}</div>
              </div>
              <div className="border-l pl-6">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Total open value
                </div>
                <div className="mt-1 num text-2xl font-bold">{formatCurrency(data?.totalAmount ?? 0)}</div>
              </div>
              <div className="border-l pl-6">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sales reps</div>
                <div className="mt-1 num text-2xl font-bold">{formatNumber(byRep.length)}</div>
              </div>
            </div>

            {byRep.map((g) => (
              <div key={g.rep} className="overflow-hidden rounded-lg border">
                <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <FileText className="size-4 text-muted-foreground" aria-hidden />
                    <span className="font-semibold">{g.rep}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatNumber(g.count)} {g.count === 1 ? "quote" : "quotes"} · {formatCurrency(g.amount)}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[880px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2 text-left font-medium">Deal</th>
                        <th className="px-4 py-2 text-left font-medium">Stage</th>
                        <th className="px-4 py-2 text-left font-medium">Quoted</th>
                        <th className="px-4 py-2 text-right font-medium">Age</th>
                        <th className="px-4 py-2 text-left font-medium">Last contact</th>
                        <th className="px-4 py-2 text-right font-medium">Amount</th>
                        <th className="px-4 py-2 text-right font-medium">AI scan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.deals.map((d) => {
                        const isOpen = expanded.has(d.dealId)
                        const quiet = d.daysSinceContact == null || d.daysSinceContact >= QUIET_DAYS
                        return (
                          <Fragment key={d.dealId}>
                            <tr
                              id={`oq-row-${d.dealId}`}
                              className={cn(
                                "cursor-pointer border-b last:border-0 align-top hover:bg-muted/30 scroll-mt-24",
                                isOpen && "bg-muted/30",
                              )}
                              onClick={() => toggle(d.dealId)}
                            >
                              <td className="max-w-[280px] px-4 py-2 align-top font-medium">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate" title={d.dealName}>
                                    {d.dealName}
                                  </span>
                                  {hubspotDealUrl(portalId, d.dealId) && (
                                    <a
                                      href={hubspotDealUrl(portalId, d.dealId)!}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="shrink-0 text-muted-foreground/60 hover:text-primary"
                                      aria-label={`Open ${d.dealName} in HubSpot`}
                                      title="Open in HubSpot"
                                    >
                                      <ExternalLink className="size-3.5" aria-hidden />
                                    </a>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-2">
                                <span className="inline-block rounded-full border bg-muted/50 px-2 py-0.5 text-xs font-medium text-foreground">
                                  {d.stage || "—"}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-muted-foreground tabular-nums">{fmtDate(d.quotedDate)}</td>
                              <td className="px-4 py-2 text-right tabular-nums font-semibold">
                                {d.ageDays == null ? "—" : `${formatNumber(d.ageDays)}d`}
                              </td>
                              <td className="px-4 py-2 tabular-nums">
                                {d.daysSinceContact == null ? (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/5 px-2 py-0.5 text-xs font-medium text-destructive">
                                    <AlertTriangle className="size-3" aria-hidden /> None logged
                                  </span>
                                ) : (
                                  <span
                                    className={cn(
                                      "text-muted-foreground",
                                      quiet && "font-medium text-destructive",
                                    )}
                                  >
                                    {formatNumber(d.daysSinceContact)}d ago
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                                {d.amount > 0 ? formatCurrency(d.amount) : "—"}
                              </td>
                              <td className="px-4 py-2 text-right">
                                <span
                                  className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs font-medium text-primary"
                                  aria-label={`${isOpen ? "Hide" : "Show"} AI scan for ${d.dealName}`}
                                >
                                  <Sparkles className="size-3.5" aria-hidden />
                                  {isOpen ? "Hide" : "Scan"}
                                  <ChevronDown
                                    className={cn("size-3.5 transition-transform", isOpen && "rotate-180")}
                                    aria-hidden
                                  />
                                </span>
                              </td>
                            </tr>
                            <DealStateRow
                              state={states?.[d.dealId]}
                              colSpan={7}
                              analysisOpen={isOpen}
                              onToggleAnalysis={() => toggle(d.dealId)}
                              hubspotUrl={hubspotDealUrl(portalId, d.dealId)}
                            />
                            {isOpen && (
                              <tr className="border-b last:border-0 bg-muted/10">
                                <td colSpan={7} className="px-4 py-4">
                                  <ScanPanel dealId={d.dealId} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
