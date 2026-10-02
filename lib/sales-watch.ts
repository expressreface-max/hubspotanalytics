// Shared, deterministic queue policy. No network, database or model calls.
export const WATCH_KINDS = ["follow_up", "promise", "satisfaction", "displeasure", "remake", "service", "warranty", "close_lost"] as const
export type WatchKind = typeof WATCH_KINDS[number]
export type SubjectType = "deals" | "contacts" | "tickets"
export type Evidence = { id: string; type: string; at: string | null; quote: string; url: string | null; association?: string }
export type WatchItem = {
  id: string; subjectKey: string; subjectType: SubjectType; subjectId: string
  customerKey: string; name: string; stage: string; rep: string; phone: string | null
  kind: WatchKind; severity: "urgent" | "high" | "normal"
  summary: string; nextAction: string; dueAt: string | null
  owner: "Inside sales"; routeTo: "Inside sales" | "Sales manager" | "Customer service"
  evidence: Evidence[]; confidence: "high" | "medium" | "low"
  status: "open" | "resolved" | "snoozed"; snoozedUntil: string | null
  doNotCall: boolean; updatedAt: string; coverage: string[]
  lastDisposition?: { action: string; note: string; actor: string; at: string }
  stream?: "sales" | "service" | "review"
  contactUrl?: string | null; dealUrl?: string | null
  background?: string; latestUpdate?: string; callObjective?: string; verification?: string
  reportRank?: number
  callEligible?: boolean
}
export type PipelineRecord = {
  id: string; name: string; stage: string; pipeline: string; amount: number | null
  enteredAt: string | null; lastContactAt: string | null; rep: string
  contactUrl: string | null; dealUrl: string | null
  contacts: {name: string; url: string | null}[]
  summary: string; status: string; meetingAt?: string | null
  inventoryKind?: "quoted" | "consultations" | "service"
  customerKey?: string; meetingOutcome?: string | null
  communicationReview?: {
    decision:"now"|"wait"|"no_contact"|"review"; label:string; summary:string; reason:string
    nextAction:string; timing:string; timingBasis:string; reviewedAt:string; confidence:string; coverage:string
    evidence:(Evidence & {association:string})[]
  }
}
export type WatchRun = {
  id: string; status: "running" | "partial" | "complete" | "failed"
  startedAt: string; finishedAt: string | null; total: number; done: number; failed: number
  errors: string[]; trigger: "nightly" | "manual"; discoveryComplete: boolean
}
export type WatchData = {
  items: WatchItem[]; run: WatchRun | null; lastCompleteAt: string | null
  enabled: boolean; coverage: string[]; readOnly?: boolean; busy?: boolean
  snapshotAt?: string; quoted?: PipelineRecord[]; consultations?: PipelineRecord[]
  serviceInventory?: PipelineRecord[]; stats?: Record<string, number>
  inventoryAt?: string | null
}
export const KIND_LABEL: Record<WatchKind, string> = {
  follow_up: "Follow-up", promise: "Customer promise", satisfaction: "Positive feedback",
  displeasure: "Customer concern", remake: "Remake", service: "Customer service",
  warranty: "Warranty", close_lost: "Closed-lost review",
}
export function pacificDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}
export function canStartNightlyWatch(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now)
  const hour = Number(parts.find(part => part.type === "hour")?.value)
  const minute = Number(parts.find(part => part.type === "minute")?.value)
  // Later ticks catch a missed 00:15 invocation; the database permits one nightly run per Pacific date.
  return hour * 60 + minute >= 15
}
export function isActive(item: WatchItem, now = Date.now()): boolean {
  return item.status !== "resolved" && !(item.status === "snoozed" && item.snoozedUntil && Date.parse(item.snoozedUntil) > now)
}
export function scoreItem(item: WatchItem, now = Date.now()): number {
  const base = { displeasure: 70, remake: 65, warranty: 60, service: 55, promise: 50, follow_up: 30, satisfaction: 10, close_lost: 0 }[item.kind]
  const overdue = item.dueAt && Date.parse(item.dueAt) < now ? Math.min(25, 10 + Math.floor((now - Date.parse(item.dueAt)) / 86400000)) : 0
  return base + ({ urgent: 45, high: 20, normal: 0 }[item.severity]) + overdue
}
export function itemStream(item: WatchItem): "sales" | "service" | "review" {
  return item.stream ?? (["service","remake","warranty"].includes(item.kind) || item.routeTo === "Customer service" ? "service" : item.routeTo === "Sales manager" ? "review" : "sales")
}
export function dailyCalls(items: WatchItem[], now = Date.now(), stream: "sales" | "service" = "sales"): WatchItem[] {
  // One customer, one call, even if several deals or service issues exist.
  const seen = new Set<string>()
  const blocked = new Set(items.filter(i=>i.doNotCall).map(i=>i.customerKey))
  return items.filter(i => itemStream(i) === stream && isActive(i, now) && i.callEligible !== false && i.kind !== "close_lost" && !blocked.has(i.customerKey) && !!i.phone && i.confidence !== "low")
    .sort((a, b) => (a.reportRank ?? 999) - (b.reportRank ?? 999) || scoreItem(b, now) - scoreItem(a, now) || a.id.localeCompare(b.id))
    .filter(i => { if (seen.has(i.customerKey)) return false; seen.add(i.customerKey); return true })
    .slice(0, 10)
}
export function staleWatch(data: WatchData, now = Date.now()): boolean {
  return !data.lastCompleteAt || now - Date.parse(data.lastCompleteAt) > 36 * 3600000
}
export function triage(item: WatchItem, action: "resolve" | "snooze" | "reopen", until?: string): WatchItem {
  if (action === "snooze" && (!until || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now())) throw new Error("Choose a future follow-up time.")
  return { ...item, status: action === "resolve" ? "resolved" : action === "snooze" ? "snoozed" : "open", snoozedUntil: action === "snooze" ? until! : null }
}
