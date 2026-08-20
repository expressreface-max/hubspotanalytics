import { Loader2, type LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

export function KpiCard({
  label,
  value,
  icon: Icon,
  hint,
  loading,
}: {
  label: string
  value: string | number
  icon?: LucideIcon
  hint?: string
  loading?: boolean
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-1">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {loading ? (
            <span className="flex h-7 items-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
            </span>
          ) : (
            <span className="num animate-count text-2xl font-bold">{value}</span>
          )}
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
        {Icon ? (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-5" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
