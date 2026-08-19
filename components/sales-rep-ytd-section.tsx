"use client"

import { Fragment, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { formatCurrency, formatNumber } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

// Deal-owner rollup (copied from the Funnel page's "By Sales Rep" card), scoped
// to this calendar year. Prop-driven from a nightly snapshot — no live query.
export type RepDeal = {
  id: string
  name: string
  amount: number
  appt: boolean
  quoted: boolean
  won: boolean
  territory: string
}
export type RepRow = {
  name: string
  apptSet: number
  quoted: number
  closedWon: number
  revenue: number
  deals?: RepDeal[]
}
export type SalesRepYtdData = {
  byRep: RepRow[]
  periodLabel?: string
  error?: string
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

function repCloseRate(r: { closedWon: number; apptSet: number }): number {
  return r.apptSet > 0 ? r.closedWon / r.apptSet : 0
}
function repWonPerQuoted(r: { closedWon: number; quoted: number }): number {
  return r.quoted > 0 ? r.closedWon / r.quoted : 0
}
function repAvgSale(r: { revenue: number; closedWon: number }): number {
  return r.closedWon > 0 ? r.revenue / r.closedWon : 0
}
function repMetricValue(r: RepRow, key: RepMetricKey): number {
  if (key === "closeRate") return repCloseRate(r)
  if (key === "wonPerQuoted") return repWonPerQuoted(r)
  if (key === "avgSale") return repAvgSale(r)
  return r[key]
}

function RepDealDetail({ deals }: { deals: RepDeal[] }) {
  const groups = [
    { key: "won", label: "Closed won", dotClass: "bg-chart-3", items: deals.filter((d) => d.won) },
    { key: "quoted", label: "Quoted (open)", dotClass: "bg-primary", items: deals.filter((d) => d.quoted && !d.won) },
    {
      key: "appt",
      label: "Appointment (not quoted)",
      dotClass: "bg-muted-foreground",
      items: deals.filter((d) => d.appt && !d.quoted),
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
            {g.items.map((d) => (
              <li key={d.id} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="block truncate" title={d.name}>
                    {d.name}
                  </span>
                  {d.territory && d.territory !== "Unmapped" && (
                    <span className="block truncate text-[0.7rem] text-muted-foreground" title={d.territory}>
                      {d.territory}
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {d.amount > 0 ? formatCurrency(d.amount) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function SalesRepYtdSection({ data, loading }: { data: SalesRepYtdData | null; loading: boolean }) {
  const [sortBy, setSortBy] = useState<RepMetricKey>("revenue")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const rows = data?.byRep ?? []

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
        <CardTitle className="text-base">Sales Rep YTD</CardTitle>
        <p className="text-sm text-muted-foreground">
          Appointments, quoted, closed won, won/quoted %, close %, revenue &amp; avg sale by HubSpot deal owner for
          {data?.periodLabel ? ` ${data.periodLabel.toLowerCase()}` : " the year to date"} · tap a column to rank ·
          tap a rep to see their deals
        </p>
      </CardHeader>
      <CardContent>
        {data?.error ? (
          <p className="py-6 text-center text-sm text-destructive">{data.error}</p>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No deal-owner data for this year.</p>
        ) : (
          <div className="max-h-[32rem] overflow-y-auto">
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
