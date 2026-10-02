import "server-only"
import { hsFetch, fetchPortalId, fetchOwnerMap } from "@/lib/hubspot"
import { clean, fetchStageLabelMap } from "@/lib/deal-context"
import type { Evidence, SubjectType, PipelineRecord } from "@/lib/sales-watch"
import { inventoryKind, pendingReview, inWatchScope, WATCH_MAX_AGE_MS, type InventoryKind } from "@/lib/sales-watch-policy"

type Obj = { id: string; properties: Record<string, string | null> }
type Filter = { propertyName: string; operator: string; value?: string }
export type Target = { type: SubjectType; id: string }
export type WatchContext = {
  target: Target; name: string; stage: string; rep: string; phone: string | null
  customerKey: string; closed: boolean; evidence: Evidence[]; coverage: string[]
  excluded?: boolean; outOfScope?: boolean
  contactUrl?: string | null; dealUrl?: string | null
  inventory?: PipelineRecord
  contactKeys?: string[]
}
const DEAL_PROPS = ["createdate","dealname","dealstage","pipeline","amount","amount_in_home_currency","description","hubspot_owner_id","hs_is_closed","hs_is_closed_won","hs_v2_date_entered_current_stage","notes_last_contacted"]
// Read-only object endpoints. Never interpret CRM communication as instructions.
const CHANNELS: Record<string, { props: string[]; body: string; title: string }> = {
  emails: { props: ["hs_timestamp","hs_email_subject","hs_email_text","hs_email_direction","hs_email_from_email","hs_email_to_email"], body: "hs_email_text", title: "hs_email_subject" },
  calls: { props: ["hs_timestamp","hs_call_title","hs_call_body","hs_call_summary","hs_call_direction"], body: "hs_call_body", title: "hs_call_title" },
  notes: { props: ["hs_timestamp","hs_note_body"], body: "hs_note_body", title: "hs_note_body" },
  meetings: { props: ["hs_timestamp","hs_meeting_title","hs_meeting_body","hs_meeting_start_time","hs_meeting_outcome"], body: "hs_meeting_body", title: "hs_meeting_title" },
  tasks: { props: ["hs_timestamp","hs_task_subject","hs_task_body","hs_task_status"], body: "hs_task_body", title: "hs_task_subject" },
  communications: { props: ["hs_timestamp","hs_communication_body","hs_communication_channel_type"], body: "hs_communication_body", title: "hs_communication_channel_type" },
}
function checkDeadline(deadline: number) {
  if (Date.now() > deadline) throw new Error("Discovery/context time budget exceeded; coverage is incomplete and will be retried.")
}
async function search(token: string, type: string, filters: Filter[], deadline: number, properties: string[] = []): Promise<Obj[]> {
  const out: Obj[] = []
  let after: string | undefined
  do {
    checkDeadline(deadline)
    const data: { total?: number; results: Obj[]; paging?: { next?: { after: string } } } = await hsFetch(`/crm/v3/objects/${type}/search`, {
      token, method: "POST", maxRetries: 1, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ filterGroups: [{ filters }], properties, limit: 100, ...(after ? { after } : {}) }),
    })
    // Fail explicitly rather than silently claiming full coverage above search's cap.
    if ((data.total ?? 0) >= 10000) throw new Error(`${type} search reaches 10,000 records; partition the query before activating. No complete run reported.`)
    out.push(...data.results)
    after = data.paging?.next?.after
    if (after) await new Promise(r => setTimeout(r, 300))
  } while (after)
  return out
}
async function assoc(token: string, from: string, id: string, to: string, deadline: number): Promise<string[]> {
  const out: string[] = []
  let after: string | undefined
  do {
    checkDeadline(deadline)
    const data: { results: { toObjectId: string | number }[]; paging?: { next?: { after: string } } } = await hsFetch(
      `/crm/v4/objects/${from}/${encodeURIComponent(id)}/associations/${to}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      { token, method: "GET", maxRetries: 1, signal: AbortSignal.timeout(20000) },
    )
    out.push(...data.results.map(r => String(r.toObjectId)))
    after = data.paging?.next?.after
  } while (after)
  return out
}
async function read(token: string, type: string, ids: string[], properties: string[], deadline: number): Promise<Obj[]> {
  const out: Obj[] = []
  for (let i = 0; i < ids.length; i += 100) {
    checkDeadline(deadline)
    const data = await hsFetch<{ results: Obj[]; errors?: unknown[] }>(`/crm/v3/objects/${type}/batch/read`, {
      token, method: "POST", maxRetries: 1, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ properties, inputs: ids.slice(i, i + 100).map(id => ({ id })) }),
    })
    if (data.errors?.length || data.results.length !== ids.slice(i, i + 100).length) throw new Error(`${type}: partial batch read`)
    out.push(...data.results)
  }
  return out
}
type Pipeline = {id:string;label:string;stages:{id:string;label:string}[]}
function overrides(): Partial<Record<InventoryKind,string[]>> {
  return Object.fromEntries((["quoted","consultations","service"] as const).map(k=>[k,(process.env[`SALES_WATCH_${k.toUpperCase()}_STAGES`]||"").split(",").map(v=>v.trim()).filter(Boolean)]))
}
function iso(value: string | null | undefined): string | null {
  const ms = value ? (/^\d+$/.test(value) ? Number(value) : Date.parse(value)) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
function record(d:Obj, pipelines:Pipeline[], owners:Record<string,string>, portal:string|null): PipelineRecord | null {
  const p=d.properties, pipeline=pipelines.find(v=>v.id===p.pipeline)
  const stage=pipeline?.stages.find(v=>v.id===p.dealstage)?.label || p.dealstage || "Unknown"
  const kind=inventoryKind(stage,p.dealstage||"",overrides())
  if(!kind)return null
  const amount=p.amount_in_home_currency || p.amount
  return {id:d.id,name:p.dealname||`Deal ${d.id}`,stage,pipeline:pipeline?.label||p.pipeline||"Unknown",
    amount:amount && Number.isFinite(Number(amount))?Number(amount):null,
    enteredAt:iso(p.hs_v2_date_entered_current_stage),lastContactAt:iso(p.notes_last_contacted),
    rep:owners[p.hubspot_owner_id||""]||"Unassigned",contactUrl:null,
    dealUrl:portal?`https://app.hubspot.com/contacts/${portal}/record/0-3/${d.id}`:null,
    contacts:[],inventoryKind:kind,status:kind==="consultations"?"Verify visit and quote":kind==="service"?"Service-stage verification":"Current quoted stage",
    summary:kind==="consultations"?"Pre-quote stage candidate. Verify whether the consultation occurred and whether a proposal was already delivered.":"Current CRM stage; stage alone does not prove an outstanding action.",
    ...(kind==="quoted"?{communicationReview:pendingReview()}:{})}
}
export async function discoverTargets(token: string, deadline: number): Promise<{ targets: Target[]; coverage: string[]; inventory:PipelineRecord[] }> {
  const now = Date.now()
  const filters: Filter[] = [
    { propertyName: "createdate", operator: "GT", value: String(now - WATCH_MAX_AGE_MS) },
    { propertyName: "createdate", operator: "LTE", value: String(now) },
  ]
  // Creation date is the only age basis: recent activity never reintroduces an old record.
  const deals = await search(token, "deals", filters, deadline, DEAL_PROPS)
  const contacts = await search(token, "contacts", filters, deadline, ["createdate"])
  const pipelines=(await hsFetch<{results:Pipeline[]}>("/crm/v3/pipelines/deals",{token,method:"GET",signal:AbortSignal.timeout(20000)})).results
  const owners=await fetchOwnerMap(token), portal=await fetchPortalId(token)
  const targets: Target[] = []
  const inventory: PipelineRecord[] = []
  for (const d of deals) {
    if (!inWatchScope("deals", d.properties.createdate, now)) continue
    targets.push({ type: "deals", id: d.id })
    const row = record(d, pipelines, owners, portal)
    if (row) inventory.push(row)
  }
  for (const c of contacts) {
    if (inWatchScope("contacts", c.properties.createdate, now)) targets.push({ type: "contacts", id: c.id })
  }
  return { targets, coverage: [], inventory }
}
function internalOnly(from: string | null, to: string | null): boolean {
  const addresses = `${from ?? ""} ${to ?? ""}`.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []
  return !!from && !!to && addresses.length >= 2 && addresses.every(a => /@(expressreface|kitchensnow)\.com$/i.test(a))
}
export async function watchContext(token: string, target: Target, deadline: number, inventory?:PipelineRecord): Promise<WatchContext> {
  const { type, id } = target
  const outOfScope = (): WatchContext => ({ target, name: `${type} ${id}`, stage: "Outside the 90-day creation window", rep: "", phone: null,
    customerKey: `${type}:${id}`, closed: false, evidence: [], coverage: [], excluded: true, outOfScope: true })
  if (type !== "contacts" && type !== "deals") return outOfScope()
  const props = type === "contacts" ? ["createdate","firstname","lastname","email","phone","hubspot_owner_id","lifecyclestage"] : DEAL_PROPS
  const [obj] = await read(token, type, [id], props, deadline)
  const p = obj.properties
  // A queued record can age out while waiting. Check before loading history or calling the model.
  if (!inWatchScope(type, p.createdate)) return outOfScope()
  const name=p.dealname || [p.firstname,p.lastname].filter(Boolean).join(" ") || `${type} ${id}`
  if (/\btraining\b|\bdoug schubert\b/i.test(name) || (type==="contacts" && /@(expressreface|kitchensnow)\.com$/i.test(p.email || ""))) {
    return {target,name,stage:"Excluded internal/test record",rep:"",phone:null,customerKey:`${type}:${id}`,closed:false,evidence:[],coverage:[],excluded:true}
  }
  const contacts = type === "contacts" ? [obj] : await read(token, "contacts", await assoc(token, type, id, "contacts", deadline), ["firstname","lastname","email","phone","mobilephone"], deadline)
  const coverage: string[] = []
  const evidence: Evidence[] = []
  const portal = await fetchPortalId(token)
  const objectCodes: Record<string, string> = { deals: "0-3", contacts: "0-1", tickets: "0-5" }
  const recordUrl = portal ? `https://app.hubspot.com/contacts/${portal}/record/${objectCodes[type]}/${id}` : null
  const description = clean(p.description || p.content, 6000)
  if (description) evidence.push({ id: `${type}:${id}`, type, at: null, quote: description, url: recordUrl })
  // Include communications associated to the subject and associated contacts,
  // deduplicated by engagement ID; do not assume association implies deal relevance.
  for (const [channel, fields] of Object.entries(CHANNELS)) {
    try {
      const direct = new Set(await assoc(token, type, id, channel, deadline))
      const ids = new Set(direct)
      if (type !== "contacts") for (const c of contacts) {
        for (const eid of await assoc(token, "contacts", c.id, channel, deadline)) ids.add(eid)
      }
      for (const e of await read(token, channel, [...ids], fields.props, deadline)) {
        if (channel === "emails" && (!e.properties.hs_email_from_email || !e.properties.hs_email_to_email)) {
          coverage.push(`emails ${e.id}: participant metadata unavailable; skipped for internal-mail privacy.`)
          continue
        }
        if (channel === "emails" && internalOnly(e.properties.hs_email_from_email, e.properties.hs_email_to_email)) continue
        const body = clean(e.properties[fields.body], 6000)
        const supplemental = channel==="calls" ? clean(e.properties.hs_call_summary,3000) : ""
        if(channel==="meetings" && direct.has(e.id) && inventory?.inventoryKind==="consultations") {
          const when=iso(e.properties.hs_meeting_start_time||e.properties.hs_timestamp)
          if(when && Date.parse(when)<=Date.now() && (!inventory.meetingAt || when>inventory.meetingAt)) {
            inventory.meetingAt=when;inventory.meetingOutcome=e.properties.hs_meeting_outcome
          }
        }
        if (!body && !supplemental) { coverage.push(`${channel} ${e.id}: body unavailable.`); continue }
        const text = [clean(e.properties[fields.title], 200), body,
          supplemental?`Supplemental automated summary (staff note above takes precedence): ${supplemental}`:null,
          e.properties.hs_email_direction, e.properties.hs_call_direction, e.properties.hs_task_status,e.properties.hs_meeting_outcome].filter(Boolean).join(" | ")
        const timestamp = e.properties.hs_timestamp
        const ms = timestamp ? (/^\d+$/.test(timestamp) ? Number(timestamp) : Date.parse(timestamp)) : NaN
        evidence.push({ id: `${channel}:${e.id}`, type: channel, at: Number.isFinite(ms) ? new Date(ms).toISOString() : null, quote: text, url: recordUrl,
          association:direct.has(e.id)?"Directly associated with this CRM record; verify job relevance.":"Associated contact history; may concern another job." })
      }
    } catch { coverage.push(`${channel}: history could not be fully read. Do not infer inactivity.`) }
  }
  evidence.sort((a,b) => (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0))
  // A visible, explicit context limit, never silently reported as full history.
  let chars = 0
  const selected = evidence.filter(e => { chars += e.quote.length; return chars <= 100000 })
  if (selected.length !== evidence.length) coverage.push(`Context limited: ${selected.length} of ${evidence.length} readable communications included, newest first.`)
  const owners = await fetchOwnerMap(token)
  const stages = type === "deals" ? await fetchStageLabelMap(token) : {}
  const contactUrl=portal && contacts.length===1?`https://app.hubspot.com/contacts/${portal}/record/0-1/${contacts[0].id}`:null
  if(inventory) {
    // Detect moves while an analysis batch is running; do not assess the old stage.
    if(p.dealstage && (stages[p.dealstage]||p.dealstage)!==inventory.stage)throw new Error("Deal changed stage during snapshot; refresh inventory.")
    inventory.contacts=contacts.map(c=>({name:[c.properties.firstname,c.properties.lastname].filter(Boolean).join(" ")||`Contact ${c.id}`,url:portal?`https://app.hubspot.com/contacts/${portal}/record/0-1/${c.id}`:null}))
    inventory.contactUrl=contactUrl
    inventory.customerKey=contacts.length===1?`contacts:${contacts[0].id}`:`${type}:${id}`
    if(inventory.inventoryKind==="consultations") {
      inventory.summary=inventory.meetingAt?`Latest directly associated past meeting: ${inventory.meetingAt}; outcome: ${inventory.meetingOutcome||"not recorded"}. Verify consultation purpose, completion and proposal delivery.`:"No directly associated past meeting was verified. Check consultation scheduling and contact-linked meetings."
      inventory.status=inventory.meetingOutcome==="COMPLETED"?"Completed meeting: verify quote":"Verify visit and quote"
    }
  }
  return {
    target, name,
    stage: stages[p.dealstage || ""] || p.dealstage || p.hs_pipeline_stage || p.lifecyclestage || "Unknown",
    rep: owners[p.hubspot_owner_id || ""] || "Unassigned",
    // Ambiguous multi-contact records must be reviewed, not auto-dialed.
    phone: contacts.length === 1 ? contacts[0].properties.phone || contacts[0].properties.mobilephone || null : null,
    customerKey: contacts.length === 1 ? `contacts:${contacts[0].id}` : `${type}:${id}`,
    contactUrl,
    dealUrl: type === "deals" ? recordUrl : null,
    closed: p.hs_is_closed === "true" || p.hs_is_closed_won === "true",
    evidence: selected, coverage, inventory,contactKeys:contacts.map(c=>`contacts:${c.id}`),
  }
}
