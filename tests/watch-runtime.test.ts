import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"

// Runs the actual source -> model validator -> runner -> store path against
// synthetic HTTP responses and an embedded PostgreSQL engine. Network is blocked.
test("live runner persists quote inventories, suppresses fulfilled calls and retains no-call preferences",async()=>{
  const db=new PGlite()
  const originalFetch=globalThis.fetch
  const env={...process.env}
  let decision:"now"|"wait"|"no_contact"="now"
  let modelCalls=0,crmCalls=0
  let twoDeals=false
  const adapter=(conn:any):any=>{
    const tag:any=async(strings:any,...values:any[])=>{
      if(!Array.isArray(strings)||!("raw" in strings))return {list:strings}
      let text="",params:any[]=[]
      for(let i=0;i<strings.length;i++) {
        text+=strings[i]
        if(i<values.length) {
          const v=values[i]
          if(v?.list)text+="("+v.list.map((x:any)=>{params.push(x);return `$${params.length}`}).join(",")+")"
          else {params.push(v);text+=`$${params.length}`}
        }
      }
      return (await conn.query(text,params)).rows
    }
    // postgres.js sql(array) is synchronous and constructs an IN-list helper.
    const sql:any=(strings:any,...values:any[])=>!("raw" in strings)?{list:strings}:tag(strings,...values)
    sql.begin=(fn:any)=>conn.transaction((tx:any)=>fn(adapter(tx)))
    return sql
  }
  try {
    await db.exec(await readFile(new URL("../migrations/sales_watch.sql",import.meta.url),"utf8"))
    globalThis.__sql=adapter(db)
    process.env.POSTGRES_URL="postgres://synthetic:synthetic@invalid.invalid/test"
    process.env.SALES_WATCH_ENABLED="true"
    process.env.SALES_WATCH_BATCH_SIZE="1"
    process.env.GOOGLE_GENERATIVE_AI_API_KEY="synthetic-not-a-real-key"
    const now=()=>new Date().toISOString()
    const body=()=>decision==="now"?"Please call me to discuss the proposal.":decision==="wait"?
      "The promised proposal was received. Please wait until next month.":"Please do not call me again about this project."
    globalThis.fetch=async(input,init)=>{
      const url=String(input instanceof Request?input.url:input)
      const respond=(data:unknown)=>new Response(JSON.stringify(data),{status:200,headers:{"content-type":"application/json"}})
      if(url.includes("generativelanguage.googleapis.com")) {
        modelCalls++
        const parsed={doNotCall:decision==="no_contact",outreachDecision:decision,
          quoteReview:{decision,summary:body(),reason:"Explicit synthetic customer instruction.",nextAction:decision==="now"?"Call to discuss the proposal.":"Honor the customer's preference.",
            timing:decision==="now"?"Today":"Do not call today",timingBasis:"Customer instruction in source.",confidence:"high",evidence:[{id:"calls:51",quote:body()}]},
          signals:decision==="now"?[{kind:"follow_up",severity:"high",summary:body(),stream:"sales",
            background:"Synthetic proposal.",latestUpdate:body(),callObjective:"Answer proposal questions.",verification:"Verify newer CRM activity.",
            nextAction:"Call to discuss the proposal.",dueAt:null,confidence:"high",evidence:[{id:"calls:51",quote:body()}]}]:[]}
        return respond({candidates:[{content:{role:"model",parts:[{text:JSON.stringify(parsed)}]},finishReason:"STOP"}],
          usageMetadata:{promptTokenCount:100,candidatesTokenCount:100,totalTokenCount:200}})
      }
      if(!url.startsWith("https://api.hubapi.com/"))throw new Error("Unexpected network request blocked")
      crmCalls++
      const path=new URL(url).pathname
      const request=init?.body?JSON.parse(String(init.body)):{}
      const deal={id:"31",properties:{dealname:"Synthetic customer project",dealstage:"quoted",pipeline:"sales",amount:"12000",hubspot_owner_id:"9",hs_is_closed:"false",hs_is_closed_won:"false"}}
      if(path==="/crm/v3/pipelines/deals")return respond({results:[{id:"sales",label:"Sales",stages:[{id:"quoted",label:"Quoted"}]}]})
      if(path==="/account-info/v3/details")return respond({portalId:123})
      if(path==="/crm/v3/owners")return respond({results:[{id:"9",firstName:"Synthetic",lastName:"Rep"}]})
      if(path.endsWith("/search")) {
        const results=path.includes("/deals/")?(twoDeals?[deal,{...deal,id:"32"}]:[deal]):[]
        return respond({results,total:results.length})
      }
      if(path.includes("/associations/"))return respond({results:path.endsWith("/contacts")?[{toObjectId:"41"}]:path.endsWith("/calls")?[{toObjectId:"51"}]:[]})
      if(path.endsWith("/batch/read")) {
        if(path.includes("/deals/"))return respond({results:request.inputs.map((i:any)=>({...deal,id:i.id}))})
        if(path.includes("/contacts/"))return respond({results:[{id:"41",properties:{firstname:"Synthetic",lastname:"Customer",email:"customer@example.invalid",phone:"+15550123456"}}]})
        if(path.includes("/calls/"))return respond({results:[{id:"51",properties:{hs_timestamp:now(),hs_call_title:"Synthetic call",hs_call_body:body()}}]})
        return respond({results:(request.inputs||[]).map((i:any)=>({id:i.id,properties:{}}))})
      }
      throw new Error(`Unmocked CRM request ${path}`)
    }
    const {runWatch}=await import("../lib/sales-watch-runner")
    const {dailyCalls}=await import("../lib/sales-watch")
    const first=await runWatch("synthetic","manual")
    assert.equal(first.run?.status,"complete")
    assert.equal(first.quoted?.length,1)
    assert.equal(first.quoted?.[0].communicationReview?.decision,"now")
    assert.equal(first.quoted?.[0].contacts.length,1)
    assert.equal(dailyCalls(first.items).length,1)
    assert.equal(first.items[0].owner,"Inside sales")
    // A later fulfilled promise/hold keeps the old finding for disposition,
    // but it must no longer be recommended as an automatic call.
    await db.exec("update sales_watch_runs set started_at=now()-interval '20 minutes'")
    decision="wait"
    const second=await runWatch("synthetic","manual")
    assert.equal(second.quoted?.[0].communicationReview?.decision,"wait")
    assert.equal(second.items.length,1)
    assert.equal(dailyCalls(second.items).length,0)
    await db.exec("update sales_watch_runs set started_at=now()-interval '20 minutes'")
    decision="no_contact"
    const third=await runWatch("synthetic","manual")
    assert.equal(third.quoted?.[0].communicationReview?.decision,"no_contact")
    assert.equal(dailyCalls(third.items).length,0)
    assert.equal((await db.query("select * from sales_watch_preferences where do_not_call=true")).rows.length,1)
    await db.exec("update sales_watch_runs set started_at=now()-interval '20 minutes'")
    decision="now"
    const fourth=await runWatch("synthetic","manual")
    assert.equal(fourth.quoted?.[0].communicationReview?.decision,"no_contact")
    assert.equal(dailyCalls(fourth.items).length,0)
    assert.equal(modelCalls,4)
    assert.ok(crmCalls>0)
    assert.equal((await db.query("select * from sales_watch_inventory")).rows.length,4)
    await db.exec("update sales_watch_runs set started_at=now()-interval '20 minutes'")
    twoDeals=true
    const partial=await runWatch("synthetic","manual")
    assert.equal(partial.run?.status,"partial")
    assert.equal(partial.run?.done,1);assert.equal(partial.run?.total,2)
    assert.equal(partial.quoted?.filter(q=>q.communicationReview?.reviewedAt).length,1)
    const resumed=await runWatch("synthetic","manual")
    assert.equal(resumed.run?.id,partial.run?.id)
    assert.equal(resumed.run?.status,"complete")
    assert.equal(resumed.run?.done,2)
    assert.equal(modelCalls,6)
  } finally {
    globalThis.fetch=originalFetch
    delete globalThis.__sql
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key]
    Object.assign(process.env,env)
    await db.close()
  }
})
