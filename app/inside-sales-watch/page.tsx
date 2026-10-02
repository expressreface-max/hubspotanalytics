import type { Metadata } from "next"
import { PageHeader } from "@/components/page-header"
import { SalesWatchPanel } from "@/components/sales-watch-panel"

export const metadata: Metadata = {
  title: "Inside Sales Watch | Express Reface",
  description: "Inside-sales follow-up and customer-care analysis for HubSpot contacts and deals created less than 90 days ago.",
}

export default function InsideSalesWatchPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inside Sales Watch"
        description="Follow-up and customer-care analysis for contacts and deals created less than 90 days ago."
      />
      <SalesWatchPanel />
    </div>
  )
}
