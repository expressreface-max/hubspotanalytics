"use client"

import { Fragment, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, Megaphone, AlertTriangle, RefreshCw } from "lucide-react"
import { apiGet, formatCurrency, formatNumber } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const WINDOW_KEYS = ["yesterday", "last7", "last30", "last60", "last90"] as const
type WindowKey = (typeof WINDOW_KEYS)[number]
const WINDOW_LABEL: Record<WindowKey, string> = {
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last30: "Last 30 days",
  last60: "Last 60 days",
  last90: "Last 90 days",
}

const METRICS = [
  { key: "conversions", label: "Conversions", fmt: "number" },
  { key: "costPerConv", label: "Cost / conversion", fmt: "currency" },
  { key: "cpm", label: "Cost / 1,000 impr. (CPM)", fmt: "currency" },
  { key: "cpc", label: "Cost / click (CPC)", fmt: "currency" },
  { key: "convPerClick", label: "Conversions / click", fmt: "ratio" },
] as const
type MetricKey = (typeof METRICS)[number]["key"]
type MetricFmt = (typeof METRICS)[number]["fmt"]

type WindowMetrics = {
  conversions: number
  cost: number
  impressions: number
  clicks: number
  costPerConv: number | null
  cpm: number | null
  cpc: number | null
  convPerClick: number | null
}
type Platform = "meta" | "google"
type Campaign = { platform: Platform; campaignId: string; name: string; windows: Record<WindowKey, WindowMetrics> }
type Report = {
  configured: boolean
  generatedAt?: string
  range?: { from: string; to: string }
  platforms?: Record<string, { ok: boolean; error?: string; campaigns: number }>
  notes?: string[]
  campaigns: Campaign[]
  totals?: Record<"meta" | "google" | "combined", Record<WindowKey, WindowMetrics>>
}

const PLATFORM_LABEL: Record<Platform, string> = { meta: "Meta (Facebook)", google: "Google Ads" }

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-accent",
      )}
    >
      {children}
    </button>
  )
}

function fmtValue(v: number | null | undefined, fmt: MetricFmt): string {
  if (v === null || v === undefined || Number.isNaN(v) || !Number.isFinite(v)) return "–"
  if (fmt === "currency") return formatCurrency(v)
  if (fmt === "ratio") return v === 0 ? "–" : v.toLocaleString("en-US", { maximumFractionDigits: 3 })
  return formatNumber(Math.round(v))
}

function metricOf(w: WindowMetrics | undefined, key: MetricKey): number | null {
  if (!w) return null
  return w[key]
}

export function AdsPerformanceView() {
  const [metric, setMetric] = useState<MetricKey>("conversions")
  const [platform, setPlatform] = useState<"all" | Platform>("all")

  const { data, isLoading, isFetching, refetch } = useQuery<Report>({
    queryKey: ["ads-performance"],
    queryFn: () => apiGet("/api/ads/performance"),
    staleTime: 5 * 60_000,
  })

  const metricDef = METRICS.find((m) => m.key === metric)!
  const configured = data?.configured

  const campaigns = useMemo(() => {
    const list = data?.campaigns ?? []
    return platform === "all" ? list : list.filter((c) => c.platform === platform)
  }, [data, platform])

  // Group campaigns by platform for subtotal rows.
  const grouped = useMemo(() => {
    const g: Record<Platform, Campaign[]> = { meta: [], google: [] }
    for (const c of campaigns) g[c.platform].push(c)
    return (["meta", "google"] as Platform[]).filter((p) => g[p].length > 0).map((p) => ({ platform: p, rows: g[p] }))
  }, [campaigns])

  const totalsRow = (p: "meta" | "google" | "combined") => data?.totals?.[p]

  function exportCsv() {
    const header = ["Platform", "Campaign", "Metric", ...WINDOW_KEYS.map((k) => WINDOW_LABEL[k])]
    const lines = [header]
    for (const c of campaigns) {
      for (const m of METRICS) {
        lines.push([
          PLATFORM_LABEL[c.platform],
          c.name,
          m.label,
          ...WINDOW_KEYS.map((k) => {
            const v = metricOf(c.windows[k], m.key)
            return v === null || v === undefined ? "" : String(v)
          }),
        ])
      }
    }
    const csv = lines.map((r) => r.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const inIframe = typeof window !== "undefined" && window.self !== window.top
    const download = () => {
      const a = document.createElement("a")
      a.href = url
      a.download = `ad-performance-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    if (inIframe) {
      const w = window.open(url, "_blank", "noopener")
      if (!w) download()
    } else download()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const genText = data?.generatedAt
    ? `Live pull · ${new Date(data.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "Live pull on page load"

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ad Performance"
        description={`Daily Meta (Facebook) + Google Ads campaign performance across five windows. ${genText}.`}
      />

      {!isLoading && configured === false ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
              <Megaphone className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-medium">Ad platforms are not connected</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Add <code className="rounded bg-muted px-1">ADS_SUPABASE_URL</code> and{" "}
                <code className="rounded bg-muted px-1">ADS_SUPABASE_SERVICE_KEY</code> in Settings → Vars so the app can
                read the stored Meta and Google Ads credentials.
              </p>
            </div>
            {data?.notes?.length ? (
              <ul className="max-w-md space-y-1 text-left text-xs text-muted-foreground">
                {data.notes.map((n, i) => (
                  <li key={i}>• {n}</li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Per-platform status / errors */}
          {data?.platforms
            ? (Object.entries(data.platforms) as [string, { ok: boolean; error?: string }][])
                .filter(([, s]) => !s.ok && s.error && s.error !== "not configured")
                .map(([p, s]) => (
                  <div
                    key={p}
                    className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                  >
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>
                      <strong>{PLATFORM_LABEL[p as Platform] ?? p}:</strong> {s.error}
                    </span>
                  </div>
                ))
            : null}

          {/* Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {METRICS.map((m) => (
                <Pill key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>
                  {m.label}
                </Pill>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Pill active={platform === "all"} onClick={() => setPlatform("all")}>
                All
              </Pill>
              <Pill active={platform === "meta"} onClick={() => setPlatform("meta")}>
                Meta
              </Pill>
              <Pill active={platform === "google"} onClick={() => setPlatform("google")}>
                Google
              </Pill>
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={cn("size-4", isFetching && "animate-spin")} aria-hidden />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={!campaigns.length}>
                <Download className="size-4" aria-hidden />
                Export CSV
              </Button>
            </div>
          </div>

          {/* Summary tiles: selected metric, combined totals across windows */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {WINDOW_KEYS.map((k) => {
              const src = platform === "all" ? totalsRow("combined") : totalsRow(platform)
              const v = metricOf(src?.[k], metric)
              return (
                <Card key={k}>
                  <CardContent className="p-4">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {WINDOW_LABEL[k]}
                    </div>
                    {isLoading ? (
                      <Skeleton className="mt-2 h-7 w-20" />
                    ) : (
                      <div className="mt-1 num text-xl font-bold">{fmtValue(v, metricDef.fmt)}</div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {/* Matrix */}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="sticky left-0 z-10 bg-muted/40 px-4 py-2.5 font-semibold">
                        Campaign <span className="font-normal text-muted-foreground">· {metricDef.label}</span>
                      </th>
                      {WINDOW_KEYS.map((k) => (
                        <th key={k} className="px-4 py-2.5 text-right font-semibold">
                          {WINDOW_LABEL[k]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      [...Array(6)].map((_, i) => (
                        <tr key={i} className="border-b">
                          <td className="sticky left-0 bg-card px-4 py-2.5">
                            <Skeleton className="h-4 w-40" />
                          </td>
                          {WINDOW_KEYS.map((k) => (
                            <td key={k} className="px-4 py-2.5 text-right">
                              <Skeleton className="ml-auto h-4 w-12" />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : campaigns.length === 0 ? (
                      <tr>
                        <td colSpan={WINDOW_KEYS.length + 1} className="px-4 py-10 text-center text-muted-foreground">
                          No campaigns returned for the selected platform.
                        </td>
                      </tr>
                    ) : (
                      grouped.map((group) => (
                        <Fragment key={group.platform}>
                          <tr className="border-b bg-muted/60">
                            <td className="sticky left-0 z-10 bg-muted/60 px-4 py-2 text-xs font-bold uppercase tracking-wide">
                              {PLATFORM_LABEL[group.platform]}
                            </td>
                            {WINDOW_KEYS.map((k) => (
                              <td key={k} className="px-4 py-2 text-right num font-semibold">
                                {fmtValue(metricOf(totalsRow(group.platform)?.[k], metric), metricDef.fmt)}
                              </td>
                            ))}
                          </tr>
                          {group.rows.map((c) => (
                            <tr key={c.campaignId} className="border-b last:border-0 hover:bg-accent/40">
                              <td className="sticky left-0 z-10 max-w-[280px] truncate bg-card px-4 py-2.5" title={c.name}>
                                {c.name}
                              </td>
                              {WINDOW_KEYS.map((k) => (
                                <td key={k} className="px-4 py-2.5 text-right num">
                                  {fmtValue(metricOf(c.windows[k], metric), metricDef.fmt)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </Fragment>
                      ))
                    )}
                  </tbody>
                  {!isLoading && campaigns.length > 0 ? (
                    <tfoot>
                      <tr className="border-t-2 bg-muted/40 font-bold">
                        <td className="sticky left-0 z-10 bg-muted/40 px-4 py-2.5">
                          {platform === "all" ? "Combined total" : `${PLATFORM_LABEL[platform]} total`}
                        </td>
                        {WINDOW_KEYS.map((k) => {
                          const src = platform === "all" ? totalsRow("combined") : totalsRow(platform)
                          return (
                            <td key={k} className="px-4 py-2.5 text-right num">
                              {fmtValue(metricOf(src?.[k], metric), metricDef.fmt)}
                            </td>
                          )
                        })}
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Conversions use each platform&apos;s native conversion counting (Meta pixel/offsite conversions + leads;
            Google Ads <code className="rounded bg-muted px-1">metrics.conversions</code>). Ratios are computed after
            summing each window: cost per conversion, CPM (cost per 1,000 impressions), CPC, and conversions per click.
            Each window ends yesterday; today is excluded as an incomplete day. Data is pulled live on page load.
          </p>
        </>
      )}
    </div>
  )
}
