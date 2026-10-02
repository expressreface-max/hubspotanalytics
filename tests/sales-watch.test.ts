import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { dailyCalls,isActive,itemStream,scoreItem,triage,pacificDate,staleWatch,canStartNightlyWatch } from "../lib/sales-watch"
import { verifiedSignals,routeFor } from "../lib/sales-watch-analysis"
import { fixtureData } from "../preview/fixtures"
import type { WatchContext } from "../lib/sales-watch-source"
import { inventoryKind, pendingReview, eligibleForCall, inWatchScope, WATCH_MAX_AGE_MS } from "../lib/sales-watch-policy"

const seed=fixtureData()
test("watch scope uses a strict 90-day creation window for contacts and deals only",()=>{
  const now=Date.parse("2026-10-02T12:00:00Z")
  for (const type of ["contacts","deals"]) {
    assert.equal(inWatchScope(type,new Date(now).toISOString(),now),true)
    assert.equal(inWatchScope(type,new Date(now-WATCH_MAX_AGE_MS+1).toISOString(),now),true)
    assert.equal(inWatchScope(type,String(now-86400000),now),true)
    assert.equal(inWatchScope(type,new Date(now-WATCH_MAX_AGE_MS).toISOString(),now),false)
    assert.equal(inWatchScope(type,new Date(now-WATCH_MAX_AGE_MS-1).toISOString(),now),false)
    assert.equal(inWatchScope(type,new Date(now+1).toISOString(),now),false)
    for (const invalid of [null,undefined,"","not-a-date"]) assert.equal(inWatchScope(type,invalid,now),false)
  }
  for (const type of ["tickets","emails","calls"]) assert.equal(inWatchScope(type,new Date(now).toISOString(),now),false)
})
test("nightly scans start at 00:15 Pacific in summer, winter and DST transition days",()=>{
  for (const midnight of [
    "2026-10-02T07:00:00Z", "2026-12-02T08:00:00Z",
    "2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z",
    "2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z",
  ]) {
    const at=Date.parse(midnight)
    assert.equal(canStartNightlyWatch(new Date(at)),false)
    assert.equal(canStartNightlyWatch(new Date(at+15*60000-1)),false)
    assert.equal(canStartNightlyWatch(new Date(at+15*60000)),true)
    assert.equal(canStartNightlyWatch(new Date(at+20*60000)),true,"A later tick recovers a missed kickoff")
    assert.equal(canStartNightlyWatch(new Date(at+12*3600000)),true)
  }
})
test("cron wakes every five minutes without changing other report schedules",async()=>{
  const config=JSON.parse(await readFile(new URL("../vercel.json",import.meta.url),"utf8"))
  assert.deepEqual(config.crons,[
    {path:"/api/cron/sales-watch",schedule:"*/5 * * * *"},
    {path:"/api/cron/sales-manager",schedule:"1 7 * * *"},
    {path:"/api/cron/open-quotes-scan",schedule:"20 7 * * *"},
    {path:"/api/cron/reapi-enrich",schedule:"30 7 * * *"},
  ])
})
test("top ten is capped at ten but other queues retain all findings",()=>{
  const many=Array.from({length:20},(_,i)=>({...seed.items[4],id:`sales-${i}`,customerKey:`sales-${i}`}))
  assert.equal(dailyCalls(many).length,10)
  assert.equal(seed.items.length,17)
})
test("same customer has only one prioritized call",()=>{
  const calls=dailyCalls(seed.items)
  assert.equal(new Set(calls.map(c=>c.customerKey)).size,calls.length)
})
test("do-not-call, no phone, low confidence and lost-review are excluded",()=>{
  for(const c of dailyCalls(seed.items)){
    assert.equal(c.doNotCall,false)
    assert.ok(c.phone)
    assert.notEqual(c.confidence,"low")
    assert.notEqual(c.kind,"close_lost")
  }
})
test("urgent dissatisfaction and remakes lead the separate service queue",()=>{
  const calls=dailyCalls(seed.items,Date.now(),"service")
  assert.equal(calls[0].kind,"displeasure")
  assert.equal(calls[1].kind,"remake")
})
test("overdue promises get an explicit score boost",()=>{
  const item=seed.items[2]
  assert.ok(scoreItem(item)>scoreItem({...item,dueAt:null}))
})
test("ranking is deterministic regardless of source row order",()=>{
  assert.deepEqual(dailyCalls(seed.items).map(i=>i.id),dailyCalls([...seed.items].reverse()).map(i=>i.id))
})
test("closed-won service findings remain actionable",()=>{
  assert.ok(dailyCalls(seed.items,Date.now(),"service").some(i=>i.stage==="Closed won" && i.kind==="remake"))
})
test("service promises and positive feedback never enter the sales top ten",()=>{
  assert.ok(dailyCalls(seed.items).every(i=>itemStream(i)==="sales"))
  const item={...seed.items[4],kind:"promise" as const,stream:"service" as const}
  assert.equal(dailyCalls([item]).length,0)
  assert.equal(dailyCalls([item],Date.now(),"service").length,1)
})
test("a no-call preference on any finding suppresses that customer across streams",()=>{
  const allowed={...seed.items[4],customerKey:"same"}
  const blocked={...seed.items[0],customerKey:"same",doNotCall:true}
  assert.equal(dailyCalls([allowed,blocked]).length,0)
})
test("inside sales owns every finding, not the field rep",()=>{
  assert.ok(seed.items.every(i=>i.owner==="Inside sales"))
  assert.equal(routeFor("close_lost"),"Sales manager")
  assert.equal(routeFor("warranty"),"Customer service")
})
test("resolved findings leave active queues and can be reopened",()=>{
  const item=triage(seed.items[0],"resolve")
  assert.equal(isActive(item),false)
  assert.equal(isActive(triage(item,"reopen")),true)
})
test("snoozed work returns automatically at its due time",()=>{
  const future=new Date(Date.now()+86400000).toISOString()
  const item=triage(seed.items[0],"snooze",future)
  assert.equal(isActive(item),false)
  assert.equal(isActive(item,Date.now()+2*86400000),true)
})
test("invalid snooze dates are rejected",()=>{
  assert.throws(()=>triage(seed.items[0],"snooze","garbage"))
  assert.throws(()=>triage(seed.items[0],"snooze","2020-01-01"))
})
test("Pacific calendar key handles DST and UTC midnight correctly",()=>{
  assert.equal(pacificDate(new Date("2026-09-30T06:00:00Z")),"2026-09-29")
  assert.equal(pacificDate(new Date("2026-12-01T07:30:00Z")),"2026-11-30")
})
test("missing or old complete run is stale even if partial data is fresh",()=>{
  assert.equal(staleWatch({...seed,lastCompleteAt:null}),true)
  assert.equal(staleWatch({...seed,lastCompleteAt:new Date(Date.now()-40*3600000).toISOString()}),true)
  assert.equal(staleWatch(seed),false)
})
const ctx:WatchContext={
  target:{type:"deals",id:"12"},name:"Synthetic deal",stage:"Quoted",rep:"Rep",
  phone:"5550100",customerKey:"contact:12",closed:false,coverage:[],
  evidence:[{id:"emails:21",type:"emails",at:"2026-09-29T20:00:00Z",quote:"We decided to use another contractor. Please cancel our quote.",url:null}],
}
const output={doNotCall:false,signals:[{kind:"close_lost",severity:"normal",summary:"Customer chose another contractor",nextAction:"Manager to review cancellation",dueAt:null,confidence:"high",evidence:[{id:"emails:21",quote:"We decided to use another contractor."}]}]}
test("literal evidence is accepted",()=>assert.equal(verifiedSignals(output,ctx).signals.length,1))
test("hallucinated evidence ID is rejected",()=>{
  const bad=structuredClone(output);bad.signals[0].evidence[0].id="madeup"
  assert.throws(()=>verifiedSignals(bad,ctx))
})
test("paraphrased or fabricated quotations are rejected",()=>{
  const bad=structuredClone(output);bad.signals[0].evidence[0].quote="Customer definitely hated everything."
  assert.throws(()=>verifiedSignals(bad,ctx))
})
test("closed-lost recommendations are blocked for closed deals",()=>assert.throws(()=>verifiedSignals(output,{...ctx,closed:true})))
test("closed-lost recommendations are blocked for contacts",()=>assert.throws(()=>verifiedSignals(output,{...ctx,target:{type:"contacts",id:"12"}})))
test("incomplete context blocks lost recommendations",()=>assert.throws(()=>verifiedSignals(output,{...ctx,coverage:["Unreadable email history"]})))
test("other recommendations from partial context cannot reach call queue confidence",()=>{
  const follow=structuredClone(output);follow.signals[0].kind="follow_up"
  assert.equal(verifiedSignals(follow,{...ctx,coverage:["Missing channel"]}).signals[0].confidence,"low")
})
test("empty findings are supported without invented work",()=>assert.equal(verifiedSignals({doNotCall:false,signals:[]},ctx).signals.length,0))
test("malformed model output and invalid dates fail schema validation",()=>{
  assert.throws(()=>verifiedSignals({signals:"something"},ctx))
  const bad=structuredClone(output) as any;bad.signals[0].dueAt="soon"
  assert.throws(()=>verifiedSignals(bad,ctx))
})
test("inventory stage classification separates service, quoted and pre-quote candidates",()=>{
  assert.equal(inventoryKind("Quoted","1"),"quoted")
  assert.equal(inventoryKind("Consultation scheduled","2"),"consultations")
  assert.equal(inventoryKind("Punch List","3"),"service")
  assert.equal(inventoryKind("Warranty Processing","4"),"service")
  assert.equal(inventoryKind("Warranty Completed","5"),null)
  assert.equal(inventoryKind("Quote accepted","6"),null)
  assert.equal(inventoryKind("Custom portal label","7",{quoted:["7"]}),"quoted")
})
test("pending assessment is review-only with no invented communication",()=>{
  const r=pendingReview()
  assert.equal(r.decision,"review");assert.equal(r.evidence.length,0);assert.equal(r.reviewedAt,"")
})
test("stale and superseded call recommendations are ineligible",()=>{
  const item=seed.items[4]
  assert.ok(eligibleForCall(item))
  assert.equal(eligibleForCall({...item,updatedAt:new Date(Date.now()-37*3600000).toISOString()}),false)
  assert.equal(eligibleForCall({...item,callEligible:false}),false)
  assert.equal(dailyCalls([{...item,callEligible:false}]).length,0)
})
const quoteContext={...ctx,inventory:seed.quoted![0]}
const reviewOutput={doNotCall:false,outreachDecision:"now",signals:[],quoteReview:{
  decision:"wait",summary:"Customer has already made a decision.",reason:"Respect documented timing and preferences.",
  nextAction:"Review the record, do not call today.",timing:"Wait for customer initiation.",timingBasis:"Explicit source instruction.",
  confidence:"high",evidence:[{id:"emails:21",quote:"Please cancel our quote."}],
}}
test("every quoted deal must have an independent communication assessment",()=>{
  assert.throws(()=>verifiedSignals({doNotCall:false,signals:[]},quoteContext))
  assert.equal(verifiedSignals(reviewOutput,quoteContext).quoteReview?.decision,"wait")
})
test("quote hold overrides conflicting sales outreach suggestion",()=>{
  assert.equal(verifiedSignals(reviewOutput,quoteContext).outreachDecision,"wait")
})
test("no-contact quote decision persists even with no findings",()=>{
  const r=structuredClone(reviewOutput);r.quoteReview.decision="no_contact"
  const parsed=verifiedSignals(r,quoteContext)
  assert.equal(parsed.doNotCall,true);assert.equal(parsed.outreachDecision,"no_contact");assert.equal(parsed.signals.length,0)
})
test("unsupported quote evidence is rejected, not saved as a confident decision",()=>{
  const r=structuredClone(reviewOutput);r.quoteReview.evidence[0].id="invented"
  assert.throws(()=>verifiedSignals(r,quoteContext))
  const empty=structuredClone(reviewOutput);empty.quoteReview.evidence=[]
  assert.throws(()=>verifiedSignals(empty,quoteContext))
})
test("incomplete quote context downgrades new outreach to review-first",()=>{
  const r=structuredClone(reviewOutput);r.quoteReview.decision="now"
  const parsed=verifiedSignals(r,{...quoteContext,coverage:["Email bodies unavailable"]})
  assert.equal(parsed.quoteReview?.decision,"review");assert.equal(parsed.quoteReview?.confidence,"low")
})
test("real PostgreSQL migration: constraints, lease exclusion and persistent triage",async()=>{
  const db=new PGlite()
  try {
    await db.exec("create role anon; create role authenticated;")
    const migration=await readFile(new URL("../migrations/sales_watch.sql",import.meta.url),"utf8")
    await db.exec(migration);await db.exec(migration)
    const run="00000000-0000-4000-8000-000000000001"
    const other="00000000-0000-4000-8000-000000000002"
    await db.query("insert into sales_watch_runs(id,day_key,trigger,status) values($1,'2026-09-30','nightly','running')",[run])
    await assert.rejects(db.query("insert into sales_watch_runs(id,day_key,trigger,status) values($1,'2026-09-30','nightly','running')",[other]))
    const lease=`insert into sales_watch_lock(name,holder,expires_at) values('worker',$1,now()+interval '6 minutes')
      on conflict(name) do update set holder=excluded.holder,expires_at=excluded.expires_at
      where sales_watch_lock.expires_at<now() returning holder`
    assert.equal((await db.query(lease,[run])).rows.length,1)
    assert.equal((await db.query(lease,[other])).rows.length,0)
    await db.exec("update sales_watch_lock set expires_at=now()-interval '1 minute'")
    assert.equal((await db.query(lease,[other])).rows.length,1)
    await db.query("insert into sales_watch_queue(run_id,subject_key,subject_type,subject_id) values($1,'deals:1','deals','1') on conflict do nothing",[run])
    await db.query("insert into sales_watch_queue(run_id,subject_key,subject_type,subject_id) values($1,'deals:1','deals','1') on conflict do nothing",[run])
    assert.equal((await db.query("select * from sales_watch_queue")).rows.length,1)
    await db.query("insert into sales_watch_items(id,subject_key,payload,status) values('x','deals:1',$1,'resolved')",[JSON.stringify(seed.items[0])])
    await db.query("insert into sales_watch_items(id,subject_key,payload) values('x','deals:1',$1) on conflict(id) do update set payload=excluded.payload,updated_at=now()",[JSON.stringify(seed.items[0])])
    assert.equal((await db.query<{status:string}>("select status from sales_watch_items where id='x'")).rows[0].status,"resolved")
    await db.query("insert into sales_watch_actions(item_id,actor,action,note) values('x','staff@example.invalid','resolve','Confirmed resolution')")
    assert.equal((await db.query("select * from sales_watch_actions")).rows.length,1)
    await db.query("insert into sales_watch_inventory(run_id,deal_id,kind,payload) values($1,'synthetic-quote','quoted',$2)",[run,JSON.stringify(seed.quoted![0])])
    await db.query("insert into sales_watch_runs(id,day_key,trigger,status,discovery_complete) values($1,'2026-10-01','nightly','running',true)",[other])
    assert.equal((await db.query("select * from sales_watch_inventory where run_id=$1",[other])).rows.length,0)
    assert.equal((await db.query("select * from sales_watch_inventory where run_id=$1",[run])).rows.length,1)
    await db.query("insert into sales_watch_preferences(customer_key,do_not_call) values('synthetic-contact',true)")
    await db.query("insert into sales_watch_assessments(subject_key,customer_key,decision) values('deals:1','synthetic-contact','wait')")
    assert.equal((await db.query<{decision:string}>("select decision from sales_watch_assessments")).rows[0].decision,"wait")
    await db.exec("set role anon")
    await assert.rejects(db.query("select * from sales_watch_items"))
    await assert.rejects(db.query("select * from sales_watch_inventory"))
    await assert.rejects(db.query("select * from sales_watch_preferences"))
    await db.exec("reset role")
    const enabled=await db.query<{relrowsecurity:boolean}>("select relrowsecurity from pg_class where relname like 'sales_watch_%' and relkind='r'")
    assert.ok(enabled.rows.every(r=>r.relrowsecurity))
  } finally {await db.close()}
})
test("migration works on non-Supabase Postgres without REST roles",async()=>{
  const db=new PGlite()
  try {await db.exec(await readFile(new URL("../migrations/sales_watch.sql",import.meta.url),"utf8"))}
  finally {await db.close()}
})
