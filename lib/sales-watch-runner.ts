import "server-only"
import { createHash, randomUUID } from "node:crypto"
import { generateText, NoObjectGeneratedError, Output } from "ai"
import { sql } from "@/lib/db"
import { pickAnalysisModel } from "@/lib/ai-model"
import { discoverTargets, watchContext, type Target, type WatchContext } from "@/lib/sales-watch-source"
import { analysisSchema, WATCH_SYSTEM, QUOTE_SYSTEM, verifiedSignals, routeFor, WatchValidationError } from "@/lib/sales-watch-analysis"
import { pacificDate, type WatchItem, type PipelineRecord } from "@/lib/sales-watch"
import { REVIEW_LABELS } from "@/lib/sales-watch-policy"
import { readWatch, readWatchErrors, readWatchJson, watchReadOnly } from "@/lib/sales-watch-store"

class WatchAnalysisError extends Error {}

export async function analyzeWatchContext(ctx: WatchContext, selection = pickAnalysisModel()) {
  let failure = "Model request failed; check provider access and quota. No assessment was saved."
  try {
    const result = await generateText({
      model: selection.model, system: WATCH_SYSTEM + QUOTE_SYSTEM,
      ...(selection.isPaid ? { output: Output.object({ schema: analysisSchema }) } : {}),
      prompt: JSON.stringify({ now: new Date().toISOString(), timezone: "America/Los_Angeles", ...ctx }),
      // Gemini's default thinking can consume the output cap before finishing JSON.
      providerOptions: selection.isPaid ? { google: { thinkingConfig: { thinkingBudget: 1024, includeThoughts: false } } } : undefined,
      maxOutputTokens: 6500, maxRetries: 0, abortSignal: AbortSignal.timeout(40000),
    })
    if (result.finishReason === "length") throw new WatchAnalysisError("Model response exceeded the output limit; no assessment was saved.")
    if (result.finishReason !== "stop") throw new WatchAnalysisError("Model did not finish an assessment; review provider availability and content restrictions.")
    failure = "Model returned incomplete or invalid JSON; no assessment was saved."
    const raw = selection.isPaid ? result.output : JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))
    failure = "Model assessment failed schema checks; no assessment was saved."
    return verifiedSignals(raw, ctx)
  } catch (error) {
    if (error instanceof WatchAnalysisError) throw error
    if (error instanceof WatchValidationError) throw new WatchAnalysisError(error.message)
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new WatchAnalysisError(error.finishReason === "length"
        ? "Model response exceeded the output limit; no assessment was saved."
        : "Model returned incomplete or invalid structured output; no assessment was saved.")
    }
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
      throw new WatchAnalysisError("Model request timed out; no assessment was saved.")
    }
    throw new WatchAnalysisError(failure)
  }
}

// Entire feature is off until migration + controlled canary + explicit activation.
// Lock lasts longer than the route's 300s execution limit; expired leases recover.
export async function runWatch(token: string, trigger: "nightly" | "manual") {
  if (watchReadOnly()) throw new Error("Sales Watch is read-only outside production.")
  if (process.env.SALES_WATCH_ENABLED !== "true") throw new Error("Sales Watch is not activated. Complete rollout checks first.")
  const holder = randomUUID()
  const acquired = await sql`insert into sales_watch_lock (name,holder,expires_at)
    values ('worker',${holder},now() + interval '6 minutes')
    on conflict (name) do update set holder=excluded.holder, expires_at=excluded.expires_at
    where sales_watch_lock.expires_at < now() returning holder`
  if (!acquired.length) return { busy: true, ...(await readWatch()) }
  const deadline = Date.now() + 230000
  let runId: string | undefined
  try {
    // Resume unfinished work before starting a new daily/manual run, preventing tail starvation.
    let [run] = await sql`select * from sales_watch_runs where status in ('running','partial','failed')
      and (discovery_complete = false or exists (
        select 1 from sales_watch_queue q where q.run_id=sales_watch_runs.id and q.status != 'done' and q.attempts < 3
      )) order by started_at limit 1`
    if (!run) {
      if (trigger === "nightly") {
        const [today] = await sql`select id from sales_watch_runs where day_key=${pacificDate()} and trigger='nightly'`
        if (today) return { busy: false, ...(await readWatch()) }
      } else {
        const [recent] = await sql`select id from sales_watch_runs where started_at > now() - interval '15 minutes' limit 1`
        if (recent) throw new Error("A run just completed. Wait 15 minutes before starting another full refresh.")
      }
      const id = randomUUID()
      const rows = await sql`insert into sales_watch_runs(id,day_key,trigger,status)
        values(${id},${pacificDate()},${trigger},'running') returning *`
      run = rows[0]
    }
    runId = run.id
    await sql`update sales_watch_runs set status='running' where id=${run.id}`
    if (!run.discovery_complete) {
      const [last] = await sql`select max(started_at) as at from sales_watch_runs where status='complete'`
      // Overlap protects modifications arriving during a previous scan.
      const since = new Date(last?.at ? new Date(last.at).getTime() - 86400000 : Date.now() - 7 * 86400000).toISOString()
      const discovery = await discoverTargets(token, since, deadline)
      const existing = await sql`select distinct subject_key from sales_watch_items where status != 'resolved'`
      const targets = new Map(discovery.targets.map(t => [`${t.type}:${t.id}`, t]))
      for (const row of existing) {
        const [type,id] = row.subject_key.split(":")
        if (["deals","contacts","tickets"].includes(type) && /^\d+$/.test(id)) targets.set(row.subject_key, { type, id } as Target)
      }
      await sql.begin(async tx => {
        for(const row of discovery.inventory) {
          await tx`insert into sales_watch_inventory(run_id,deal_id,kind,payload)
            values(${run.id},${row.id},${row.inventoryKind!},${tx.json(row)}) on conflict(run_id,deal_id) do update set payload=excluded.payload`
        }
        for (const [key,t] of targets) {
          await tx`insert into sales_watch_queue(run_id,subject_key,subject_type,subject_id)
            values(${run.id},${key},${t.type},${t.id}) on conflict do nothing`
        }
        await tx`update sales_watch_runs set discovery_complete=true, errors=${tx.json(discovery.coverage)} where id=${run.id}`
      })
    }
    const selection = pickAnalysisModel()
    // Per-invocation cap: continuations can finish the entire inventory rather
    // than becoming permanently stuck behind a cumulative attempt ceiling.
    const maxBatch = Number(process.env.SALES_WATCH_BATCH_SIZE || 20)
    if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 100) throw new Error("Invalid SALES_WATCH_BATCH_SIZE (1–100).")
    let available = maxBatch
    const pending = await sql`select * from sales_watch_queue where run_id=${run.id}
      and status!='done' and attempts<3 order by
      case when exists(select 1 from sales_watch_inventory i where i.run_id=${run.id} and 'deals:'||i.deal_id=sales_watch_queue.subject_key) then 0 else 1 end,
      attempts,subject_key limit ${maxBatch}`
    for (const q of pending) {
      if (Date.now() > deadline - 50000 || available <= 0) break
      available--
      await sql`update sales_watch_queue set attempts=attempts+1 where run_id=${run.id} and subject_key=${q.subject_key}`
      try {
        const [inventoryRow]=q.subject_type==="deals"?await sql`select payload from sales_watch_inventory where run_id=${run.id} and deal_id=${q.subject_id}`:[]
        const ctx = await watchContext(token, { type:q.subject_type, id:q.subject_id }, Math.min(deadline-45000,Date.now()+70000),inventoryRow ? readWatchJson<PipelineRecord>(inventoryRow.payload) : undefined)
        if (ctx.excluded) {
          await sql`delete from sales_watch_inventory where run_id=${run.id} and deal_id=${q.subject_id}`
          await sql`update sales_watch_items set payload=jsonb_set(payload,'{callEligible}','false') where subject_key=${q.subject_key}`
          await sql`update sales_watch_queue set status='done',error=null where run_id=${run.id} and subject_key=${q.subject_key}`
          continue
        }
        if (Date.now() > deadline - 45000) throw new Error("Context completed too near deadline; analysis deferred.")
        const parsed = await analyzeWatchContext(ctx, selection)
        await sql.begin(async tx => {
          // Omitted findings stay available for human disposition, but do not
          // remain automatic call recommendations after a newer analysis.
          await tx`update sales_watch_items set payload=jsonb_set(payload,'{callEligible}','false') where subject_key=${q.subject_key}`
          const keys=[...new Set([ctx.customerKey,...(ctx.contactKeys||[])])]
          if(parsed.doNotCall)for(const key of keys)await tx`insert into sales_watch_preferences(customer_key,do_not_call)
            values(${key},true) on conflict(customer_key) do update set do_not_call=true,updated_at=now()`
          const [pref]=await tx`select customer_key from sales_watch_preferences where customer_key in ${tx(keys)} and do_not_call=true limit 1`
          const noCallPreference=!!pref || parsed.doNotCall
          await tx`insert into sales_watch_assessments(subject_key,customer_key,decision)
            values(${q.subject_key},${ctx.customerKey},${noCallPreference?"no_contact":parsed.outreachDecision})
            on conflict(subject_key) do update set customer_key=excluded.customer_key,decision=excluded.decision,updated_at=now()`
          if(ctx.inventory) {
            const r=parsed.quoteReview
            if(r)ctx.inventory.communicationReview={
              ...r,decision:noCallPreference?"no_contact":r.decision,
              label:REVIEW_LABELS[noCallPreference?"no_contact":r.decision],
              ...(noCallPreference?{nextAction:"Do not call. Review and honor the saved customer communication preference before any outreach."}:{}),
              reviewedAt:new Date().toISOString(),coverage:ctx.coverage.join(" ") || "Readable HubSpot-logged history reviewed. Unlogged channels and audio are not covered.",
              evidence:r.evidence.map(e=>({...ctx.evidence.find(s=>s.id===e.id)!,quote:e.quote,association:ctx.evidence.find(s=>s.id===e.id)?.association||"CRM record context"})),
            }
            await tx`update sales_watch_inventory set payload=${tx.json(ctx.inventory)},analyzed_at=now()
              where run_id=${run.id} and deal_id=${q.subject_id}`
          }
          for (const signal of parsed.signals) {
            const evidence = signal.evidence.map(e => ({ ...ctx.evidence.find(s => s.id===e.id)!, quote:e.quote }))
            // Use full source text, not the model's chosen excerpt, so changed
            // wording of a summary does not recreate a resolved finding.
            const fingerprint = JSON.stringify(evidence.map(e => [e.id,ctx.evidence.find(s => s.id===e.id)!.quote]).sort((a,b) => a.join().localeCompare(b.join())))
            const id = createHash("sha256").update(`${ctx.customerKey}:${signal.kind}:${fingerprint}`).digest("hex").slice(0,32)
            const [noCall] = await tx`select id from sales_watch_items where payload->>'customerKey'=${ctx.customerKey} and payload->>'doNotCall'='true' limit 1`
            const doNotCall = noCallPreference || !!noCall
            const item: WatchItem = {
              id, subjectKey:q.subject_key, subjectType:q.subject_type, subjectId:q.subject_id,
              customerKey:ctx.customerKey, name:ctx.name, stage:ctx.stage, rep:ctx.rep, phone:ctx.phone,
              contactUrl:ctx.contactUrl, dealUrl:ctx.dealUrl, stream:signal.stream,
              background:signal.background, latestUpdate:signal.latestUpdate, callObjective:signal.callObjective, verification:signal.verification,
              kind:signal.kind, severity:signal.severity, summary:signal.summary,
              nextAction:doNotCall ? "Do not call. Inside sales must review the customer's communication preference and use only a permitted channel." : signal.nextAction,
              dueAt:signal.dueAt, confidence:signal.confidence, owner:"Inside sales", routeTo:routeFor(signal.kind),
              evidence, status:"open", snoozedUntil:null, doNotCall,
              updatedAt:new Date().toISOString(), coverage:ctx.coverage,
              callEligible:!doNotCall && (signal.stream==="service" || (!ctx.closed && parsed.outreachDecision==="now")),
            }
            // Stable evidence keeps resolved/snoozed state. New evidence gets a new item.
            await tx`insert into sales_watch_items(id,subject_key,payload) values(${id},${q.subject_key},${tx.json(item)})
              on conflict(id) do update set payload=excluded.payload, subject_key=excluded.subject_key, updated_at=now()`
          }
          // Never auto-resolve an old promise just because a model omitted it.
          // Customer no-call preferences apply to earlier findings too.
          if (parsed.doNotCall) await tx`update sales_watch_items set payload=jsonb_set(payload,'{doNotCall}','true')
            where payload->>'customerKey'=${ctx.customerKey}`
          await tx`update sales_watch_queue set status='done',error=${ctx.coverage.length ? ctx.coverage.join(" ") : null}
            where run_id=${run.id} and subject_key=${q.subject_key}`
        })
      } catch (error) {
        await sql`update sales_watch_items set payload=jsonb_set(payload,'{callEligible}','false') where subject_key=${q.subject_key}`
        // Only fixed diagnostic messages may reach the UI, never provider payloads.
        const failure = error instanceof WatchAnalysisError ? error.message : "Read or storage failed; retry or review coverage."
        await sql`update sales_watch_queue set status='failed',error=${failure}
          where run_id=${run.id} and subject_key=${q.subject_key}`
      }
    }
    const [counts] = await sql`select count(*) filter(where status!='done')::int as remaining,
      count(*) filter(where error is not null)::int as gaps from sales_watch_queue where run_id=${run.id}`
    const [meta] = await sql`select errors from sales_watch_runs where id=${run.id}`
    const errors = readWatchErrors(meta.errors)
    const complete = counts.remaining===0 && counts.gaps===0 && errors.length===0
    await sql`update sales_watch_runs set status=${complete ? "complete" : "partial"},
      finished_at=now(), errors=${sql.json(errors)} where id=${run.id}`
    return { busy:false, ...(await readWatch()) }
  } catch {
    if (runId) await sql`update sales_watch_runs set status='failed',finished_at=now(),
      errors='["Run failed or discovery incomplete. Check credentials, migration, scopes, search limits and runtime logs."]'::jsonb where id=${runId}`
    throw new Error("Sales Watch could not complete. No complete-coverage claim was recorded.")
  } finally {
    await sql`delete from sales_watch_lock where name='worker' and holder=${holder}`
  }
}
