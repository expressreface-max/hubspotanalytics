import { useState } from "react"
import type { PipelineRecord } from "@/lib/sales-watch"
const money=(v:number|null)=>v===null?"Amount not recorded":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(v)
export function WatchInventory({rows,kind,search}:{rows?:PipelineRecord[];kind:"quoted"|"consultations"|"service";search:string}) {
  const [filter,setFilter]=useState("all")
  if(!rows)return <div className="sw-empty"><h3>Inventory not loaded</h3><p>This analysis run has not supplied this inventory. Missing data is not a zero count.</p></div>
  const shown=rows.filter(r=>(kind!=="quoted"||filter==="all"||r.communicationReview?.decision===filter)&&`${r.name} ${r.pipeline} ${r.rep} ${r.status} ${r.summary} ${r.communicationReview?.summary||""} ${r.communicationReview?.reason||""}`.toLowerCase().includes(search.toLowerCase()))
  return <div className="sw-inventory">
    {kind==="quoted" && <div className="sw-quote-filters" role="group" aria-label="Quote communication recommendations">{[["all","All quotes"],["now","Follow up"],["wait","Wait"],["no_contact","Do not contact"],["review","Review first"]].map(([key,label])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label} <span>{key==="all"?rows.length:rows.filter(r=>r.communicationReview?.decision===key).length}</span></button>)}</div>}
    {kind==="consultations" && <div className="sw-notice"><strong>{rows.filter(r=>r.meetingOutcome==="COMPLETED").length} with a recorded completed meeting · {rows.filter(r=>r.meetingOutcome!=="COMPLETED").length} needing visit verification</strong><p>These are current pre-quote stage candidates, not automatically overdue quotes. Verify meeting purpose, visit completion, rescheduling and proposal delivery before outreach.</p></div>}
    <p className="sw-help">{shown.length} of {rows.length} deals shown. One row per deal; associated contacts are not counted as extra deals.</p>
    {!shown.length && <div className="sw-empty"><h3>No matching deals</h3><p>Clear your search{kind==="quoted"?" and choose All quotes":""} to see the full inventory.</p></div>}
    {shown.map(r=><article key={r.id} className="sw-inventory-row">
      <div className="sw-row-top"><h3>{r.name}</h3><strong>{kind==="quoted"?money(r.amount):r.meetingAt?`Consultation: ${r.meetingAt}`:r.stage}</strong></div>
      <div className="sw-meta">{r.pipeline} · {r.stage} · Rep context: {r.rep}</div>
      <p><span className="sw-badge">{r.status}</span></p>{!(kind==="quoted"&&r.communicationReview)&&<p>{r.summary}</p>}
      {kind==="quoted" && (r.communicationReview?<section className="sw-quote-review" aria-label={`Communication assessment for ${r.name}`}>
        <div className="sw-review-heading"><strong>Recent communication</strong><span className={`sw-badge sw-decision-${r.communicationReview.decision}`}>{r.communicationReview.label}</span></div>
        <p>{r.communicationReview.summary}</p>
        <div className="sw-review-columns"><div><h4>Is new communication needed?</h4><p>{r.communicationReview.reason}</p></div><div><h4>Inside-sales next step</h4><p>{r.communicationReview.nextAction}</p></div></div>
        <p className="sw-review-timing"><strong>Timing:</strong> {r.communicationReview.timing}<br/><span>{r.communicationReview.timingBasis}</span></p>
        <details><summary>Evidence & coverage · {r.communicationReview.evidence.length} records</summary><p className="sw-help">{r.communicationReview.coverage} Assessment confidence: {r.communicationReview.confidence}. Reviewed: {r.communicationReview.reviewedAt||"Pending"}.</p>
          {r.communicationReview.evidence.map(e=><div className="sw-evidence" key={e.id}><strong>{e.type} · {e.at}</strong><p className="sw-help">{e.association}</p><blockquote>{e.quote}</blockquote>{e.url&&<a href={e.url} target="_blank" rel="noreferrer">View HubSpot activity on deal ↗</a>}</div>)}
          {!r.communicationReview.evidence.length&&<p>No readable substantive call/note was returned. Open the full CRM record before deciding on outreach.</p>}
        </details>
      </section>:<div className="sw-notice">Communication analysis has not been supplied for this quote. Review its CRM history before outreach.</div>)}
      <div className="sw-meta">Stage entered: {r.enteredAt||"Not recorded"} · Last contact field: {r.lastContactAt||"Not recorded"} · Follow-up: Inside sales</div>
      <div className="sw-record-links">{r.contacts.map((c,i)=>c.url?<a key={i} href={c.url} target="_blank" rel="noreferrer">HubSpot contact: {c.name} ↗</a>:<span key={i}>{c.name}: link unavailable</span>)}
        {!r.contacts.length && <span>No associated customer contact</span>}
        {r.dealUrl && <a href={r.dealUrl} target="_blank" rel="noreferrer">Open deal ↗</a>}
      </div>
    </article>)}
  </div>
}
