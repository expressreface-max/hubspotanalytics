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

export type CustomRange = { from: string; to: string } // YYYY-MM-DD (Pacific calendar days)

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

export const REPORTING_TIME_ZONE = "America/Los_Angeles"

const pacificFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORTING_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
})

function pacificParts(date: Date) {
  const parts = Object.fromEntries(pacificFormatter.formatToParts(date).map(p => [p.type, p.value]))
  return {
    year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  }
}

// UTC Dates below represent calendar labels only, not actual midnight instants.
// Calendar arithmetic must not depend on the server/browser's local timezone.
function calendarDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day))
}
function shiftDay(day: Date, days: number): Date {
  return calendarDay(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + days)
}
function dayLabel(day: Date): string {
  return day.toISOString().slice(0, 10)
}
function pacificDay(date: Date): Date {
  const p = pacificParts(date)
  return calendarDay(p.year, p.month, p.day)
}

// Resolve each midnight separately: a Pacific day can contain 23, 24, or 25
// hours. Never subtract 24 hours or hard-code a PST/PDT offset.
function midnight(day: Date): Date {
  const target = day.getTime()
  let instant = target
  for (let i = 0; i < 4; i++) {
    const p = pacificParts(new Date(instant))
    const represented = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second)
    const correction = target - represented
    if (correction === 0) return new Date(instant)
    instant += correction
  }
  throw new Error("Unable to resolve Pacific midnight")
}

export function toDateInput(date: Date): string {
  return dayLabel(pacificDay(date))
}

export function defaultCustomRange(now = new Date()): CustomRange {
  const today = pacificDay(now)
  return { from: dayLabel(shiftDay(today, -30)), to: dayLabel(today) }
}

export function resolveRange(
  key: RangeKey,
  custom?: CustomRange,
  now = new Date(),
): { dateFrom: string; dateTo: string } {
  const today = pacificDay(now)
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth()
  const day = today.getUTCDate()
  const week = shiftDay(today, -((today.getUTCDay() + 6) % 7))
  const priorYearDay = calendarDay(
    year - 1, month, Math.min(day, calendarDay(year - 1, month + 1, 0).getUTCDate()),
  )
  const result = (start: Date, end = now) => ({
    dateFrom: midnight(start).toISOString(), dateTo: end.toISOString(),
  })
  const completeDays = (start: Date, exclusiveEnd: Date) =>
    result(start, new Date(midnight(exclusiveEnd).getTime() - 1))

  switch (key) {
    case "yesterday": return completeDays(shiftDay(today, -1), today)
    case "thisWeek": return result(week)
    case "lastWeek": return completeDays(shiftDay(week, -7), week)
    case "lastMonth": return completeDays(calendarDay(year, month - 1, 1), calendarDay(year, month, 1))
    case "mtd": return result(calendarDay(year, month, 1))
    case "last30": return result(shiftDay(today, -30))
    case "last60": return result(shiftDay(today, -60))
    case "last90": return result(shiftDay(today, -90))
    case "lastYearYtd": return completeDays(calendarDay(year - 1, 0, 1), shiftDay(priorYearDay, 1))
    case "lastYear": return completeDays(calendarDay(year - 1, 0, 1), calendarDay(year, 0, 1))
    case "last12": return result(priorYearDay)
    case "since2023": return result(calendarDay(2023, 0, 1))
    case "custom": {
      const parse = (value?: string): Date | null => {
        const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
        if (!parts) return null
        const date = calendarDay(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
        return dayLabel(date) === value ? date : null
      }
      const start = parse(custom?.from) ?? shiftDay(today, -30)
      const end = parse(custom?.to)
      if (end) {
        return start <= end
          ? completeDays(start, shiftDay(end, 1))
          : completeDays(end, shiftDay(start, 1))
      }
      return start > today ? completeDays(today, shiftDay(start, 1)) : result(start)
    }
    case "ytd":
    case "thisYear":
    default: return result(calendarDay(year, 0, 1))
  }
}
