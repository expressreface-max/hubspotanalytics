import "server-only"
import { hsFetch, fetchOwnerMap, pipelineLabel, dealAmount, dealJobTypes } from "@/lib/hubspot"

// Engagement types we pull off a deal, with the content properties to read.
export const ENGAGEMENT_TYPES = {
  emails: ["hs_timestamp", "hs_email_subject", "hs_email_text", "hs_email_direction", "hs_email_status"],
  calls: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_direction", "hs_call_duration", "hs_call_disposition"],
  notes: ["hs_timestamp", "hs_note_body"],
  meetings: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body", "hs_meeting_start_time", "hs_meeting_outcome"],
  tasks: ["hs_timestamp", "hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_priority"],
} as const

export type EngType = keyof typeof ENGAGEMENT_TYPES

export type Engagement = {
  type: EngType
  ts: number | null
  title: string
  body: string
  direction: string | null
}

export type DealContext = {
  deal: {
    id: string
    name: string
    stage: string
    pipeline: string
    amount: number
    ownerName: string
    ageDays: number | null
    jobTypes: string
    lastContactedMs: number | null
    description: string
    contactLines: string
  }
  counts: Record<EngType, number>
  totalEngagements: number
  engagements: Engagement[] // newest first, capped to 40
  lastEngagementAt: number | null
  unreadableChannels: { type: EngType; count: number }[] // channels present but not readable (scope)
  readableBodies: number // engagements with substantive written content
  dealContextText: string // the multi-line facts block used in prompts
}

export function parseDate(v: string | null | undefined): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

// Strip HTML tags/entities and collapse whitespace so bodies stay compact.
export function clean(s: string | null | undefined, cap = 1200): string {
  if (!s) return ""
  const text = s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > cap ? text.slice(0, cap) + "…" : text
}

export function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "unknown date"
}

// Associated object ids of a given type for one deal (v4 associations).
async function fetchAssocIds(token: string, dealId: string, type: string): Promise<string[]> {
  try {
    const data = await hsFetch<{ results: { toObjectId: number }[] }>(
      `/crm/v4/objects/deals/${dealId}/associations/${type}?limit=100`,
      { token, method: "GET" },
    )
    return (data.results || []).map((r) => String(r.toObjectId))
  } catch {
    return []
  }
}

async function batchReadObjects(
  token: string,
  type: string,
  ids: string[],
  properties: readonly string[],
): Promise<{ objects: { id: string; properties: Record<string, string | null> }[]; failed: boolean }> {
  if (!ids.length) return { objects: [], failed: false }
  const out: { id: string; properties: Record<string, string | null> }[] = []
  let failed = false
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    try {
      const data = await hsFetch<{ results: { id: string; properties: Record<string, string | null> }[] }>(
        `/crm/v3/objects/${type}/batch/read`,
        {
          token,
          method: "POST",
          body: JSON.stringify({ properties: [...properties], inputs: chunk.map((id) => ({ id })) }),
        },
      )
      out.push(...(data.results || []))
    } catch {
      // A whole chunk failing usually means a missing read scope for this
      // object type (e.g. emails need crm.objects.emails.read). Track it so we
      // can tell the model the channel is unreadable rather than empty.
      failed = true
    }
  }
  return { objects: out, failed }
}

// stage id -> label across all deal pipelines (best-effort, cached per call).
export async function fetchStageLabelMap(token: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  try {
    const data = await hsFetch<{ results: { stages: { id: string; label: string }[] }[] }>(
      "/crm/v3/pipelines/deals",
      { token, method: "GET" },
    )
    for (const pl of data.results || []) for (const s of pl.stages || []) map[s.id] = s.label
  } catch {
    /* fall back to raw id */
  }
  return map
}

function toEngagement(type: EngType, props: Record<string, string | null>): Engagement {
  const ts = parseDate(props.hs_timestamp) ?? parseDate(props.hs_meeting_start_time)
  switch (type) {
    case "emails":
      return { type, ts, title: clean(props.hs_email_subject, 200) || "(email)", body: clean(props.hs_email_text), direction: props.hs_email_direction || null }
    case "calls":
      return { type, ts, title: clean(props.hs_call_title, 200) || "(call)", body: clean(props.hs_call_body), direction: props.hs_call_direction || null }
    case "notes":
      return { type, ts, title: "Note", body: clean(props.hs_note_body), direction: null }
    case "meetings":
      return { type, ts, title: clean(props.hs_meeting_title, 200) || "(meeting)", body: [clean(props.hs_meeting_body), props.hs_meeting_outcome ? `Outcome: ${props.hs_meeting_outcome}` : ""].filter(Boolean).join(" — "), direction: null }
    case "tasks":
      return { type, ts, title: clean(props.hs_task_subject, 200) || "(task)", body: [clean(props.hs_task_body), props.hs_task_status ? `Status: ${props.hs_task_status}` : ""].filter(Boolean).join(" — "), direction: null }
  }
}

// Build a chronological (oldest -> newest) transcript. When `sinceMs` is set,
// only engagements strictly newer than that are included.
export function buildTranscript(engagements: Engagement[], sinceMs?: number | null): string {
  const filtered = sinceMs != null ? engagements.filter((e) => (e.ts ?? 0) > sinceMs) : engagements
  return [...filtered]
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    .map((e) => {
      const dir = e.direction ? ` (${e.direction})` : ""
      const body = e.body ? `\n  ${e.body}` : ""
      return `- [${fmtDate(e.ts)}] ${e.type.slice(0, -1).toUpperCase()}${dir}: ${e.title}${body}`
    })
    .join("\n")
}

// Fetch a deal's core facts + full engagement history, formatted for AI prompts.
// Shared by the on-demand deal analysis and the daily open-quote scanner.
export async function buildDealContext(
  token: string,
  dealId: string,
  stageLabels?: Record<string, string>,
): Promise<DealContext> {
  const dealProps = [
    "dealname", "amount", "pipeline", "dealstage", "createdate", "closedate",
    "hubspot_owner_id", "job_type", "dealtype", "description",
    "reface_amount", "countertop_amount", "notes_last_contacted", "notes_last_updated",
  ]
  const deal = await hsFetch<{ id: string; properties: Record<string, string | null> }>(
    `/crm/v3/objects/deals/${dealId}?properties=${dealProps.join(",")}`,
    { token, method: "GET" },
  )
  const p = deal.properties
  const dealLike = { id: deal.id, properties: p } as any

  const contactIds = await fetchAssocIds(token, dealId, "contacts")
  const [ownerMap, stageMap, contactsRes] = await Promise.all([
    fetchOwnerMap(token),
    stageLabels ? Promise.resolve(stageLabels) : fetchStageLabelMap(token),
    batchReadObjects(token, "contacts", contactIds.slice(0, 5), ["firstname", "lastname", "email", "phone", "city", "state"]),
  ])
  const contacts = contactsRes.objects
  const stageLabel = stageMap[p.dealstage || ""] || p.dealstage || "—"
  const ownerName = p.hubspot_owner_id ? ownerMap[p.hubspot_owner_id] || `Owner ${p.hubspot_owner_id}` : "Unassigned"

  const engagements: Engagement[] = []
  const counts: Record<EngType, number> = { emails: 0, calls: 0, notes: 0, meetings: 0, tasks: 0 }
  // Channels that exist on the deal but couldn't be read (usually a missing
  // read scope). We surface these to the model so it doesn't misread an
  // unreadable channel as an inactive one.
  const unreadable: { type: EngType; count: number }[] = []
  let readableBodies = 0
  for (const type of Object.keys(ENGAGEMENT_TYPES) as EngType[]) {
    const ids = await fetchAssocIds(token, dealId, type)
    counts[type] = ids.length
    if (!ids.length) continue
    const { objects, failed } = await batchReadObjects(token, type, ids.slice(0, 40), ENGAGEMENT_TYPES[type])
    if (failed && objects.length === 0) unreadable.push({ type, count: ids.length })
    for (const o of objects) {
      const e = toEngagement(type, o.properties)
      if (e.body && e.body.trim().length > 3) readableBodies += 1
      engagements.push(e)
    }
  }
  engagements.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
  const recent = engagements.slice(0, 40)
  const lastEngagementAt = recent.length ? recent[0].ts : null

  const contactLines = contacts
    .map((c) => {
      const q = c.properties
      const name = [q.firstname, q.lastname].filter(Boolean).join(" ").trim() || q.email || "(unknown)"
      const loc = [q.city, q.state].filter(Boolean).join(", ")
      return `${name}${q.email ? ` <${q.email}>` : ""}${loc ? ` — ${loc}` : ""}`
    })
    .join("; ")

  const jobTypes = dealJobTypes(dealLike).join(", ") || "unspecified"
  const amount = dealAmount(dealLike)
  const createdMs = parseDate(p.createdate)
  const ageDays = createdMs ? Math.round((Date.now() - createdMs) / 86_400_000) : null
  const lastContactedMs = parseDate(p.notes_last_contacted)

  // Build an explicit data-coverage caveat so the model knows what it can and
  // cannot see. This is what prevents "21 emails exist but I was shown none" from
  // being misread as "the deal is stalled / no recent activity."
  const coverageNotes: string[] = []
  for (const u of unreadable) {
    coverageNotes.push(
      `${u.count} ${u.type} could NOT be read (content unavailable to this analysis, likely a permissions limit) — an active ${u.type.slice(0, -1)} thread may exist that you cannot see.`,
    )
  }
  if (readableBodies === 0 && engagements.length > 0) {
    coverageNotes.push("None of the readable engagements contained substantive written content (mostly automated/system entries).")
  }
  const coverageBlock = coverageNotes.length
    ? "DATA COVERAGE CAVEAT:\n" +
      coverageNotes.map((n) => `- ${n}`).join("\n") +
      "\n- Do NOT treat unreadable or missing content as inactivity. Base health and probability only on what is actually visible, note the limited visibility, and avoid stating older context as if it were the current status."
    : ""

  const dealContextText = [
    `Deal name: ${p.dealname || "(no name)"}`,
    `Pipeline: ${pipelineLabel(p.pipeline)}`,
    `Current stage: ${stageLabel}`,
    `Amount: ${amount ? `$${amount.toLocaleString()}` : "not set"}`,
    `Job type(s): ${jobTypes}`,
    `Sales rep (owner): ${ownerName}`,
    `Contact(s): ${contactLines || "none associated"}`,
    `Created: ${fmtDate(createdMs)}${ageDays != null ? ` (${ageDays} days ago)` : ""}`,
    `Last contacted: ${fmtDate(lastContactedMs)}`,
    p.description ? `Description: ${clean(p.description, 500)}` : "",
    `Engagement counts: ${counts.emails} emails, ${counts.calls} calls, ${counts.meetings} meetings, ${counts.notes} notes, ${counts.tasks} tasks`,
    coverageBlock,
  ]
    .filter(Boolean)
    .join("\n")

  return {
    deal: {
      id: deal.id,
      name: p.dealname || "(no name)",
      stage: stageLabel,
      pipeline: pipelineLabel(p.pipeline),
      amount,
      ownerName,
      ageDays,
      jobTypes,
      lastContactedMs,
      description: clean(p.description, 500),
      contactLines,
    },
    counts,
    totalEngagements: engagements.length,
    engagements: recent,
    lastEngagementAt,
    unreadableChannels: unreadable,
    readableBodies,
    dealContextText,
  }
}
