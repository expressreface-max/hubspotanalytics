"use client"
import { useEffect, useState } from "react"
import { dailyCalls, isActive, itemStream, scoreItem, staleWatch, KIND_LABEL, type WatchData, type WatchItem } from "@/lib/sales-watch"
import { WatchInventory } from "./sales-watch-inventory"
import "./sales-watch.css"

type Props = {
  initialData?: WatchData
  preview?: boolean
  onRefresh?: () => Promise<WatchData>
  onAction?: (item: WatchItem, action: "resolve" | "snooze" | "reopen", note: string, until?: string) => Promise<WatchData>
}
const date = (value: string | null) => value ? /^\d{4}-\d{2}-\d{2}$/.test(value) ? value+" (date only)" : new Date(value).toLocaleString("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) + " PT" : "Not stated"
const tabs = [
  ["today","Sales: top 10"],["service","Service & customer care"],["quoted","Quoted deals"],["consultations","Awaiting quote review"],["manager","Manager review"],["all","All findings"],
] as const
export function SalesWatchPanel({initialData,preview=false,onRefresh,onAction}:Props) {
  const [data,setData] = useState<WatchData | null>(initialData ?? null)
  const [error,setError] = useState("")
  const [busy,setBusy] = useState(false)
  const [refreshConfirm,setRefreshConfirm] = useState(false)
  const [tab,setTab] = useState("today")
  const [search,setSearch] = useState("")
  const [selected,setSelected] = useState<string | null>(null)
  const [action,setAction] = useState<"resolve"|"snooze"|"reopen">("resolve")
  const [note,setNote] = useState("")
  const [until,setUntil] = useState("")
  const [notice,setNotice] = useState("")
  useEffect(()=>{
    if(selected && window.innerWidth<=1050) document.querySelector(".sw-detail")?.scrollIntoView({behavior:"smooth",block:"start"})
  },[selected])
  async function load() {
    const res = await fetch("/api/hs/sales-manager/watch")
    const body = await res.json()
    if (!res.ok) throw new Error(body.error || "Unable to read watch")
    return body as WatchData
  }
  useEffect(()=> {
    if (initialData) return
    let cancelled = false
    const refresh = () => load().then(d=>{if(!cancelled)setData(d)}).catch(e=>{if(!cancelled)setError(e.message)})
    void refresh()
    const timer = setInterval(refresh,60000)
    return ()=>{cancelled=true;clearInterval(timer)}
  },[initialData])
  async function refresh() {
    setBusy(true);setError("");setRefreshConfirm(false)
    try {
      let next:WatchData
      if(onRefresh) next=await onRefresh()
      else {
        const res=await fetch("/api/hs/sales-manager/watch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"refresh",confirm:true})})
        const body=await res.json()
        if(!res.ok)throw new Error(body.error || "Refresh failed")
        next=body
      }
      setData(next)
      const reviewed=Math.max(0,(next.run?.done ?? 0)-(data?.run?.id===next.run?.id ? data?.run?.done ?? 0 : 0))
      setNotice(preview?"Sample refresh completed. No CRM or AI calls were made.":next.busy?"Analysis is already running. Progress updates automatically; no duplicate run was started.":`Reviewed ${reviewed} additional records. ${Math.max(0,(next.run?.total ?? 0)-(next.run?.done ?? 0))} still need review. Refresh resumes the queue without restarting completed reviews.`)
    } catch(e) {setError(e instanceof Error?e.message:"Refresh failed")}
    finally {setBusy(false)}
  }
  async function save(item:WatchItem) {
    setBusy(true);setError("")
    try {
      const iso=action==="snooze" && until?new Date(until).toISOString():undefined
      if(onAction)setData(await onAction(item,action,note,iso))
      else {
        const res=await fetch("/api/hs/sales-manager/watch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:item.id,action,note,until:iso})})
        const body=await res.json()
        if(!res.ok)throw new Error(body.error || "Could not save disposition")
        setData(await load())
      }
      setNotice(action==="resolve"?"Finding resolved in the inside-sales queue. The CRM deal was not changed.":"Follow-up disposition saved.")
      setSelected(null);setNote("")
    } catch(e) {setError(e instanceof Error?e.message:"Could not save")}
    finally {setBusy(false)}
  }
  if(!data)return <section className="sales-watch"><h2>Inside sales watch</h2><p role={error?"alert":"status"}>{error || "Loading saved analysis and follow-up queues…"}</p>{error && <button onClick={()=>load().then(setData).catch(e=>setError(e.message))}>Retry</button>}</section>
  const active=data.items.filter(i=>isActive(i))
  const calls=dailyCalls(data.items)
  const snapshot=!!data.snapshotAt
  const inventoryTab=tab==="quoted" || tab==="consultations"
  const views:Record<string,WatchItem[]>={
    today:calls,
    all:data.items.filter(i=>i.status!=="resolved"),
    promise:active.filter(i=>i.kind==="promise"),
    manager:active.filter(i=>i.routeTo==="Sales manager" || i.kind==="satisfaction"),
    service:active.filter(i=>itemStream(i)==="service"),
    resolved:data.items.filter(i=>i.status==="resolved"),
  }
  const shown=(views[tab]||[]).filter(i=>`${i.name} ${i.summary} ${i.rep} ${KIND_LABEL[i.kind]}`.toLowerCase().includes(search.toLowerCase()))
  const focus=data.items.find(i=>i.id===selected)
  const run=data.run
  const stale=staleWatch(data)
  const count=(key:string)=>key==="quoted"?data.quoted?.length:key==="consultations"?data.consultations?.length:views[key]?.length
  return <section className="sales-watch" aria-label="Inside sales watch">
    {preview && <div className="sw-preview"><strong>{snapshot?"REAL HUBSPOT DATA · READ-ONLY REPORT":"PREVIEW · SAMPLE DATA"}</strong><span>{snapshot?`Extracted ${date(data.snapshotAt!)} · Not a live feed`:"No live CRM changes or nightly jobs enabled"}</span></div>}
    <header className="sw-header">
      <div><div className="sw-eyebrow">DAILY ACTIONS / CUSTOMER CARE</div><h2>Inside sales watch</h2><p>Know who needs a call, what we promised, and where to step in.</p></div>
      <button className="sw-primary" title={data.readOnly?"Use the production Sales Manager page to run analysis. Preview cannot write to the shared database.":snapshot?"Live refresh requires the approved production integration. This is a read-only report.":!data.enabled?"Sales Watch is not activated for this deployment.":undefined} disabled={snapshot || data.readOnly || busy || !data.enabled} onClick={()=>setRefreshConfirm(!refreshConfirm)}>{data.readOnly?"Preview: read-only":snapshot?"Live refresh not activated":busy?"Refreshing…":"Refresh analysis"}</button>
    </header>
    {refreshConfirm && <div className="sw-confirm" role="region" aria-label="Confirm refresh">
      <strong>{preview?"Refresh sample analysis?":"Run or resume customer analysis now?"}</strong>
      <p>{preview?"This tests the refresh workflow only. No paid calls or customer data are involved.":"This reads CRM communications and uses the configured AI model. It resumes unfinished work, obeys the configured analysis limit, and does not send messages or change deal stages."}</p>
      <button className="sw-primary" onClick={refresh}>Confirm refresh</button><button onClick={()=>setRefreshConfirm(false)}>Cancel</button>
    </div>}
    {data.readOnly && <p className="sw-notice">Saved production analysis is visible here. Run refreshes and save dispositions on the production Sales Manager page; this preview cannot change shared data.</p>}
    {busy && <p className="sw-notice" role="status">Reviewing a bounded batch of HubSpot records. Progress updates while the batch runs; remaining work continues in later runs.</p>}
    {error && <div className="sw-alert" role="alert">{error}</div>}
    {notice && <div className="sw-notice" role="status">{notice}</div>}
    <div className="sw-health">
      <div><strong className={stale?"sw-warning":""}>{snapshot?"Bounded CRM snapshot":!data.enabled?"Not activated":stale?"Analysis needs attention":run?.status==="complete"?"Analysis current":"Partial coverage"}</strong>
        <span>{snapshot?`Report date: ${date(data.snapshotAt!)}`:`Last complete: ${date(data.lastCompleteAt)}`}</span></div>
      <div><strong>{snapshot?`${data.quoted?.length ?? 0} quoted · ${data.serviceInventory?.length ?? 0} service-stage deals`:run?`${run.done} / ${run.total} records reviewed`:"No completed run"}</strong><span>{snapshot?"Nightly execution is not verified or activated":`${run?.failed?`${run.failed} failed · `:""}${run?.status || "Awaiting activation"}`}</span></div>
      <details><summary>Schedule & coverage</summary><p>Configured nightly window: 10:00–13:50 UTC (3:00–6:50 AM PDT / 2:00–5:50 AM PST), when activated in Vercel. Continuations resume pending work; they do not restart completed reviews.</p>
        {!snapshot && <p>Latest inventory discovery: {date(data.inventoryAt||null)}. Each quote shows its own review time; pending assessments are not an all-clear.</p>}
        <p>Scheduled code is not proof of execution. Last-complete time and record counts are the health check. All follow-up accountability stays with inside sales.</p>
        <ul>{data.coverage.map((c,i)=><li key={i}>{c}</li>)}</ul>
      </details>
    </div>
    <div className="sw-stats">
      <button onClick={()=>{setTab("today");setSelected(null)}}><strong>{calls.length}</strong><span>Priority calls today</span></button>
      <button onClick={()=>{setTab("quoted");setSelected(null)}}><strong>{data.quoted?.length ?? "—"}</strong><span>Currently quoted</span></button>
      <button onClick={()=>{setTab("manager");setSelected(null)}}><strong>{views.manager.length}</strong><span>Manager reviews</span></button>
      <button onClick={()=>{setTab("service");setSelected(null)}}><strong>{views.service.length}</strong><span>Service / warranty</span></button>
    </div>
    <div className="sw-work">
      <div className="sw-tabs" role="group" aria-label="Work queues">{tabs.map(([key,label])=><button key={key} aria-label={`${label}, ${count(key)??"not loaded"} records`} aria-pressed={tab===key} onClick={()=>{setTab(key);setSelected(null);setSearch("")}}>{label}<span>{count(key)??"—"}</span></button>)}</div>
      <div className="sw-toolbar"><p>{tab==="today"?"Up to ten evidence-backed sales conversations, separate from service. Inside sales owns the follow-through; verify preferences and newer activity before dialing.":tab==="manager"?"Closure review, communication preferences and record cleanup. Never auto-close.":tab==="service"?"Separate customer-care queue. Includes post-sale requests on completed deals; a service-stage record alone does not prove a complaint.":tab==="quoted"?"Complete returned quoted-stage inventory across pipelines. Last-contact fields may lag actual activity; review legacy records before outreach.":tab==="consultations"?"Current pre-quote stage candidates. Verify that the consultation occurred and a quote is still needed; future or unconfirmed appointments are not overdue quotes.":"All reviewed findings, including sales, service and manager decisions."}</p>
        <label><span className="sw-sr">Search findings</span><input placeholder="Search customer or issue…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
      </div>
      {tab==="today" && <p className="sw-help">{active.length} active findings across the watch. No phone, no-call requests, low-confidence items and closure decisions stay in the other queues.</p>}
      {inventoryTab?<WatchInventory rows={tab==="quoted"?data.quoted:data.consultations} kind={tab as "quoted"|"consultations"} search={search}/>:<div className="sw-grid">
        <div className="sw-list">
          {!shown.length && <div className="sw-empty"><h3>{search?"No matching findings":"Nothing in this queue"}</h3><p>{search?"Try another customer or clear the search.":"Check coverage before treating an empty queue as an all-clear."}</p></div>}
          {shown.map((item,i)=><div key={item.id}><button className={`sw-row ${selected===item.id?"sw-selected":""}`} onClick={()=>{setSelected(item.id);setNote("");setAction(item.status==="resolved"?"reopen":"resolve")}}>
            <span className="sw-rank">{tab==="today"?String(i+1).padStart(2,"0"):"·"}</span>
            <span className="sw-row-body"><span className="sw-row-top"><strong>{item.name}</strong><span className={`sw-badge ${item.severity==="urgent"?"sw-urgent":""}`}>{item.severity}</span></span>
              <span className="sw-summary">{item.summary}</span>
              <span className="sw-meta">{KIND_LABEL[item.kind]} · {item.stage} · Inside sales{item.status==="snoozed"?` · Snoozed to ${date(item.snoozedUntil)}`:""}</span>
              <span className="sw-next">{item.nextAction}</span></span>
            <span className="sw-chevron" aria-hidden="true">›</span>
          </button>{item.contactUrl && <div className="sw-list-contact"><a href={item.contactUrl} target="_blank" rel="noreferrer">HubSpot contact ↗</a>{item.dealUrl && <a href={item.dealUrl} target="_blank" rel="noreferrer">Related deal ↗</a>}</div>}</div>)}
        </div>
        <aside className="sw-detail" aria-label="Finding details">
          {!focus?<div className="sw-empty"><div className="sw-eyebrow">THE NEXT BEST CONVERSATION</div><h3>Select a customer</h3><p>See the source communication, the promise or concern, and a concrete next step.</p><p>Inside sales owns follow-up. Reps, managers and customer service provide support.</p></div>:<>
            <div className="sw-detail-head"><span className="sw-eyebrow">{KIND_LABEL[focus.kind]}</span><button aria-label="Close finding" onClick={()=>setSelected(null)}>×</button></div>
            <h3>{focus.name}</h3><p>{focus.summary}</p>
            <div className="sw-record-links">{focus.contactUrl?<a href={focus.contactUrl} target="_blank" rel="noreferrer">Open HubSpot contact ↗</a>:<span>Contact link not supplied by this run</span>}{focus.dealUrl && <a href={focus.dealUrl} target="_blank" rel="noreferrer">Open related deal ↗</a>}</div>
            {focus.background && <><h4>Customer & project context</h4><p>{focus.background}</p></>}
            {focus.latestUpdate && <><h4>Latest known development</h4><p>{focus.latestUpdate}</p></>}
            {focus.callObjective && <><h4>Desired outcome</h4><p>{focus.callObjective}</p></>}
            {focus.verification && <div className="sw-notice"><strong>Verify before acting</strong><p>{focus.verification}</p></div>}
            <dl className="sw-facts"><dt>Follow-up owner</dt><dd>Inside sales</dd><dt>Coordinate with</dt><dd>{focus.routeTo}</dd><dt>Sales rep / context</dt><dd>{focus.rep}</dd><dt>Phone</dt><dd>{focus.doNotCall?"Do not call":focus.phone || "Verify contact in CRM"}</dd><dt>Customer deadline</dt><dd>{focus.dueAt?date(focus.dueAt):"Confirm from dated context above"}</dd><dt>Confidence</dt><dd>{focus.confidence}</dd><dt>{snapshot?"Report priority":"Priority score"}</dt><dd>{snapshot?focus.reportRank?`Sales call ${focus.reportRank} of 10 · reviewed recommendation`:"Separate service / manager worklist":`${scoreItem(focus)} · urgency + issue type + overdue time`}</dd></dl>
            {focus.doNotCall && <div className="sw-alert">Do not call. Review the customer's communication preference before any outreach.</div>}
            <h4>Recommended next step</h4><p className="sw-action-text">{focus.nextAction}</p>
            {focus.kind==="close_lost" && <div className="sw-notice">Manager decision only. Resolving this finding does not close the HubSpot deal.</div>}
            <h4>Source communications</h4>{focus.evidence.map((e,i)=><div className="sw-evidence" key={`${e.id}-${i}`}><div>{e.type} · {date(e.at)}</div><blockquote>“{e.quote}”</blockquote>
              {e.url && <a href={e.url} target="_blank" rel="noreferrer">Open CRM record ↗</a>}
            </div>)}
            {focus.coverage.length>0 && <div className="sw-alert">{focus.coverage.join(" ")}</div>}
            {focus.lastDisposition && <div className="sw-evidence"><h4>Last team update</h4><div>{focus.lastDisposition.action} · {date(focus.lastDisposition.at)} · {focus.lastDisposition.actor}</div><p>{focus.lastDisposition.note}</p></div>}
            {snapshot || data.readOnly?<div className="sw-notice">Read-only preview. Use the production Sales Manager page to save dispositions, or record the call outcome in HubSpot.</div>:<><h4>Record the outcome</h4><p className="sw-help">Resolve the issue, not just the call attempt. Snooze unfinished follow-up with a due time.</p>
            <form onSubmit={e=>{e.preventDefault();void save(focus)}}>
              <label>Disposition<select value={action} onChange={e=>setAction(e.target.value as typeof action)}><option value="resolve">Resolve finding</option><option value="snooze">Snooze / follow up later</option><option value="reopen">Reopen finding</option></select></label>
              {action==="snooze" && <label>Next follow-up (your browser's local time)<input type="datetime-local" required value={until} onChange={e=>setUntil(e.target.value)}/></label>}
              <label>Outcome / follow-up note<textarea required minLength={5} maxLength={2000} placeholder="What was confirmed, and what happens next?" value={note} onChange={e=>setNote(e.target.value)}/></label>
              <button className="sw-primary" disabled={busy || note.trim().length<5}>Save disposition</button>
            </form></>}
          </>}
        </aside>
      </div>}
      {tab==="service" && data.serviceInventory && <details className="sw-service-inventory"><summary>All {data.serviceInventory.length} punch-list / warranty-stage deals</summary><WatchInventory rows={data.serviceInventory} kind="service" search={search}/></details>}
    </div>
  </section>
}
