import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import postgres from "postgres"

// Runs the actual source -> model validator -> runner -> store path against
// synthetic HTTP responses and an embedded PostgreSQL engine. Network is blocked.
test("live runner persists quote inventories, suppresses fulfilled calls and retains no-call preferences",async()=>{
  const db=new PGlite()
  const driver=postgres("postgres://synthetic:synthetic@invalid.invalid/test")
  const originalFetch=globalThis.fetch
  const env={...process.env}
  let decision:"now"|"wait"|"no_contact"="now"
  let modelCalls=0,crmCalls=0
  let twoDeals=false
  let modelFailure: "none" | "length" | "json" | "evidence" | "provider" | "timeout" = "none"
  const privateError = "synthetic-private-provider-payload-never-persist"
  const adapter=(conn:any):any=>{
    const tag:any=async(strings:any,...values:any[])=>{
      if(!Array.isArray(strings)||!("raw" in strings))return {list:strings}
      let text="",params:any[]=[]
      for(let i=0;i<strings.length;i++) {
        text+=strings[i]
        if(i<values.length) {
          const v=values[i]
          if(v?.list)text+="("+v.list.map((x:any)=>{params.push(x);return `$${params.length}`}).join(",")+")"
          else {params.push(v?.type===3802?v.value:v);text+=`$${params.length}`}
        }
      }
      // PGlite otherwise treats serialized JSON strings differently from postgres.js.
      return (await conn.query(text,params,{serializers:driver.options.serializers})).rows
    }
    // postgres.js sql(array) is synchronous and constructs an IN-list helper.
    const sql:any=(strings:any,...values:any[])=>!("raw" in strings)?{list:strings}:tag(strings,...values)
    sql.json=driver.json
    sql.begin=(fn:any)=>conn.transaction((tx:any)=>fn(adapter(tx)))
    return sql
  }
  try {
    await db.exec(await readFile(new URL("../migrations/sales_watch.sql",import.meta.url),"utf8"))
    globalThis.__sql=adapter(db)
    process.env.POSTGRES_URL="postgres://synthetic:synthetic@invalid.invalid/test"
    process.env.SALES_WATCH_ENABLED="true"
    process.env.VERCEL_ENV="production"
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
        const request=JSON.parse(String(init?.body))
        assert.equal(request.generationConfig.thinkingConfig.thinkingBudget,1024)
        assert.equal(request.generationConfig.thinkingConfig.includeThoughts,false)
        assert.equal(request.generationConfig.maxOutputTokens,6500)
        assert.equal(request.generationConfig.responseMimeType,"application/json")
        assert.ok(request.generationConfig.responseJsonSchema || request.generationConfig.responseSchema)
        if(modelFailure==="provider") return new Response(JSON.stringify({error:{code:429,message:privateError,status:"RESOURCE_EXHAUSTED"}}),{status:429,headers:{"content-type":"application/json"}})
        if(modelFailure==="timeout") throw new DOMException(privateError,"TimeoutError")
        const parsed={doNotCall:decision==="no_contact",outreachDecision:decision,
          quoteReview:{decision,summary:body(),reason:"Explicit synthetic customer instruction.",nextAction:decision==="now"?"Call to discuss the proposal.":"Honor the customer's preference.",
            timing:decision==="now"?"Today":"Do not call today",timingBasis:"Customer instruction in source.",confidence:"high",evidence:[{id:"calls:51",quote:body()}]},
          signals:decision==="now"?[{kind:"follow_up",severity:"high",summary:body(),stream:"sales",
            background:"Synthetic proposal.",latestUpdate:body(),callObjective:"Answer proposal questions.",verification:"Verify newer CRM activity.",
            nextAction:"Call to discuss the proposal.",dueAt:null,confidence:"high",evidence:[{id:"calls:51",quote:body()}]}]:[]}
        if(modelFailure==="evidence")parsed.quoteReview.evidence[0].quote="Fabricated evidence must never become a saved assessment."
        return respond({candidates:[{content:{role:"model",parts:[{text:modelFailure==="json"?`{${privateError}`:JSON.stringify(parsed)}]},finishReason:modelFailure==="length"?"MAX_TOKENS":"STOP"}],
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
    const {readWatch,readWatchErrors}=await import("../lib/sales-watch-store")
    assert.throws(()=>readWatchErrors(null),/Invalid stored/)
    assert.throws(()=>readWatchErrors({unexpected:true}),/Invalid stored/)
    assert.throws(()=>readWatchErrors([42]),/Invalid stored/)
    const idle=await runWatch("synthetic","nightly",{allowNewRun:false})
    assert.equal(idle.run,null)
    assert.equal(modelCalls,0)
    assert.equal(crmCalls,0)
    assert.equal((await db.query<{count:number}>("select count(*)::int as count from sales_watch_runs")).rows[0].count,0)
    const first=await runWatch("synthetic","manual")
    assert.equal(first.run?.status,"complete")
    assert.equal(first.quoted?.length,1)
    assert.equal(first.quoted?.[0].communicationReview?.decision,"now")
    assert.equal(first.quoted?.[0].contacts.length,1)
    assert.equal(dailyCalls(first.items).length,1)
    assert.equal(first.items[0].owner,"Inside sales")
    assert.deepEqual(first.run?.errors,[])
    assert.deepEqual((await db.query("select jsonb_typeof(payload) as type from sales_watch_inventory")).rows,[{type:"object"}])
    assert.deepEqual((await db.query("select jsonb_typeof(payload) as type from sales_watch_items")).rows,[{type:"object"}])
    assert.deepEqual((await db.query("select jsonb_typeof(errors) as type from sales_watch_runs")).rows,[{type:"array"}])
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
    // Recreate the canary's string payloads and repeatedly encoded warning array.
    await db.query("update sales_watch_inventory set payload=to_jsonb(payload::text) where run_id=$1",[partial.run?.id])
    const warnings=["tickets: history unavailable; coverage is incomplete."]
    await db.query("update sales_watch_runs set errors=to_jsonb(to_jsonb($1::text)::text) where id=$2",[JSON.stringify(warnings),partial.run?.id])
    const legacy=await readWatch()
    assert.deepEqual(legacy.run?.errors,warnings)
    assert.ok(legacy.coverage.includes(warnings[0]))
    assert.equal(legacy.coverage.some(message=>message.length===1),false)
    assert.equal(legacy.quoted?.length,2)
    assert.ok(legacy.quoted?.every(row=>row.name==="Synthetic customer project"))
    await db.query("update sales_watch_runs set errors=to_jsonb('[]'::text) where id=$1",[partial.run?.id])
    const resumed=await runWatch("synthetic","nightly",{allowNewRun:false})
    assert.equal(resumed.run?.id,partial.run?.id)
    assert.equal(resumed.run?.status,"complete")
    assert.equal(resumed.run?.done,2)
    assert.deepEqual(resumed.run?.errors,[])
    assert.equal(resumed.quoted?.filter(q=>q.communicationReview?.reviewedAt).length,2)
    assert.deepEqual((await db.query("select jsonb_typeof(errors) as type from sales_watch_runs where id=$1",[partial.run?.id])).rows,[{type:"array"}])
    assert.deepEqual((await db.query("select jsonb_typeof(payload) as type from sales_watch_inventory where run_id=$1 and deal_id='32'",[partial.run?.id])).rows,[{type:"object"}])
    assert.equal(modelCalls,6)
    twoDeals=false
    await db.exec("update sales_watch_items set status='resolved' where subject_key='deals:32'")
    const errors={
      length:"Model response exceeded the output limit; no assessment was saved.",
      json:"Model returned incomplete or invalid structured output; no assessment was saved.",
      evidence:"Model quote evidence did not match the source verbatim; no assessment was saved.",
      provider:"Model request failed; check provider access and quota. No assessment was saved.",
      timeout:"Model request timed out; no assessment was saved.",
    } as const
    for(const mode of Object.keys(errors) as (keyof typeof errors)[]) {
      await db.exec("update sales_watch_runs set started_at=started_at-interval '20 minutes'")
      modelFailure=mode
      const beforeCalls:number=modelCalls
      const result=await runWatch("synthetic","manual")
      assert.equal(modelCalls,beforeCalls+1,"Do not automatically retry paid generations")
      assert.equal(result.run?.status,"partial")
      assert.equal(result.run?.done,0)
      assert.equal(result.run?.failed,1)
      assert.equal(result.quoted?.[0].communicationReview?.reviewedAt,"")
      assert.equal(dailyCalls(result.items).length,0)
      assert.ok(result.coverage.includes(`1 record(s): ${errors[mode]}`))
      assert.ok(!JSON.stringify(result).includes(privateError))
      const records=await db.query<{error:string}>("select error from sales_watch_queue where run_id=$1",[result.run?.id])
      assert.equal(records.rows[0].error,errors[mode])
    }
    modelFailure="none"
    const recovered=await runWatch("synthetic","manual")
    assert.equal(recovered.run?.done,1)
    assert.equal(recovered.run?.failed,0)
    assert.deepEqual(recovered.run?.errors,[])
    assert.ok(recovered.quoted?.[0].communicationReview?.reviewedAt)
    const {applyWatchAction}=await import("../lib/sales-watch-store")
    const beforePreviewCalls=modelCalls
    for (const environment of ["preview","development",""]) {
      process.env.VERCEL_ENV=environment
      assert.equal((await readWatch()).readOnly,true)
      await assert.rejects(runWatch("synthetic","manual"),/read-only outside production/)
      await assert.rejects(applyWatchAction(recovered.items[0].id,"resolve","Synthetic disposition","staff@example.invalid"),/read-only outside production/)
    }
    assert.equal(modelCalls,beforePreviewCalls)
    assert.equal((await db.query("select * from sales_watch_lock")).rows.length,0)
    process.env.VERCEL_ENV="production"
    assert.equal((await readWatch()).readOnly,false)
    // A failed inventory review must retry before untouched background contacts.
    await db.query("update sales_watch_runs set status='partial' where id=$1",[recovered.run?.id])
    await db.query("update sales_watch_queue set status='failed',attempts=1 where run_id=$1",[recovered.run?.id])
    await db.query("insert into sales_watch_queue(run_id,subject_key,subject_type,subject_id) values($1,'contacts:1','contacts','1')",[recovered.run?.id])
    const prioritized=await runWatch("synthetic","manual")
    assert.equal(prioritized.run?.done,1)
    assert.deepEqual((await db.query("select status,attempts from sales_watch_queue where run_id=$1 and subject_key='contacts:1'",[recovered.run?.id])).rows,[{status:"pending",attempts:0}])
    await db.exec("update sales_watch_queue set status='done',error=null; update sales_watch_runs set status='complete'")
    const nightly=await runWatch("synthetic","nightly")
    assert.equal(nightly.run?.trigger,"nightly")
    const beforeDuplicate=modelCalls
    const duplicate=await runWatch("synthetic","nightly")
    assert.equal(duplicate.run?.id,nightly.run?.id)
    assert.equal(modelCalls,beforeDuplicate,"Completed nightly scans do not restart on five-minute ticks")
    await db.exec("update sales_watch_runs set status='partial'; update sales_watch_queue set status='failed',attempts=3")
    const exhausted=await runWatch("synthetic","nightly")
    assert.equal(exhausted.run?.id,nightly.run?.id)
    assert.equal(modelCalls,beforeDuplicate,"Exhausted records cannot cause unbounded model spending")
    await db.exec("insert into sales_watch_lock(name,holder,expires_at) values('worker','00000000-0000-0000-0000-000000000001',now()+interval '6 minutes')")
    const locked=await runWatch("synthetic","nightly")
    assert.equal(locked.busy,true)
    assert.equal(modelCalls,beforeDuplicate,"Overlapping cron invocations never process in parallel")
  } finally {
    globalThis.fetch=originalFetch
    delete globalThis.__sql
    for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key]
    Object.assign(process.env,env)
    await driver.end()
    await db.close()
  }
})
