"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Search, Loader2 } from "lucide-react"
import { apiGet, apiPost } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type Status = { configured: boolean }
type Pipeline = {
  id: string
  label: string
  stages: { id: string; label: string; displayOrder: number }[]
}
type Deal = {
  id: string
  name: string
  amount: number
  stageId: string
  stageLabel: string
  pipelineId: string
  ownerId: string | null
  territory: string | null
  closeDate: string | null
  createDate: string | null
}
type DealResult = { deals: Deal[]; total: number }

const currency = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n)

function fmtDate(s: string | null) {
  if (!s) return "—"
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function DealsView() {
  const [search, setSearch] = useState("")
  const [pipelineId, setPipelineId] = useState<string>("all")

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<Status>("/api/hs/config/status"),
  })
  const connected = status.data?.configured

  const pipelines = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiGet<{ pipelines: Pipeline[] }>("/api/hs/pipelines"),
    enabled: !!connected,
  })

  const deals = useQuery({
    queryKey: ["deals", pipelineId],
    queryFn: () =>
      apiPost<DealResult>("/api/hs/deals/search", {
        pipelineId: pipelineId === "all" ? undefined : pipelineId,
        limit: 100,
      }),
    enabled: !!connected,
  })

  const filtered = useMemo(() => {
    const list = deals.data?.deals ?? []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        (d.territory ?? "").toLowerCase().includes(q) ||
        d.stageLabel.toLowerCase().includes(q),
    )
  }, [deals.data, search])

  if (status.isLoading) {
    return <Skeleton className="h-64 w-full" />
  }

  if (!connected) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Deals" description="Browse and filter your HubSpot deals." />
        <NotConnected />
      </div>
    )
  }

  const totalValue = filtered.reduce((sum, d) => sum + d.amount, 0)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Deals"
        description="Browse, search, and filter deals synced from HubSpot CRM."
      />

      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="flex flex-col gap-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                All deals
                {deals.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {deals.isLoading
                  ? "Loading deals..."
                  : `${filtered.length} deals · ${currency(totalValue)} total value`}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Pipeline</Label>
                <Select value={pipelineId} onValueChange={(v) => setPipelineId(v ?? "all")}>
                  <SelectTrigger className="w-full sm:w-52">
                    <SelectValue placeholder="All pipelines" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All pipelines</SelectItem>
                    {pipelines.data?.pipelines.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Search</Label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    placeholder="Deal, territory, stage..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full pl-8 sm:w-64"
                  />
                </div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {deals.isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : deals.isError ? (
            <p className="py-8 text-center text-sm text-destructive">
              {(deals.error as Error).message}
            </p>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Loader2 className="hidden" />
              <p className="text-sm text-muted-foreground">No deals match your filters.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Deal</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Territory</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Close date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">{d.name || "Untitled deal"}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-normal">
                          {d.stageLabel}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {d.territory || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {currency(d.amount)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(d.closeDate)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
