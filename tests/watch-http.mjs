// Local production-build boundary checks. Synthetic secret only; no CRM access.
// Server: AUTH_SESSION_SECRET=synthetic-watch-session-test-only
// CRON_SECRET=synthetic-watch-cron-test-only ALLOWED_ANALYTICS_EMAILS=qa@example.invalid
// SALES_WATCH_ENABLED=false; use an unreachable synthetic POSTGRES_URL.
import { createHmac } from "node:crypto"
import assert from "node:assert/strict"
const origin=process.env.WATCH_TEST_ORIGIN || "http://localhost:5182"
const payload=Buffer.from(JSON.stringify({e:"qa@example.invalid",x:Date.now()+60000})).toString("base64url")
const signature=createHmac("sha256","synthetic-watch-session-test-only").update(payload).digest("base64url")
const cookie=`er_analytics_session=${payload}.${signature}`
let passed=0
async function check(name,path,opts,status){
  const res=await fetch(origin+path,{...opts,redirect:"manual"})
  assert.equal(res.status,status,`${name}: ${await res.text()}`)
  passed++;console.log(`PASS ${name}`)
}
const endpoint="/api/hs/sales-manager/watch"
await check("Anonymous data rejected",endpoint,{},401)
await check("Authenticated disabled state readable",endpoint,{headers:{cookie}},200)
await check("Wrong cron secret rejected","/api/cron/sales-watch",{headers:{authorization:"Bearer wrong"}},401)
await check("Missing cron auth rejected","/api/cron/sales-watch",{},401)
await check("Disabled scheduled job skips","/api/cron/sales-watch",{headers:{authorization:"Bearer synthetic-watch-cron-test-only"}},200)
await check("Cross-origin mutation rejected",endpoint,{method:"POST",headers:{cookie,origin:"https://untrusted.invalid","content-type":"application/json"},body:JSON.stringify({action:"refresh",confirm:true})},403)
await check("Missing refresh confirmation rejected",endpoint,{method:"POST",headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify({action:"refresh"})},400)
await check("Disabled disposition cannot write",endpoint,{method:"POST",headers:{cookie,origin,"content-type":"application/json"},body:JSON.stringify({action:"resolve",id:"a".repeat(32),note:"Test only"})},409)
console.log(`${passed} HTTP boundary checks passed; no CRM/AI/database writes`)
