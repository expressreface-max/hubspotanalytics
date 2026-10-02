import type { PipelineRecord, WatchItem } from "./sales-watch"

export const WATCH_MAX_AGE_MS = 90 * 86400000
export function inWatchScope(type: string, createdAt: string | null | undefined, now = Date.now()): boolean {
  if (type !== "contacts" && type !== "deals") return false
  const created = createdAt ? (/^\d+$/.test(createdAt) ? Number(createdAt) : Date.parse(createdAt)) : NaN
  return Number.isFinite(created) && created > now - WATCH_MAX_AGE_MS && created <= now
}

export type InventoryKind = "quoted" | "consultations" | "service"
// Explicit stage IDs override label matching. No customer-specific IDs or data.
export function inventoryKind(stage: string, id: string, overrides: Partial<Record<InventoryKind, string[]>> = {}): InventoryKind | null {
  for (const kind of ["service", "quoted", "consultations"] as const) if (overrides[kind]?.includes(id)) return kind
  if (/\b(punch[\s-]*list|remake|warranty|customer service)\b/i.test(stage) && !/\b(complete[d]?|closed|resolved)\b/i.test(stage)) return "service"
  if (/\b(quoted|quote sent|proposal sent|estimate sent)\b/i.test(stage) && !/\b(approved|accepted|lost|won)\b/i.test(stage)) return "quoted"
  if (/\b(consultation|consult|appointment|awaiting quote|quote requested|quote preparation)\b/i.test(stage)) return "consultations"
  return null
}
export const REVIEW_LABELS = {now:"Follow up",wait:"Wait",no_contact:"Do not contact",review:"Review first"} as const
export function pendingReview(): NonNullable<PipelineRecord["communicationReview"]> {
  return {decision:"review",label:"Review first",summary:"Communication assessment is pending for this inventory refresh.",
    reason:"A new inventory snapshot is not proof that communications have been reviewed.",
    nextAction:"Review HubSpot history before outreach, or run/resume the analysis.",
    timing:"Pending analysis",timingBasis:"No customer timing inferred.",reviewedAt:"",confidence:"low",
    coverage:"Not yet analyzed in this run.",evidence:[]}
}
export function eligibleForCall(item: WatchItem, now = Date.now()): boolean {
  return item.callEligible !== false && !item.doNotCall &&
    Number.isFinite(Date.parse(item.updatedAt)) && now-Date.parse(item.updatedAt) <= 36*3600000
}
