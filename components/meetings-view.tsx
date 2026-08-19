"use client"

import { useQuery } from "@tanstack/react-query"
import { apiGet } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { NotConnected } from "@/components/not-connected"
import { MeetingsSetSection } from "@/components/meetings-set-section"
import { ApptScheduledSection } from "@/components/appt-scheduled-section"

export function MeetingsView() {
  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })

  const configured = !!status.data?.configured

  if (!status.isLoading && !configured) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Meetings" description="Meetings set and appointments scheduled with meeting dates." />
        <NotConnected />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Meetings"
        description="Meetings set by rep and type, plus every appointment scheduled with its associated meeting date."
      />

      {/* Meetings-set summary — meetings by date, broken down by type + attending rep */}
      <MeetingsSetSection configured={configured} />

      {/* All appointments scheduled, with associated meeting dates — own date range */}
      <ApptScheduledSection configured={configured} />
    </div>
  )
}
