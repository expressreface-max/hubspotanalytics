"use client"

import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts"
import { apiGet, apiPost } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { ADVERTISING_DATA, AD_CHANNELS, type AdChannelKey, type AdSpendRow } from "@/data/advertising-data"

type Status = { configured: boolean }
type MonthlyRevenue = { month: string; revenue: number; jobs: number }
type Summary = { monthlyRevenue?: MonthlyRevenue[] }

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
const usdK = (n: number) => `$${Math.round(n / 1000)}k`

function monthShort(m: string) {
  const [y, mo] = m.split("-")
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '")
}
function monthLong(m: string) {
  const [y, mo] = m.split("-")
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })
}

const PERIODS = [
  { key: "3", label: "Last 3 months", months: 3 },
  { key: "6", label: "Last 6 months", months: 6 },
  { key: "12", label: "Last 12 months", months: 12 },
  { key: "24", label: "Last 24 months", months: 24 },
  { key: "all", label: "Since Jan 2023", months: Infinity },
] as const

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "television", label: "Television" },
  { key: "digital", label: "Digital" },
  { key: "print", label: "Print" },
] as const

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

export function AdvertisingView() {
  const [period, setPeriod] = useState<string>("12")
  const [category, setCategory] = useState<string>("all")

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<Status>("/api/hs/config/status"),
  })
  const connected = status.data?.configured

  const revenueData = useQuery({
    queryKey: ["monthly-revenue", "advertising"],
    queryFn: () => apiGet<Summary>("/api/hs/analytics/monthly-revenue?from=2023-01-01"),
    enabled: !!connected,
  })

  // Advertising spend rows from the database (falls back to the static seed).
  const adSpend = useQuery({
    queryKey: ["advertising-spend"],
    queryFn: () => apiGet<{ rows: AdSpendRow[] }>("/api/advertising"),
  })
  const adRows = adSpend.data?.rows ?? ADVERTISING_DATA

  const revByMonth = useMemo(() => {
    const map: Record<string, { revenue: number; jobs: number }> = {}
    for (const r of revenueData.data?.monthlyRevenue ?? []) map[r.month] = { revenue: r.revenue, jobs: r.jobs }
    return map
  }, [revenueData.data])

  // Master series (ascending) combining ad spend with HubSpot revenue + jobs.
  const series = useMemo(
    () =>
      adRows.map((r) => {
        const spend = r.digital + r.television + r.print
        const rv = revByMonth[r.month] ?? { revenue: 0, jobs: 0 }
        return { ...r, spend, revenue: rv.revenue, jobs: rv.jobs }
      }),
    [adRows, revByMonth],
  )

  const channelKey: AdChannelKey | null = category === "all" ? null : (category as AdChannelKey)
  const spendOf = (row: (typeof series)[number]) => (channelKey ? row[channelKey] : row.spend)

  // Period subset (newest at end).
  const periodRows = useMemo(() => {
    const months = PERIODS.find((p) => p.key === period)?.months ?? 12
    return months === Infinity ? series : series.slice(-months)
  }, [series, period])

  const totals = useMemo(() => {
    const n = periodRows.length || 1
    const spend = periodRows.reduce((s, r) => s + r.spend, 0)
    const revenue = periodRows.reduce((s, r) => s + r.revenue, 0)
    const jobs = periodRows.reduce((s, r) => s + r.jobs, 0)
    const byChannel = AD_CHANNELS.reduce(
      (acc, c) => ({ ...acc, [c.key]: periodRows.reduce((s, r) => s + r[c.key], 0) }),
      {} as Record<AdChannelKey, number>,
    )
    return {
      spend,
      revenue,
      jobs,
      months: periodRows.length,
      monthlyAvg: spend / n,
      spendPerJob: jobs > 0 ? spend / jobs : 0,
      pctOfRevenue: revenue > 0 ? (spend / revenue) * 100 : 0,
      byChannel,
    }
  }, [periodRows])

  // 13-month efficiency series. staggered shifts the ad-spend window back 1 month.
  const buildEfficiency = (staggered: boolean) => {
    const out: {
      label: string
      avgRevenue: number
      adSpendPerMo: number
      spendPerJob: number
      pctOfRevenue: number
    }[] = []
    const start = Math.max(2 + (staggered ? 1 : 0), series.length - 13)
    for (let i = start; i < series.length; i++) {
      const revWin = series.slice(i - 2, i + 1)
      const adStart = staggered ? i - 3 : i - 2
      const adEnd = staggered ? i - 1 : i
      const adWin = series.slice(adStart, adEnd + 1)
      const adSpendSum = adWin.reduce((s, r) => s + spendOf(r), 0)
      const revSum = revWin.reduce((s, r) => s + r.revenue, 0)
      const jobsSum = revWin.reduce((s, r) => s + r.jobs, 0)
      out.push({
        label: monthShort(series[i].month),
        avgRevenue: revSum / 3,
        adSpendPerMo: adSpendSum / 3,
        spendPerJob: jobsSum > 0 ? adSpendSum / jobsSum : 0,
        pctOfRevenue: revSum > 0 ? (adSpendSum / revSum) * 100 : 0,
      })
    }
    return out
  }
  const rolling = useMemo(() => buildEfficiency(false), [series, channelKey])
  const staggeredSeries = useMemo(() => buildEfficiency(true), [series, channelKey])

  const effConfig = {
    avgRevenue: { label: "Avg Monthly Revenue", color: "var(--chart-3)" },
    spendPerJob: { label: "Spend / Job", color: "var(--chart-1)" },
    pctOfRevenue: { label: "% of Revenue", color: "var(--chart-2)" },
    adSpendPerMo: { label: "Ad Spend / Mo", color: "var(--chart-5)" },
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Advertising" description="Monthly advertising expense by category · Kitchens Now P&L">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Period</span>
          {PERIODS.map((p) => (
            <Pill key={p.key} active={period === p.key} onClick={() => setPeriod(p.key)}>
              {p.label}
            </Pill>
          ))}
          <AddMonthDialog existingMonths={adRows.map((r) => r.month)} />
        </div>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Category</span>
        {CATEGORIES.map((c) => (
          <Pill key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
            {c.label}
          </Pill>
        ))}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total spend</div>
          <div className="num mt-1 text-2xl font-bold">{usd(totals.spend)}</div>
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">monthly avg</span>
            <span className="num text-right">{usd(totals.monthlyAvg)}</span>
            <span className="text-muted-foreground">months</span>
            <span className="num text-right">{totals.months}</span>
            <span className="text-muted-foreground">spend / job</span>
            <span className="num text-right">{connected ? usd(totals.spendPerJob) : "—"}</span>
            <span className="text-muted-foreground">% of revenue</span>
            <span className="num text-right">{connected ? `${totals.pctOfRevenue.toFixed(1)}%` : "—"}</span>
            <span className="text-muted-foreground">won jobs</span>
            <span className="num text-right">{connected ? totals.jobs : "—"}</span>
          </div>
        </Card>

        {AD_CHANNELS.map((c) => {
          const value = totals.byChannel[c.key] ?? 0
          const pct = totals.spend > 0 ? (value / totals.spend) * 100 : 0
          return (
            <Card key={c.key} className={cn("p-5", channelKey === c.key && "ring-2 ring-primary")}>
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{c.label}</span>
              </div>
              <div className="num mt-1 text-2xl font-bold">{usd(value)}</div>
              <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <span className="text-muted-foreground">% of total</span>
                <span className="num text-right">{pct.toFixed(0)}%</span>
                <span className="text-muted-foreground">monthly avg</span>
                <span className="num text-right">{usd(totals.months > 0 ? value / totals.months : 0)}</span>
              </div>
            </Card>
          )
        })}
      </div>

      {/* Efficiency charts */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <EfficiencyChart
          title="Ad Efficiency — Rolling 3-Month Lookback"
          subtitle="13-month series · ad spend and revenue from the same 3-month window"
          data={rolling}
          config={effConfig}
        />
        <EfficiencyChart
          title="Ad Efficiency Rolling 3 Months Staggered Lookback"
          subtitle="13-month series · revenue [M-2→M] · ad spend [M-3→M-1] (one month earlier)"
          data={staggeredSeries}
          config={effConfig}
        />
      </div>

      {/* Monthly cards (newest first) */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[...periodRows].reverse().map((row) => {
          const breakdown = AD_CHANNELS.map((c) => ({ ...c, value: row[c.key] })).sort((a, b) => b.value - a.value)
          return (
            <Card key={row.month} className="p-5">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{monthLong(row.month)}</span>
                <span className="num font-bold">{usd(row.spend)}</span>
              </div>
              <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                {AD_CHANNELS.map((c) => {
                  const w = row.spend > 0 ? (row[c.key] / row.spend) * 100 : 0
                  return <div key={c.key} style={{ width: `${w}%`, backgroundColor: c.color }} />
                })}
              </div>
              <div className="mt-4 flex flex-col gap-2 text-sm">
                {breakdown.map((b) => {
                  const pct = row.spend > 0 ? (b.value / row.spend) * 100 : 0
                  return (
                    <div key={b.key} className="flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ backgroundColor: b.color }} />
                      <span className="text-muted-foreground">{b.label}</span>
                      <span className="num ml-auto text-muted-foreground">{pct.toFixed(0)}%</span>
                      <span className="num w-20 text-right font-medium">{usd(b.value)}</span>
                    </div>
                  )
                })}
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

function AddMonthDialog({ existingMonths }: { existingMonths: string[] }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [mm, setMm] = useState("")
  const [yyyy, setYyyy] = useState("")
  const [digital, setDigital] = useState("")
  const [television, setTelevision] = useState("")
  const [print, setPrint] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Year options: a few years back through next year.
  const currentYear = new Date().getFullYear()
  const yearOptions = Array.from({ length: 6 }, (_, i) => String(currentYear + 1 - i))

  const month = mm && yyyy ? `${yyyy}-${mm}` : ""
  const exists = month !== "" && existingMonths.includes(month)

  const reset = () => {
    setMm("")
    setYyyy("")
    setDigital("")
    setTelevision("")
    setPrint("")
    setError(null)
  }

  const submit = async () => {
    setError(null)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      setError("Please choose a month and year.")
      return
    }
    setSaving(true)
    try {
      await apiPost("/api/advertising", {
        month,
        digital: Number(digital) || 0,
        television: Number(television) || 0,
        print: Number(print) || 0,
      })
      await queryClient.invalidateQueries({ queryKey: ["advertising-spend"] })
      reset()
      setOpen(false)
    } catch (err) {
      setError((err as Error).message || "Failed to save.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="size-4" />
          Add month
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add advertising month</DialogTitle>
          <DialogDescription>
            Enter monthly spend by category. Saving an existing month updates its values.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label>Month</Label>
            <div className="grid grid-cols-2 gap-3">
              <select
                aria-label="Month"
                value={mm}
                onChange={(e) => setMm(e.target.value)}
                className={cn(
                  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm outline-none",
                  "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
                  mm === "" && "text-muted-foreground",
                )}
              >
                <option value="" disabled>
                  Month
                </option>
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={String(i + 1).padStart(2, "0")} className="text-foreground">
                    {name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Year"
                value={yyyy}
                onChange={(e) => setYyyy(e.target.value)}
                className={cn(
                  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm outline-none",
                  "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
                  yyyy === "" && "text-muted-foreground",
                )}
              >
                <option value="" disabled>
                  Year
                </option>
                {yearOptions.map((y) => (
                  <option key={y} value={y} className="text-foreground">
                    {y}
                  </option>
                ))}
              </select>
            </div>
            {exists ? (
              <p className="text-xs text-muted-foreground">This month already exists — its values will be updated.</p>
            ) : null}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ad-digital">Digital</Label>
              <Input id="ad-digital" type="number" min={0} inputMode="numeric" placeholder="0" value={digital} onChange={(e) => setDigital(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ad-television">Television</Label>
              <Input id="ad-television" type="number" min={0} inputMode="numeric" placeholder="0" value={television} onChange={(e) => setTelevision(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ad-print">Print</Label>
              <Input id="ad-print" type="number" min={0} inputMode="numeric" placeholder="0" value={print} onChange={(e) => setPrint(e.target.value)} />
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !month}>
            {saving ? "Saving…" : exists ? "Update month" : "Add month"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EfficiencyChart({
  title,
  subtitle,
  data,
  config,
}: {
  title: string
  subtitle: string
  data: { label: string; avgRevenue: number; adSpendPerMo: number; spendPerJob: number; pctOfRevenue: number }[]
  config: Record<string, { label: string; color: string }>
}) {
  return (
    <Card className="p-5">
      <div className="font-semibold">{title}</div>
      <div className="text-sm text-muted-foreground">{subtitle}</div>
      <ChartContainer config={config} className="mt-4 h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} interval={1} />
            <YAxis yAxisId="rev" tickFormatter={usdK} tickLine={false} axisLine={false} width={48} fontSize={11} domain={[0, "auto"]} />
            <YAxis
              yAxisId="spend"
              orientation="right"
              tickFormatter={usdK}
              tickLine={false}
              axisLine={false}
              width={48}
              fontSize={11}
              stroke="var(--chart-1)"
              domain={[0, "auto"]}
            />
            <YAxis yAxisId="pct" hide domain={[0, 35]} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(v, name) =>
                    name === "pctOfRevenue" ? `${Number(v).toFixed(1)}%` : usd(Number(v))
                  }
                />
              }
            />
            <Line yAxisId="rev" type="monotone" dataKey="avgRevenue" stroke="var(--color-avgRevenue)" strokeWidth={2.5} dot={false} />
            <Line yAxisId="spend" type="monotone" dataKey="adSpendPerMo" stroke="var(--color-adSpendPerMo)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
            <Line yAxisId="pct" type="monotone" dataKey="pctOfRevenue" stroke="var(--color-pctOfRevenue)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
            <Line yAxisId="spend" type="monotone" dataKey="spendPerJob" stroke="var(--color-spendPerJob)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
        {Object.entries(config).map(([key, c]) => (
          <span key={key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4"
              style={{
                backgroundColor: c.color,
                ...(key === "adSpendPerMo" || key === "pctOfRevenue"
                  ? { backgroundImage: `repeating-linear-gradient(90deg, ${c.color} 0 4px, transparent 4px 7px)`, backgroundColor: "transparent" }
                  : {}),
              }}
            />
            {c.label}
          </span>
        ))}
      </div>
    </Card>
  )
}
