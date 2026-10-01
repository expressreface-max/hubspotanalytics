import "server-only"
import { sql } from "@/lib/db"
import { triage, itemStream, type WatchData, type WatchItem, type WatchRun, type PipelineRecord } from "@/lib/sales-watch"
import { eligibleForCall } from "@/lib/sales-watch-policy"

export function readWatchJson<T extends object>(value: unknown): T {
  // The initial canary pre-stringified JSON before postgres.js serialized it again.
  // Run errors could gain another encoding layer on each continuation.
  for (let depth = 0; typeof value === "string" && depth < 8; depth++) {
    value = JSON.parse(value)
  }
  if (value === null || typeof value !== "object") throw new Error("Invalid stored Sales Watch JSON.")
  return value as T
}

export function readWatchErrors(value: unknown): string[] {
  const errors = readWatchJson<string[]>(value)
  if (!Array.isArray(errors) || errors.some(error => typeof error !== "string")) {
    throw new Error("Invalid stored Sales Watch coverage.")
  }
  return errors
}

export async function readWatch(): Promise<WatchData> {
  const rows = await sql`select i.payload,i.status,i.snoozed_until,i.updated_at,
    a.action,a.note,a.actor,a.at as action_at from sales_watch_items i
    left join lateral(select action,note,actor,at from sales_watch_actions
      where item_id=i.id order by at desc,id desc limit 1) a on true
    order by i.updated_at desc,i.id`
  const [r] = await sql`select * from sales_watch_runs order by started_at desc limit 1`
  const [last] = await sql`select max(finished_at) as at from sales_watch_runs where status = 'complete'`
  const [inventoryRun]=await sql`select id,started_at from sales_watch_runs where discovery_complete=true order by started_at desc limit 1`
  const inventory=inventoryRun?await sql`select kind,payload from sales_watch_inventory where run_id=${inventoryRun.id} order by payload->>'name',deal_id`:[]
  const blocked=await sql`select customer_key from sales_watch_preferences where do_not_call=true`
  const noCall=new Set(blocked.map(r=>r.customer_key))
  const held=await sql`select customer_key from sales_watch_assessments where decision in ('wait','no_contact')`
  const salesHeld=new Set(held.map(r=>r.customer_key))
  const gaps = r ? await sql`select count(*)::int as count, error from sales_watch_queue
    where run_id=${r.id} and error is not null group by error order by count(*) desc` : []
  let run: WatchRun | null = null
  if (r) {
    const [counts] = await sql`select count(*)::int as total,
      count(*) filter (where status = 'done')::int as done,
      count(*) filter (where status = 'failed')::int as failed
      from sales_watch_queue where run_id = ${r.id}`
    run = {
      id: r.id, status: r.status, startedAt: new Date(r.started_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      total: counts.total, done: counts.done, failed: counts.failed,
      errors: readWatchErrors(r.errors), trigger: r.trigger, discoveryComplete: r.discovery_complete,
    }
  }
  return {
    items: rows.map(r => {
      const payload = readWatchJson<WatchItem>(r.payload)
      return { ...payload, status: r.status,
        doNotCall:payload.doNotCall || noCall.has(payload.customerKey),
        callEligible:eligibleForCall(payload) && !noCall.has(payload.customerKey) &&
          (itemStream(payload)!=="sales" || !salesHeld.has(payload.customerKey)),
        snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until).toISOString() : null,
        updatedAt: new Date(r.updated_at).toISOString(),
        ...(r.action_at ? {lastDisposition:{action:r.action,note:r.note,actor:r.actor,at:new Date(r.action_at).toISOString()}} : {}) }
    }),
    run, lastCompleteAt: last?.at ? new Date(last.at).toISOString() : null,
    enabled: process.env.SALES_WATCH_ENABLED === "true",
    inventoryAt:inventoryRun?new Date(inventoryRun.started_at).toISOString():null,
    ...(inventoryRun?{
      quoted:inventory.filter(r=>r.kind==="quoted").map(r=>readWatchJson<PipelineRecord>(r.payload)),
      consultations:inventory.filter(r=>r.kind==="consultations").map(r=>readWatchJson<PipelineRecord>(r.payload)),
      serviceInventory:inventory.filter(r=>r.kind==="service").map(r=>readWatchJson<PipelineRecord>(r.payload)),
    }:{}),
    coverage: [
      "HubSpot-logged activity only. Unlogged phone/SMS, external inboxes and audio without a logged transcript are not covered.",
      "First-run discovery: all open deals and tickets, plus 7 days of activity, modified contacts and closed deals. Unresolved findings remain until reviewed.",
      "Activity with no deal, contact or ticket association cannot be assigned to a customer worklist. Associated-contact communications may concern a different job.",
      "Inventory follows current HubSpot stage labels or configured stage IDs. Consultation-stage candidates include unverified or future appointments; only a completed meeting is evidence of a completed visit.",
      "Call recommendations expire after 36 hours without re-analysis. No-call preferences persist; resolving a finding does not clear a customer's preference.",
      ...(run?.errors ?? []),
      ...gaps.map(g => `${g.count} record(s): ${g.error}`),
    ],
  }
}

export async function applyWatchAction(id: string, action: "resolve" | "snooze" | "reopen", note: string, actor: string, until?: string) {
  if (note.trim().length < 5) throw new Error("Add a meaningful disposition note (at least 5 characters).")
  return sql.begin(async tx => {
    const [row] = await tx`select payload from sales_watch_items where id = ${id} for update`
    if (!row) throw new Error("Item not found.")
    const next = triage(readWatchJson<WatchItem>(row.payload), action, until)
    await tx`update sales_watch_items set status = ${next.status}, snoozed_until = ${next.snoozedUntil} where id = ${id}`
    await tx`insert into sales_watch_actions (item_id,actor,action,note) values (${id},${actor},${action},${note.trim()})`
    return { ok: true }
  })
}
