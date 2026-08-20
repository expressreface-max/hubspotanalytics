import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { hsFetch, fetchOwnerMap, HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type MeetingRecord = {
  id: string
  properties: {
    hs_meeting_start_time?: string | null
    hubspot_owner_id?: string | null
    hs_activity_type?: string | null
    hs_attendee_owner_ids?: string | null
    hs_meeting_title?: string | null
    hs_meeting_outcome?: string | null
    hs_meeting_location?: string | null
  }
}

type WeekKey = "lastWeek" | "thisWeek" | "nextWeek" | "future"
type MeetingDetail = {
  id: string
  title: string
  startTime: string
  type: string
  outcome: string | null
  location: string | null
}
type WeekBucket = { total: number; byType: Record<string, number>; meetings: MeetingDetail[] }
type RepRow = { rep: string; total: number; weeks: Record<WeekKey, WeekBucket> }

const UNSPECIFIED_TYPE = "Unspecified"
const WEEK_ORDER: WeekKey[] = ["lastWeek", "thisWeek", "nextWeek", "future"]

function toMs(v: string | null | undefined): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function parseAttendeeOwnerIds(v: string | null | undefined): string[] {
  if (!v) return []
  return v
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
}

function emptyBucket(): WeekBucket {
  return { total: 0, byType: {}, meetings: [] }
}

// Paginate meetings whose actual start time falls in [fromMs, toMsHigh].
async function searchMeetingsInRange(token: string, fromMs: number, toMsHigh: number): Promise<MeetingRecord[]> {
  const results: MeetingRecord[] = []
  let after: string | undefined
  let pages = 0
  const maxPages = 40

  do {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "hs_meeting_start_time",
              operator: "BETWEEN",
              value: String(fromMs),
              highValue: String(toMsHigh),
            },
          ],
        },
      ],
      properties: [
        "hs_meeting_start_time",
        "hubspot_owner_id",
        "hs_activity_type",
        "hs_attendee_owner_ids",
        "hs_meeting_title",
        "hs_meeting_outcome",
        "hs_meeting_location",
      ],
      limit: 100,
      sorts: [{ propertyName: "hs_meeting_start_time", direction: "ASCENDING" }],
    }
    if (after) body.after = after

    const data = await hsFetch<{
      results: MeetingRecord[]
      paging?: { next?: { after: string } }
    }>("/crm/v3/objects/meetings/search", {
      token,
      method: "POST",
      body: JSON.stringify(body),
    })

    results.push(...(data.results || []))
    after = data.paging?.next?.after
    pages++
    if (after) await new Promise((r) => setTimeout(r, 250))
  } while (after && pages < maxPages)

  return results
}

export async function GET() {
  const token = await getActiveToken()
  if (!token) {
    return NextResponse.json({ configured: false, error: "HubSpot not connected." }, { status: 200 })
  }

  // Monday-based week boundaries anchored on today (server local time).
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayIdx = (startOfToday.getDay() + 6) % 7 // 0 = Monday
  const thisWeekStart = new Date(startOfToday)
  thisWeekStart.setDate(startOfToday.getDate() - dayIdx)
  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(thisWeekStart.getDate() - 7)
  const nextWeekStart = new Date(thisWeekStart)
  nextWeekStart.setDate(thisWeekStart.getDate() + 7)
  const nextWeekEnd = new Date(thisWeekStart)
  nextWeekEnd.setDate(thisWeekStart.getDate() + 14)
  nextWeekEnd.setMilliseconds(-1)
  // "Future" starts the day after next week ends and runs out to a far horizon
  // (1 year) so we capture every scheduled meeting beyond next week.
  const futureStart = new Date(thisWeekStart)
  futureStart.setDate(thisWeekStart.getDate() + 14)
  const futureEnd = new Date(futureStart)
  futureEnd.setDate(futureStart.getDate() + 365)
  futureEnd.setMilliseconds(-1)

  const weeks: { key: WeekKey; label: string; from: string; to: string }[] = [
    { key: "lastWeek", label: "Last week", from: lastWeekStart.toISOString(), to: new Date(thisWeekStart.getTime() - 1).toISOString() },
    { key: "thisWeek", label: "This week", from: thisWeekStart.toISOString(), to: new Date(nextWeekStart.getTime() - 1).toISOString() },
    { key: "nextWeek", label: "Next week", from: nextWeekStart.toISOString(), to: nextWeekEnd.toISOString() },
    { key: "future", label: "Future", from: futureStart.toISOString(), to: futureEnd.toISOString() },
  ]

  const spanFrom = lastWeekStart.getTime()
  const spanTo = futureEnd.getTime()

  function weekOf(t: number): WeekKey | null {
    if (t >= lastWeekStart.getTime() && t < thisWeekStart.getTime()) return "lastWeek"
    if (t >= thisWeekStart.getTime() && t < nextWeekStart.getTime()) return "thisWeek"
    if (t >= nextWeekStart.getTime() && t <= nextWeekEnd.getTime()) return "nextWeek"
    if (t >= futureStart.getTime() && t <= futureEnd.getTime()) return "future"
    return null
  }

  try {
    const [meetings, ownerMap] = await Promise.all([
      searchMeetingsInRange(token, spanFrom, spanTo),
      fetchOwnerMap(token),
    ])

    const repMap = new Map<string, RepRow>()
    const typeTotals = new Map<string, number>()
    const weekTotals: Record<WeekKey, WeekBucket> = {
      lastWeek: emptyBucket(),
      thisWeek: emptyBucket(),
      nextWeek: emptyBucket(),
      future: emptyBucket(),
    }

    for (const m of meetings) {
      const t = toMs(m.properties.hs_meeting_start_time)
      if (t === null) continue
      const wk = weekOf(t)
      if (!wk) continue

      // Attribute to the rep who ATTENDED (first attendee that isn't the
      // scheduler), matching the existing meetings-set logic.
      const scheduler = m.properties.hubspot_owner_id ? String(m.properties.hubspot_owner_id) : null
      const attendees = parseAttendeeOwnerIds(m.properties.hs_attendee_owner_ids)
      const nonScheduler = attendees.find((id) => id !== scheduler)
      const ownerId = nonScheduler || attendees[0] || scheduler
      const rep = (ownerId && ownerMap[String(ownerId)]) || "Unassigned"
      const type = (m.properties.hs_activity_type || "").trim() || UNSPECIFIED_TYPE

      let row = repMap.get(rep)
      if (!row) {
        row = {
          rep,
          total: 0,
          weeks: { lastWeek: emptyBucket(), thisWeek: emptyBucket(), nextWeek: emptyBucket(), future: emptyBucket() },
        }
        repMap.set(rep, row)
      }
      const detail: MeetingDetail = {
        id: m.id,
        title: (m.properties.hs_meeting_title || "").trim() || "(untitled meeting)",
        startTime: new Date(t).toISOString(),
        type,
        outcome: m.properties.hs_meeting_outcome || null,
        location: m.properties.hs_meeting_location || null,
      }

      row.total += 1
      row.weeks[wk].total += 1
      row.weeks[wk].byType[type] = (row.weeks[wk].byType[type] || 0) + 1
      row.weeks[wk].meetings.push(detail)

      weekTotals[wk].total += 1
      weekTotals[wk].byType[type] = (weekTotals[wk].byType[type] || 0) + 1
      weekTotals[wk].meetings.push(detail)
      typeTotals.set(type, (typeTotals.get(type) || 0) + 1)
    }

    const types = [...typeTotals.entries()]
      .sort((a, b) => {
        if (a[0] === UNSPECIFIED_TYPE) return 1
        if (b[0] === UNSPECIFIED_TYPE) return -1
        return b[1] - a[1] || a[0].localeCompare(b[0])
      })
      .map(([t]) => t)

    for (const row of repMap.values()) {
      for (const wk of WEEK_ORDER) {
        row.weeks[wk].meetings.sort((a, b) => a.startTime.localeCompare(b.startTime))
      }
    }

    const byRep = [...repMap.values()].sort((a, b) => b.total - a.total || a.rep.localeCompare(b.rep))
    const grandTotal =
      weekTotals.lastWeek.total + weekTotals.thisWeek.total + weekTotals.nextWeek.total + weekTotals.future.total

    return NextResponse.json({
      configured: true,
      weeks,
      types,
      byRep,
      weekTotals,
      grandTotal,
    })
  } catch (err) {
    if (err instanceof HubSpotError) {
      return NextResponse.json({ configured: true, error: err.message }, { status: 200 })
    }
    return NextResponse.json(
      { configured: true, error: (err as Error)?.message || "Failed to load meetings." },
      { status: 200 },
    )
  }
}
