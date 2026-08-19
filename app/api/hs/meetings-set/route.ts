import { NextResponse } from "next/server"
import { getActiveToken } from "@/lib/token-store"
import { hsFetch, fetchOwnerMap, HubSpotError } from "@/lib/hubspot"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type Body = {
  dateFrom?: string
  dateTo?: string
}

type MeetingRecord = {
  id: string
  properties: {
    hs_meeting_start_time?: string | null
    hs_timestamp?: string | null
    hubspot_owner_id?: string | null
    hs_meeting_outcome?: string | null
    hs_activity_type?: string | null
    hs_attendee_owner_ids?: string | null
  }
}

type RepRow = {
  rep: string
  meetings: number
  byType: Record<string, number>
}

const UNSPECIFIED_TYPE = "Unspecified"

function toMs(v: string | null | undefined): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

// Parse the semicolon-delimited attendee-owner-ids string into an id list.
function parseAttendeeOwnerIds(v: string | null | undefined): string[] {
  if (!v) return []
  return v
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
}

// Paginate through the meetings search, gathering every meeting whose actual
// start time falls within [fromMs, toMsHigh]. This is date-of-meeting based — it
// does NOT depend on when a deal entered the appointment stage.
async function searchMeetingsInRange(token: string, fromMs: number, toMsHigh: number): Promise<MeetingRecord[]> {
  const results: MeetingRecord[] = []
  let after: string | undefined
  let pages = 0
  const maxPages = 60

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
        "hs_timestamp",
        "hubspot_owner_id",
        "hs_meeting_outcome",
        "hs_activity_type",
        "hs_attendee_owner_ids",
      ],
      limit: 100,
      sorts: [{ propertyName: "hs_meeting_start_time", direction: "DESCENDING" }],
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
    if (after) await new Promise((r) => setTimeout(r, 300))
  } while (after && pages < maxPages)

  return results
}

export async function POST(req: Request) {
  const token = await getActiveToken()
  if (!token) {
    return NextResponse.json({ configured: false, error: "HubSpot not connected." }, { status: 200 })
  }

  let body: Body = {}
  try {
    body = (await req.json()) as Body
  } catch {
    // empty body allowed
  }

  const to = body.dateTo ? new Date(body.dateTo) : new Date()
  const from = body.dateFrom ? new Date(body.dateFrom) : new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000)
  const fromMs = from.getTime()
  const toMsHigh = to.getTime()

  try {
    const meetings = await searchMeetingsInRange(token, fromMs, toMsHigh)

    // Guard: only keep meetings whose start time is genuinely in range.
    const inRange = meetings.filter((m) => {
      const t = toMs(m.properties.hs_meeting_start_time)
      return t !== null && t >= fromMs && t <= toMsHigh
    })

    // Attribute each meeting to the REP WHO ATTENDED it (hs_attendee_owner_ids),
    // i.e. the person who actually performed the meeting — for measurements this
    // is the field measurer, not the coordinator who booked it or the deal owner.
    // Pick the first attendee owner that is NOT the scheduler (so a coordinator
    // auto-added as an attendee doesn't steal credit); fall back to the first
    // attendee, then to the scheduler, then to "Unassigned".
    const ownerMap = await fetchOwnerMap(token)

    const repMap = new Map<string, RepRow>()
    const typeTotals = new Map<string, number>()

    for (const m of inRange) {
      const scheduler = m.properties.hubspot_owner_id ? String(m.properties.hubspot_owner_id) : null
      const attendees = parseAttendeeOwnerIds(m.properties.hs_attendee_owner_ids)
      const nonScheduler = attendees.find((id) => id !== scheduler)
      const ownerId = nonScheduler || attendees[0] || scheduler
      const rep = (ownerId && ownerMap[String(ownerId)]) || "Unassigned"
      const type = (m.properties.hs_activity_type || "").trim() || UNSPECIFIED_TYPE

      let row = repMap.get(rep)
      if (!row) {
        row = { rep, meetings: 0, byType: {} }
        repMap.set(rep, row)
      }
      row.meetings += 1
      row.byType[type] = (row.byType[type] || 0) + 1
      typeTotals.set(type, (typeTotals.get(type) || 0) + 1)
    }

    // Order types by overall frequency (Unspecified always last).
    const types = [...typeTotals.entries()]
      .sort((a, b) => {
        if (a[0] === UNSPECIFIED_TYPE) return 1
        if (b[0] === UNSPECIFIED_TYPE) return -1
        return b[1] - a[1] || a[0].localeCompare(b[0])
      })
      .map(([t]) => t)

    const byRep = [...repMap.values()].sort((a, b) => b.meetings - a.meetings || a.rep.localeCompare(b.rep))

    return NextResponse.json({
      configured: true,
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      totalMeetings: inRange.length,
      types,
      typeTotals: Object.fromEntries(typeTotals),
      byRep,
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
