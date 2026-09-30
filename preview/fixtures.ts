import type { WatchData, WatchItem, WatchKind } from "../lib/sales-watch"
const now = Date.now()
const ago = (hours:number)=>new Date(now-hours*3600000).toISOString()
// FICTIONAL EXAMPLES ONLY. No copied customer names, phones or communications.
const examples: [string,WatchKind,string,string,string,string][] = [
  ["Avery Morgan","displeasure","Called twice about the delayed installation; no response is recorded.","Call to acknowledge the delay and agree on a verified update time.","I called twice this week and still don't know when the installation will happen.","Scheduled"],
  ["Jordan Ellis","remake","A replacement door was promised, but the delivery date is still unconfirmed.","Confirm the remake status with service, then update the customer.","The replacement door still hasn't arrived. Can someone confirm the delivery date?","Closed won"],
  ["Taylor Brooks","promise","A revised quote was promised yesterday; delivery is not confirmed.","Check the revision with the rep and call with a delivery time.","I'll have the revised quote to you by tomorrow afternoon.","Quoted"],
  ["Casey Lane","warranty","Customer reports a loose hinge after installation and asks about coverage.","Acknowledge the issue and arrange a service review; do not promise coverage.","The hinge has come loose. Is this covered under the warranty?","Closed won"],
  ["Riley Bennett","follow_up","Customer is ready to proceed and needs help with the next step.","Call to answer the deposit question and confirm the next step.","We're ready to move forward. Can someone explain the deposit and next steps?","Quoted"],
  ["Sam Parker","promise","Customer was promised a callback after the measurement visit.","Call with a confirmed answer on the measurement question.","Can you call me after the measure visit so we can confirm the details?","Measurement"],
  ["Jamie Quinn","service","Customer asks to schedule a service visit for drawer alignment.","Coordinate an appointment with customer service.","The left drawer catches. Could someone come out to adjust it?","Closed won"],
  ["Cameron Wells","follow_up","Consultation is complete; customer is waiting on a quote timeline.","Confirm quote timing with the rep and update the customer.","Thanks for visiting yesterday. When should we expect the quote?","Consultation"],
  ["Drew Harper","follow_up","Unanswered question about countertop options is blocking a decision.","Call to clarify the options and document the preferred material.","Before we decide, can someone explain the countertop options again?","Quoted"],
  ["Alex Rowan","promise","A finish sample was promised; receipt is not confirmed.","Confirm shipment and whether the sample arrived.","I'll send the sample this week so you can see it in your own lighting.","Quoted"],
  ["Robin Hayes","satisfaction","Customer praised the installation team and the finished kitchen.","Thank the customer and share the feedback with the manager.","The installers were wonderful and the kitchen looks fantastic. Thank you!","Closed won"],
  ["Skyler Reed","follow_up","Customer has a budget question and requested a callback.","Call to clarify scope and discuss available options.","Can someone call me to explain what's included in that total?","Quoted"],
  ["Rowan Blair","close_lost","Customer explicitly selected another contractor; deal remains open.","Sales manager: verify the customer decision and record the loss reason.","We decided to go with another contractor. Please cancel our quote.","Quoted"],
  ["Quinn Avery","close_lost","Customer cancelled the project after selling the home.","Sales manager: confirm cancellation and decide whether to close lost.","We sold the house and won't be doing this project. Please cancel it.","Appointment"],
  ["Morgan Vale","follow_up","Customer requested email only; do not put this contact on a call list.","Inside sales: review the request and respond only through the permitted channel.","Please do not call me. Email is the only way I want to communicate.","New lead"],
  ["Peyton Gray","service","Service concern is visible, but some communication history is unreadable.","Review the CRM record and recover the missing context before contacting.","I sent photos of the issue. Did anyone receive them?","Closed won"],
]
export function fixtureData():WatchData {
  const items:WatchItem[]=examples.map(([name,kind,summary,nextAction,quote,stage],i)=>({
    id:`sample-${i}`,subjectKey:`deals:sample-${i}`,subjectType:"deals",subjectId:`sample-${i}`,customerKey:`sample-customer-${i}`,name,kind,summary,nextAction,stage,
    rep:i%2?"Field rep B":"Field rep A",phone:i===15?null:`+1 916 555 ${String(100+i).padStart(4,"0")}`,
    stream:kind==="close_lost"?"review":["service","remake","warranty","displeasure","satisfaction"].includes(kind)?"service":"sales",
    severity:i<2?"urgent":i<7?"high":"normal",owner:"Inside sales",
    routeTo:["close_lost","displeasure"].includes(kind)?"Sales manager":["remake","service","warranty"].includes(kind)?"Customer service":"Inside sales",
    dueAt:kind==="promise"?ago(16):null,confidence:i===15?"low":"high",status:"open",snoozedUntil:null,doNotCall:i===14,updatedAt:ago(3),
    evidence:[{id:`sample-email-${i}`,type:i%3?"email":"call note",at:ago(20+i),quote,url:null}],
    coverage:i===15?["Some email bodies could not be read. Do not infer inactivity."]:[],
  }))
  // Another finding for the same customer: the top ten must not duplicate the call.
  items.push({...items[1],id:"sample-duplicate",kind:"promise",summary:"Customer also requested a tracking update on the replacement.",nextAction:"Include the tracking update in the same customer call."})
  const quoted=items.filter(i=>i.stage==="Quoted").map((i,n)=>({
    id:i.subjectId,name:i.name,stage:i.stage,pipeline:"Synthetic sales pipeline",amount:12000+n*100,inventoryKind:"quoted" as const,
    enteredAt:ago(240),lastContactAt:ago(12),rep:i.rep,contactUrl:null,dealUrl:null,contacts:[],
    summary:i.summary,status:"Synthetic quoted-stage record",
    communicationReview:{decision:(["now","wait","no_contact","review"] as const)[n%4],label:["Follow up","Wait","Do not contact","Review first"][n%4],
      summary:i.summary,reason:"Synthetic evidence-backed decision for UI testing.",nextAction:i.nextAction,
      timing:"Verify agreed customer timing",timingBasis:"Illustrative scenario, not a real customer agreement.",
      reviewedAt:ago(3),confidence:i.confidence,coverage:"Synthetic test data only.",evidence:i.evidence.map(e=>({...e,association:"Synthetic record"}))},
  }))
  return {items,quoted,consultations:[],serviceInventory:[],inventoryAt:ago(4),enabled:true,lastCompleteAt:ago(3),run:{id:"sample-run",status:"complete",startedAt:ago(4),finishedAt:ago(3),total:84,done:84,failed:0,errors:[],trigger:"nightly",discoveryComplete:true},coverage:[
    "This preview uses fictional customer records and illustrative run counts. It does not verify production execution.",
    "Live coverage is limited to communications logged in HubSpot; missing scopes, unlogged calls and external inboxes are disclosed as gaps.",
    "No CRM record or stage is changed by resolving a finding.",
  ]}
}
