import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import { SalesWatchPanel } from "../components/sales-watch-panel"
import { fixtureData } from "./fixtures"
import { triage, type WatchData } from "../lib/sales-watch"
import "./shell.css"
function App() {
  const [dark,setDark]=useState(false)
  const [report,setReport]=useState<WatchData>(fixtureData)
  return <div data-theme={dark?"dark":"light"} className="preview-shell">
    <a className="skip" href="#content">Skip to content</a>
    <header className="shell-top"><div className="brand"><svg width="28" height="28" viewBox="0 0 28 28" aria-label="Express Reface"><rect width="28" height="28" rx="6" fill="#d94b00"/><path d="M8 9h12v10H8zM14 9v10" stroke="white" fill="none" strokeWidth="1.5"/></svg><strong>Express Reface</strong><span>Territory Analytics</span></div><button onClick={()=>setDark(!dark)}>{dark?"Light mode":"Dark mode"}</button></header>
    <main id="content"><div className="shell-heading"><div><div className="crumb">OPERATIONS / SALES MANAGER</div><h1>Sales Manager</h1><p>Real customer context. Separate sales and customer-care worklists.</p></div></div>
      <SalesWatchPanel preview initialData={report}
        onRefresh={async()=>({...report,lastCompleteAt:new Date().toISOString()})}
        onAction={async(item,action,note,until)=>{
          const next={...report,items:report.items.map(i=>i.id===item.id?{...triage(i,action,until),lastDisposition:{action,note,actor:"demo@example.invalid",at:new Date().toISOString()}}:i)}
          setReport(next);return next
        }}/>
      <footer>Synthetic UI test harness only. No customer data, CRM writes or live jobs. Production uses the authenticated Sales Manager API.</footer>
    </main>
  </div>
}
createRoot(document.getElementById("root")!).render(<App/>)
