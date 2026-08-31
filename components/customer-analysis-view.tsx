"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Play, Download, Loader2, Home, User2, MapPin } from "lucide-react"
import { apiGet, apiPost, formatCurrency, formatNumber } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { cn } from "@/lib/utils"

type Status = { configured: boolean }

type PropertyDetail = {
  yearBuilt: number | null
  propertyType: string | null
  bedrooms: number | null
  bathrooms: number | null
  livingSquareFeet: number | null
  estimatedValue: number | null
  estimatedEquity: number | null
  ownerOccupied: boolean | null
  absenteeOwner: boolean | null
  lastSaleDate: string | null
  lastSalePrice: number | null
  medianIncomeArea: number | null
}

type SkipTraceOwner = {
  fullName: string | null
  age: number | null
  maritalStatus: string | null
  occupation: string | null
}

type Enrichment = {
  property: PropertyDetail | null
  owner: SkipTraceOwner | null
  propertyError: string | null
  skipTraceError: string | null
}

type DealDetailEnrichment = {
  source: "table" | "live" | null
  propertyDataAvailable: boolean
  ownerDataAvailable: boolean
  propertyError: string | null
  ownerError: string | null
  estimatedValue: number | null
  estimatedEquity: number | null
  equityPercent: number | null
  lastSaleDate: string | null
  lastSalePrice: number | null
  ownerOccupied: boolean | null
  absenteeOwner: boolean | null
  vacant: boolean | null
  highEquity: boolean | null
  propertyType: string | null
  yearBuilt: number | null
  livingSquareFeet: number | null
  bedrooms: number | null
  bathrooms: number | null
  lotSquareFeet: number | null
  floodZone: boolean | null
  mlsActive: boolean | null
  mlsListingPrice: number | null
  mlsStatus: string | null
  ownerFullName: string | null
  ownerAge: number | null
  ownerGender: string | null
  ownerMaritalStatus: string | null
  ownerOccupation: string | null
  ownerEmails: string[]
  ownerPhones: string[]
  ownerDncAllPhones: boolean | null
  erTerritory: string | null
  erSubRegion: string | null
  erRegion: string | null
  fetchedAt: string | null
}

// Merge the deal-keyed table enrichment (primary) with the legacy live
// per-address enrichment (fallback for deals the nightly cron hasn't
// reached yet) into the single shape the charts/table already read.
function mergedEnrichment(r: CustomerRow): {
  property: (PropertyDetail & { equityPercent: number | null; mlsStatus: string | null; mlsListingPrice: number | null; floodZone: boolean | null }) | null
  owner: (SkipTraceOwner & { emails: string[]; phones: string[]; dnc: boolean | null }) | null
  propertyError: string | null
  skipTraceError: string | null
  source: "table" | "live" | null
} {
  const de = r.dealEnrichment
  if (de) {
    return {
      property:
        de.propertyDataAvailable || de.estimatedValue != null
          ? {
              yearBuilt: de.yearBuilt,
              propertyType: de.propertyType,
              bedrooms: de.bedrooms,
              bathrooms: de.bathrooms,
              livingSquareFeet: de.livingSquareFeet,
              estimatedValue: de.estimatedValue,
              estimatedEquity: de.estimatedEquity,
              ownerOccupied: de.ownerOccupied,
              absenteeOwner: de.absenteeOwner,
              lastSaleDate: de.lastSaleDate,
              lastSalePrice: de.lastSalePrice,
              medianIncomeArea: null,
              equityPercent: de.equityPercent,
              mlsStatus: de.mlsStatus,
              mlsListingPrice: de.mlsListingPrice,
              floodZone: de.floodZone,
            }
          : null,
      owner: de.ownerDataAvailable
        ? {
            fullName: de.ownerFullName,
            age: de.ownerAge,
            maritalStatus: de.ownerMaritalStatus,
            occupation: de.ownerOccupation,
            emails: de.ownerEmails || [],
            phones: de.ownerPhones || [],
            dnc: de.ownerDncAllPhones,
          }
        : null,
      propertyError: de.propertyError,
      skipTraceError: de.ownerError,
      source: "table",
    }
  }
  const le = r.enrichment
  return {
    property: le?.property ? { ...le.property, equityPercent: null, mlsStatus: null, mlsListingPrice: null, floodZone: null } : null,
    owner: le?.owner ? { ...le.owner, emails: [], phones: [], dnc: null } : null,
    propertyError: le?.propertyError ?? null,
    skipTraceError: le?.skipTraceError ?? null,
    source: le ? "live" : null,
  }
}

type DealStatus = "open" | "closed_won" | "closed_lost"

type CustomerRow = {
  contactId: string
  dealId: string
  dealName: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  dealAmount: number
  quotedAt: string | null
  closedWon: boolean
  dealStatus: DealStatus
  closedAt: string | null
  dealStage: string | null
  dealStageLabel: string | null
  pipeline: string | null
  enrichment: Enrichment | null
  dealEnrichment: DealDetailEnrichment | null
}

type CustomerAnalysisResponse = {
  scope: "ever_quoted" | "closed_won"
  rows: CustomerRow[]
  total: number
  totalDealsFetched: number
  missingAddress: number
  reapiConfigured: boolean
  enriched: boolean
  liveEnrichSkipped?: number
}

// Three table pages the customer detail table toggles between:
// "Quoted" = deals currently sitting in a quoted stage, still open.
// "Closed" = deals that closed WON (the default closed view).
// "Closed lost" = deals that closed LOST, selected separately so the two
// outcomes are never shown mixed together.
const TABLE_PAGES = [
  { key: "quoted" as const, label: "Quoted" },
  { key: "closed_won" as const, label: "Closed" },
  { key: "closed_lost" as const, label: "Closed lost" },
]
type TablePage = (typeof TABLE_PAGES)[number]["key"]

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

function fmtDate(iso: string | null): string {
  if (!iso) return "–"
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// Years the current owner has lived in the home, based on last sale date.
function yearsInHome(lastSaleDate: string | null): number | null {
  if (!lastSaleDate) return null
  const t = Date.parse(lastSaleDate)
  if (Number.isNaN(t)) return null
  const years = (Date.now() - t) / (365.25 * 24 * 60 * 60 * 1000)
  return years >= 0 ? Math.floor(years * 10) / 10 : null
}

function fmtYearsInHome(y: number | null): string {
  if (y == null) return "–"
  return `${y.toFixed(1)} yr${y === 1 ? "" : "s"}`
}

// Days a deal has been sitting in a quoted stage (quotedAt -> now, or
// quotedAt -> closedAt if it has since closed).
function daysQuoted(quotedAt: string | null, closedAt: string | null): number | null {
  if (!quotedAt) return null
  const start = Date.parse(quotedAt)
  if (Number.isNaN(start)) return null
  const endRaw = closedAt ? Date.parse(closedAt) : Date.now()
  const end = Number.isNaN(endRaw) ? Date.now() : endRaw
  const days = Math.round((end - start) / (24 * 60 * 60 * 1000))
  return days >= 0 ? days : null
}

function quotedYear(quotedAt: string | null): number | null {
  if (!quotedAt) return null
  const t = new Date(quotedAt)
  if (Number.isNaN(t.getTime())) return null
  return t.getFullYear()
}

// ---- Distribution / comparison chart data ----

// Years to break every distribution chart out by, per quoted-date year.
const CHART_YEARS = [2023, 2024, 2025, 2026] as const
type ChartYear = (typeof CHART_YEARS)[number]

const AGE_BUCKETS = [
  { key: "<35", test: (a: number) => a < 35 },
  { key: "35-44", test: (a: number) => a >= 35 && a < 45 },
  { key: "45-54", test: (a: number) => a >= 45 && a < 55 },
  { key: "55-64", test: (a: number) => a >= 55 && a < 65 },
  { key: "65-74", test: (a: number) => a >= 65 && a < 75 },
  { key: "75+", test: (a: number) => a >= 75 },
]

const VALUE_BUCKETS = [
  { key: "<$300k", test: (v: number) => v < 300_000 },
  { key: "$300-500k", test: (v: number) => v >= 300_000 && v < 500_000 },
  { key: "$500-700k", test: (v: number) => v >= 500_000 && v < 700_000 },
  { key: "$700k-1M", test: (v: number) => v >= 700_000 && v < 1_000_000 },
  { key: "$1-1.5M", test: (v: number) => v >= 1_000_000 && v < 1_500_000 },
  { key: "$1.5M+", test: (v: number) => v >= 1_500_000 },
]

const YEAR_BUILT_BUCKETS = [
  { key: "<1960", test: (y: number) => y < 1960 },
  { key: "1960-79", test: (y: number) => y >= 1960 && y < 1980 },
  { key: "1980-99", test: (y: number) => y >= 1980 && y < 2000 },
  { key: "2000-14", test: (y: number) => y >= 2000 && y < 2015 },
  { key: "2015+", test: (y: number) => y >= 2015 },
]

// Build a grouped-bar dataset: one row per bucket, with a count column per
// chart year (keyed "y2023", "y2024", ...), based on each row's quoted year.
function buildYearGroupedBuckets<T extends number>(
  rows: CustomerRow[],
  extractValue: (r: CustomerRow) => T | null | undefined,
  buckets: { key: string; test: (v: T) => boolean }[],
): Record<string, string | number>[] {
  return buckets.map((b) => {
    const out: Record<string, string | number> = { bucket: b.key }
    for (const yr of CHART_YEARS) out[`y${yr}`] = 0
    for (const r of rows) {
      const qy = quotedYear(r.quotedAt)
      if (!qy || !CHART_YEARS.includes(qy as ChartYear)) continue
      const v = extractValue(r)
      if (v == null || typeof v !== "number" || !b.test(v as T)) continue
      out[`y${qy}`] = (out[`y${qy}`] as number) + 1
    }
    return out
  })
}

function median(nums: number[]): number {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function avg(nums: number[]): number {
  if (!nums.length) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

type BucketRow = { bucket: string; count: number }
type YearBucketRow = Record<string, string | number>
type WonLostCompareRow = { metric: string; closedWon: number; closedLost: number }

function buildDistributionCharts(rows: CustomerRow[]) {
  const won = rows.filter((r) => r.dealStatus === "closed_won")
  const lost = rows.filter((r) => r.dealStatus === "closed_lost")

  // Year built distribution, grouped by quoted year (2023-2026).
  const yearBuiltByYear: YearBucketRow[] = buildYearGroupedBuckets(
    rows,
    (r) => mergedEnrichment(r).property?.yearBuilt ?? null,
    YEAR_BUILT_BUCKETS,
  )

  // Owner age distribution, grouped by quoted year (2023-2026).
  const ownerAgeDistribution: YearBucketRow[] = buildYearGroupedBuckets(
    rows,
    (r) => mergedEnrichment(r).owner?.age ?? null,
    AGE_BUCKETS,
  )

  // Home value distribution, grouped by quoted year (2023-2026).
  const homeValueDistribution: YearBucketRow[] = buildYearGroupedBuckets(
    rows,
    (r) => mergedEnrichment(r).property?.estimatedValue ?? null,
    VALUE_BUCKETS,
  )

  // Closed-won vs closed-lost comparison across key metrics.
  const wonYears = won.map((r) => mergedEnrichment(r).property?.yearBuilt).filter((y): y is number => !!y)
  const lostYears = lost.map((r) => mergedEnrichment(r).property?.yearBuilt).filter((y): y is number => !!y)
  const wonAges = won.map((r) => mergedEnrichment(r).owner?.age).filter((a): a is number => typeof a === "number" && a > 0)
  const lostAges = lost.map((r) => mergedEnrichment(r).owner?.age).filter((a): a is number => typeof a === "number" && a > 0)
  const wonValues = won
    .map((r) => mergedEnrichment(r).property?.estimatedValue)
    .filter((v): v is number => typeof v === "number" && v > 0)
  const lostValues = lost
    .map((r) => mergedEnrichment(r).property?.estimatedValue)
    .filter((v): v is number => typeof v === "number" && v > 0)
  const wonDealAmt = won.map((r) => r.dealAmount).filter((v) => v > 0)
  const lostDealAmt = lost.map((r) => r.dealAmount).filter((v) => v > 0)

  const wonLostComparison: WonLostCompareRow[] = [
    { metric: "Median year built", closedWon: Math.round(median(wonYears)), closedLost: Math.round(median(lostYears)) },
    { metric: "Median owner age", closedWon: Math.round(median(wonAges)), closedLost: Math.round(median(lostAges)) },
    {
      metric: "Median home value ($k)",
      closedWon: Math.round(median(wonValues) / 1000),
      closedLost: Math.round(median(lostValues) / 1000),
    },
    {
      metric: "Avg deal amount ($k)",
      closedWon: Math.round(avg(wonDealAmt) / 1000),
      closedLost: Math.round(avg(lostDealAmt) / 1000),
    },
  ]

  return {
    yearBuiltByYear,
    ownerAgeDistribution,
    homeValueDistribution,
    wonLostComparison,
    wonCount: won.length,
    lostCount: lost.length,
    hasEnrichment: rows.some((r) => mergedEnrichment(r).property || mergedEnrichment(r).owner),
  }
}

// Shared config for the 4-year grouped bar charts (age / home value / year built).
const yearGroupedChartConfig: ChartConfig = {
  y2023: { label: "2023", color: "var(--chart-1)" },
  y2024: { label: "2024", color: "var(--chart-2)" },
  y2025: { label: "2025", color: "var(--chart-3)" },
  y2026: { label: "2026", color: "var(--chart-4)" },
}

const wonLostConfig: ChartConfig = {
  closedWon: { label: "Closed Won", color: "var(--chart-2)" },
  closedLost: { label: "Closed Lost", color: "var(--destructive)" },
}

function EmptyChartNote({ hasEnrichment }: { hasEnrichment: boolean }) {
  return (
    <div className="flex h-[240px] items-center justify-center text-center text-sm text-muted-foreground">
      {hasEnrichment
        ? "No data available for this chart yet."
        : "Requires property/owner enrichment (RealEstateAPI) — not available for these records."}
    </div>
  )
}

export function CustomerAnalysisView() {
  const [tablePage, setTablePage] = useState<TablePage>("quoted")

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<Status>("/api/hs/config/status"),
  })
  const connected = status.data?.configured

  // Always fetch the full ever-quoted superset (open + won + lost, no row
  // cap) so the distribution/comparison charts and the table both see every
  // qualifying customer back through the full lookback window — no `limit`
  // is passed, so the backend returns everything instead of silently
  // truncating to the most-recently-quoted N rows.
  const report = useQuery({
    queryKey: ["customer-analysis", "ever_quoted"],
    queryFn: () =>
      apiPost<CustomerAnalysisResponse>("/api/hs/customer-analysis", {
        scope: "ever_quoted",
        enrich: true,
      }),
    enabled: !!connected,
  })

  const allData = report.data
  // "Quoted" = deals still open. "Closed" = closed won only. "Closed lost" =
  // closed lost only — the two outcomes are never shown mixed together.
  const data = useMemo(() => {
    if (!allData) return allData
    if (tablePage === "quoted") return { ...allData, rows: allData.rows.filter((r) => r.dealStatus === "open") }
    if (tablePage === "closed_won")
      return { ...allData, rows: allData.rows.filter((r) => r.dealStatus === "closed_won") }
    return { ...allData, rows: allData.rows.filter((r) => r.dealStatus === "closed_lost") }
  }, [allData, tablePage])

  const charts = useMemo(() => buildDistributionCharts(allData?.rows ?? []), [allData])

  const exportCsv = () => {
    if (!data) return
    const header = [
      "First",
      "Last",
      "Email",
      "Phone",
      "Deal Stage",
      "Address",
      "City",
      "State",
      "Zip",
      "Deal Amount",
      "Quoted At",
      "Days Quoted",
      "Closed Won",
      "Closed At",
      "Years In Home",
      "Year Built",
      "Estimated Value",
      "Equity Percent",
      "MLS Status",
      "Owner Occupied",
      "Owner Age",
      "Owner Marital Status",
      "Owner Occupation",
      "Owner Email",
      "Owner Phone",
      "Owner DNC",
      "Area Median Income",
    ]
    const lines = [header.join(",")]
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`
    for (const r of data.rows) {
      const p = mergedEnrichment(r).property
      const o = mergedEnrichment(r).owner
      lines.push(
        [
          esc(r.firstName),
          esc(r.lastName),
          esc(r.email),
          esc(r.phone),
          esc(r.dealStageLabel),
          esc(r.address),
          esc(r.city),
          esc(r.state),
          esc(r.zip),
          r.dealAmount,
          esc(r.quotedAt),
          r.dealStatus === "open" ? daysQuoted(r.quotedAt, r.closedAt) ?? "" : "",
          r.closedWon,
          esc(r.closedAt),
          yearsInHome(p?.lastSaleDate ?? null) ?? "",
          p?.yearBuilt ?? "",
          p?.estimatedValue ?? "",
          p?.equityPercent ?? "",
          esc(p?.mlsStatus),
          p?.ownerOccupied ?? "",
          o?.age ?? "",
          esc(o?.maritalStatus),
          esc(o?.occupation),
          esc(o?.emails?.[0]),
          esc(o?.phones?.[0]),
          o?.dnc ?? "",
          p?.medianIncomeArea ?? "",
        ].join(","),
      )
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `customer-analysis-${tablePage}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Customer Analysis"
        description="Quoted customers enriched with property and owner-demographic data from RealEstateAPI"
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Table view</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {TABLE_PAGES.map((s) => (
              <Pill key={s.key} active={tablePage === s.key} onClick={() => setTablePage(s.key)}>
                {s.label}
              </Pill>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => report.refetch()} disabled={report.isFetching} className="gap-1.5">
              {report.isFetching ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {report.isFetching ? "Loading…" : "Refresh"}
            </Button>
            {data ? (
              <Button variant="outline" onClick={exportCsv} className="gap-1.5 bg-transparent">
                <Download className="size-4" />
                Export CSV
              </Button>
            ) : null}
          </div>
          {data && !data.reapiConfigured ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              RealEstateAPI is not configured on this deployment (missing REALESTATEAPI_KEY) — showing HubSpot data
              only, without property or owner enrichment.
            </p>
          ) : null}
          {data ? (
            <p className="text-xs text-muted-foreground">
              Individual income is not available from RealEstateAPI — the Area Median Income column reflects the
              HUD-area median for the property&apos;s ZIP, not the specific owner&apos;s income.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {connected && allData && !report.isFetching ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Year built distribution</CardTitle>
              <CardDescription>Home age at time of quote, grouped by the year the deal was quoted</CardDescription>
            </CardHeader>
            <CardContent>
              {charts.yearBuiltByYear.every((b) => CHART_YEARS.every((y) => (b[`y${y}`] as number) === 0)) ? (
                <EmptyChartNote hasEnrichment={charts.hasEnrichment} />
              ) : (
                <ChartContainer config={yearGroupedChartConfig} className="h-[240px] w-full">
                  <BarChart data={charts.yearBuiltByYear}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} />
                    <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    {CHART_YEARS.map((y) => (
                      <Bar key={y} dataKey={`y${y}`} fill={`var(--color-y${y})`} radius={4} />
                    ))}
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Owner age distribution</CardTitle>
              <CardDescription>Skip-traced owner age, grouped by the year the deal was quoted</CardDescription>
            </CardHeader>
            <CardContent>
              {charts.ownerAgeDistribution.every((b) => CHART_YEARS.every((y) => (b[`y${y}`] as number) === 0)) ? (
                <EmptyChartNote hasEnrichment={charts.hasEnrichment} />
              ) : (
                <ChartContainer config={yearGroupedChartConfig} className="h-[240px] w-full">
                  <BarChart data={charts.ownerAgeDistribution}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} />
                    <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    {CHART_YEARS.map((y) => (
                      <Bar key={y} dataKey={`y${y}`} fill={`var(--color-y${y})`} radius={4} />
                    ))}
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Home value distribution</CardTitle>
              <CardDescription>Estimated property value, grouped by the year the deal was quoted</CardDescription>
            </CardHeader>
            <CardContent>
              {charts.homeValueDistribution.every((b) => CHART_YEARS.every((y) => (b[`y${y}`] as number) === 0)) ? (
                <EmptyChartNote hasEnrichment={charts.hasEnrichment} />
              ) : (
                <ChartContainer config={yearGroupedChartConfig} className="h-[240px] w-full">
                  <BarChart data={charts.homeValueDistribution}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} />
                    <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    {CHART_YEARS.map((y) => (
                      <Bar key={y} dataKey={`y${y}`} fill={`var(--color-y${y})`} radius={4} />
                    ))}
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Closed-won vs. closed-lost</CardTitle>
              <CardDescription>
                {formatNumber(charts.wonCount)} won · {formatNumber(charts.lostCount)} lost — median/average by metric
              </CardDescription>
            </CardHeader>
            <CardContent>
              {charts.wonCount === 0 && charts.lostCount === 0 ? (
                <EmptyChartNote hasEnrichment={charts.hasEnrichment} />
              ) : (
                <ChartContainer config={wonLostConfig} className="h-[240px] w-full">
                  <BarChart data={charts.wonLostComparison} layout="vertical" margin={{ left: 24 }}>
                    <CartesianGrid horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="metric"
                      tickLine={false}
                      axisLine={false}
                      width={130}
                      tick={{ fontSize: 11 }}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="closedWon" fill="var(--color-closedWon)" radius={4} />
                    <Bar dataKey="closedLost" fill="var(--color-closedLost)" radius={4} />
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>
        </div>
      ) : connected && report.isFetching ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <Skeleton className="h-[240px] w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {!connected ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Connect HubSpot in Settings to run this report.
          </CardContent>
        </Card>
      ) : report.isError ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            {(report.error as Error)?.message || "Failed to load customer analysis."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {tablePage === "quoted"
                ? "Quoted customers"
                : tablePage === "closed_won"
                  ? "Closed customers"
                  : "Closed lost customers"}
              {report.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
            </CardTitle>
            {data ? (
              <span className="text-sm text-muted-foreground">
                {formatNumber(data.total)} customers
                {data.missingAddress ? ` · ${formatNumber(data.missingAddress)} missing address` : ""}
              </span>
            ) : null}
          </CardHeader>
          <CardContent>
            {report.isFetching || !data ? (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : data.rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No customers found for this view.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="sticky left-0 z-10 min-w-40 bg-card py-2 pr-3 text-left font-medium">Customer</th>
                      <th className="min-w-32 py-2 pr-3 text-left font-medium text-muted-foreground">Deal stage</th>
                      <th className="min-w-52 py-2 pr-3 text-left font-medium">Address</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Deal amount</th>
                      <th className="py-2 pr-3 text-left font-medium text-muted-foreground">Quoted</th>
                      {tablePage === "quoted" ? (
                        <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">
                          Days quoted
                        </th>
                      ) : null}
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">
                        Years in home
                      </th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Year built</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Est. value</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Equity %</th>
                      <th className="py-2 pr-3 text-left font-medium text-muted-foreground">MLS status</th>
                      <th className="py-2 pr-3 text-center font-medium text-muted-foreground">Owner-occ</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">Owner age</th>
                      <th className="py-2 pr-3 text-left font-medium text-muted-foreground">Marital / Occupation</th>
                      <th className="py-2 pr-3 text-left font-medium text-muted-foreground">Owner contact</th>
                      <th className="py-2 pr-3 text-right font-medium tabular-nums text-muted-foreground">
                        Area med. income
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => {
                      const p = mergedEnrichment(r).property
                      const o = mergedEnrichment(r).owner
                      const hasEnrichError = mergedEnrichment(r).propertyError || mergedEnrichment(r).skipTraceError
                      return (
                        <tr key={r.dealId} className="border-b border-border/50 align-top">
                          <td className="sticky left-0 z-10 bg-card py-2 pr-3">
                            <div className="flex items-center gap-1.5 font-medium">
                              <User2 className="size-3.5 text-muted-foreground" />
                              {[r.firstName, r.lastName].filter(Boolean).join(" ") || "Unknown"}
                            </div>
                            <div className="text-xs text-muted-foreground">{r.email || r.phone || "—"}</div>
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">{r.dealStageLabel || "–"}</td>
                          <td className="py-2 pr-3">
                            {r.address ? (
                              <div className="flex items-start gap-1.5">
                                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                <span>
                                  {r.address}
                                  <br />
                                  <span className="text-xs text-muted-foreground">
                                    {r.city}, {r.state} {r.zip}
                                  </span>
                                </span>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground/60">No address on file</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(r.dealAmount)}</td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {fmtDate(r.quotedAt)}
                            {r.dealStatus === "closed_won" ? (
                              <div className="text-emerald-600 dark:text-emerald-400">Won {fmtDate(r.closedAt)}</div>
                            ) : r.dealStatus === "closed_lost" ? (
                              <div className="text-destructive">Lost {fmtDate(r.closedAt)}</div>
                            ) : null}
                          </td>
                          {tablePage === "quoted" ? (
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {daysQuoted(r.quotedAt, r.closedAt) ?? "–"}
                            </td>
                          ) : null}
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {fmtYearsInHome(yearsInHome(p?.lastSaleDate ?? null))}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{p?.yearBuilt ?? "–"}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {p?.estimatedValue ? formatCurrency(p.estimatedValue) : "–"}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {p?.equityPercent != null ? `${Math.round(p.equityPercent)}%` : "–"}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {p?.mlsStatus || (p?.mlsListingPrice ? formatCurrency(p.mlsListingPrice) : "–")}
                          </td>
                          <td className="py-2 pr-3 text-center">
                            {p?.ownerOccupied == null ? (
                              "–"
                            ) : (
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
                                  p.ownerOccupied
                                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                <Home className="size-3" />
                                {p.ownerOccupied ? "Yes" : "No"}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{o?.age ?? "–"}</td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {[o?.maritalStatus, o?.occupation].filter(Boolean).join(" · ") ||
                              (hasEnrichError ? "No match" : "–")}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {o?.emails?.[0] || o?.phones?.[0] ? (
                              <>
                                {o?.emails?.[0] && <div>{o.emails[0]}</div>}
                                {o?.phones?.[0] && (
                                  <div className={cn(o.dnc ? "text-amber-600 dark:text-amber-400" : undefined)}>
                                    {o.phones[0]}
                                    {o.dnc ? " (DNC)" : ""}
                                  </div>
                                )}
                              </>
                            ) : (
                              "–"
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {p?.medianIncomeArea ? formatCurrency(p.medianIncomeArea) : "–"}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
