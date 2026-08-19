"use client"

import { RANGE_OPTIONS, type RangeKey, type CustomRange } from "@/lib/date-ranges"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"

// Shared date-range control used across all reporting pages. Renders the preset
// Select plus, when "Custom range…" is chosen, two native date inputs for an
// arbitrary from/to window.
export function DateRangeSelect({
  value,
  onValueChange,
  custom,
  onCustomChange,
  triggerClassName = "w-44",
}: {
  value: RangeKey
  onValueChange: (key: RangeKey) => void
  custom: CustomRange
  onCustomChange: (c: CustomRange) => void
  triggerClassName?: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={value} onValueChange={(v) => v && onValueChange(v as RangeKey)}>
        <SelectTrigger className={triggerClassName} aria-label="Date range">
          <SelectValue>{(val) => RANGE_OPTIONS.find((o) => o.key === val)?.label ?? String(val)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {RANGE_OPTIONS.map((o) => (
            <SelectItem key={o.key} value={o.key}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value === "custom" ? (
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="Start date"
            value={custom.from}
            max={custom.to || undefined}
            onChange={(e) => onCustomChange({ ...custom, from: e.target.value })}
            className="w-[150px]"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="End date"
            value={custom.to}
            min={custom.from || undefined}
            onChange={(e) => onCustomChange({ ...custom, to: e.target.value })}
            className="w-[150px]"
          />
        </div>
      ) : null}
    </div>
  )
}
