export type RangeKey =
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "mtd"
  | "lastMonth"
  | "last30"
  | "last60"
  | "last90"
  | "ytd"
  | "lastYearYtd"
  | "last12"
  | "thisYear"
  | "lastYear"
  | "since2023"
  | "custom"

export type CustomRange = { from: string; to: string } // YYYY-MM-DD (local calendar days)

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "yesterday", label: "Yesterday" },
  { key: "thisWeek", label: "This week" },
  { key: "lastWeek", label: "Last week" },
  { key: "mtd", label: "Month to date" },
  { key: "lastMonth", label: "Last month" },
  { key: "last30", label: "Last 30 days" },
  { key: "last60", label: "Last 60 days" },
  { key: "last90", label: "Last 90 days" },
  { key: "ytd", label: "Year to date" },
  { key: "lastYearYtd", label: "Last year same YTD" },
  { key: "last12", label: "Last 12 months" },
  { key: "thisYear", label: "This year" },
  { key: "lastYear", label: "Last year" },
  { key: "since2023", label: "Since 2023" },
  { key: "custom", label: "Custom range…" },
]

// Format a Date as a YYYY-MM-DD string suitable for a native <input type="date">.
export function toDateInput(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

// Sensible default custom range (trailing 30 days) used to seed the picker.
export function defaultCustomRange(): CustomRange {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
  return { from: toDateInput(from), to: toDateInput(now) }
}

export function resolveRange(key: RangeKey, custom?: CustomRange): { dateFrom: string; dateTo: string } {
  const now = new Date()
  const to = now
  let from: Date

  // Start of today (local), used as a boundary for day/week ranges.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // Monday-based start of the current week.
  const startOfThisWeek = new Date(startOfToday)
  const dayIdx = (startOfToday.getDay() + 6) % 7 // 0 = Monday
  startOfThisWeek.setDate(startOfToday.getDate() - dayIdx)

  switch (key) {
    case "yesterday": {
      const start = new Date(startOfToday)
      start.setDate(start.getDate() - 1)
      const end = new Date(startOfToday.getTime() - 1)
      return { dateFrom: start.toISOString(), dateTo: end.toISOString() }
    }
    case "thisWeek":
      from = startOfThisWeek
      break
    case "lastWeek": {
      const start = new Date(startOfThisWeek)
      start.setDate(start.getDate() - 7)
      const end = new Date(startOfThisWeek.getTime() - 1)
      return { dateFrom: start.toISOString(), dateTo: end.toISOString() }
    }
    case "lastMonth": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 1)
      end.setMilliseconds(-1)
      return { dateFrom: start.toISOString(), dateTo: end.toISOString() }
    }
    case "mtd":
      from = new Date(now.getFullYear(), now.getMonth(), 1)
      break
    case "last30":
      from = new Date(startOfToday)
      from.setDate(from.getDate() - 30)
      break
    case "last60":
      from = new Date(startOfToday)
      from.setDate(from.getDate() - 60)
      break
    case "last90":
      from = new Date(startOfToday)
      from.setDate(from.getDate() - 90)
      break
    case "ytd":
    case "thisYear":
      from = new Date(now.getFullYear(), 0, 1)
      break
    case "lastYearYtd":
      // Same year-to-date window but for last year: Jan 1 (year-1) through the
      // same month/day as today (year-1). Lets you compare YTD vs prior-year YTD.
      return {
        dateFrom: new Date(now.getFullYear() - 1, 0, 1).toISOString(),
        dateTo: new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString(),
      }
    case "lastYear":
      return {
        dateFrom: new Date(now.getFullYear() - 1, 0, 1).toISOString(),
        dateTo: new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59).toISOString(),
      }
    case "last12":
      // True trailing 12-month window (e.g. May 31 2025 -> May 31 2026),
      // NOT snapped to the 1st of the month. Snapping pulled in extra weeks
      // of data and inflated the totals vs. HubSpot's "Last 12 months".
      from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
      break
    case "since2023":
      from = new Date(2023, 0, 1)
      break
    case "custom": {
      // Parse YYYY-MM-DD as local calendar days: from = start of day, to = end of day.
      const parse = (s: string | undefined): [number, number, number] | null => {
        if (!s) return null
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
        if (!m) return null
        return [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
      }
      const fromParts = parse(custom?.from)
      const toParts = parse(custom?.to)
      const start = fromParts
        ? new Date(fromParts[0], fromParts[1], fromParts[2])
        : new Date(startOfToday.getFullYear(), startOfToday.getMonth(), startOfToday.getDate() - 30)
      const end = toParts ? new Date(toParts[0], toParts[1], toParts[2], 23, 59, 59, 999) : now
      // Guard against an inverted range (to before from).
      if (end.getTime() < start.getTime()) {
        return { dateFrom: end.toISOString(), dateTo: start.toISOString() }
      }
      return { dateFrom: start.toISOString(), dateTo: end.toISOString() }
    }
    default:
      from = new Date(now.getFullYear(), 0, 1)
  }

  return { dateFrom: from.toISOString(), dateTo: to.toISOString() }
}
