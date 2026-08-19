"use client"

import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleCheck, CircleAlert, KeyRound, Loader2 } from "lucide-react"
import { apiGet, apiPost } from "@/lib/api"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

type Status = { configured: boolean; hint: string | null; source: string | null }

export function SettingsView() {
  const qc = useQueryClient()
  const [token, setToken] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const status = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<Status>("/api/hs/config/status"),
  })

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await apiPost("/api/hs/config/token", { token })
      setToken("")
      setSaved(true)
      await qc.invalidateQueries()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const configured = status.data?.configured
  const fromEnv = status.data?.source === "env"

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Connect this dashboard to your HubSpot CRM with a private app token."
      />

      <Card className="max-w-2xl">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-primary" />
              HubSpot connection
            </CardTitle>
            {configured ? (
              <Badge className="gap-1 bg-chart-4 text-white hover:bg-chart-4">
                <CircleCheck className="size-3.5" /> Connected
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1">
                <CircleAlert className="size-3.5" /> Not connected
              </Badge>
            )}
          </div>
          <CardDescription>
            {configured
              ? `A token is configured${status.data?.hint ? ` (${status.data.hint})` : ""}${
                  fromEnv ? " via the HUBSPOT_TOKEN environment variable." : " at runtime."
                }`
              : "No token found. Add one below or set the HUBSPOT_TOKEN environment variable."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="hs-token">HubSpot private app token</Label>
            <Input
              id="hs-token"
              type="password"
              placeholder="pat-na1-..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              The token is validated against HubSpot and stored server-side for this session.
              All CRM requests are proxied through the server — the token is never exposed to the
              browser.
            </p>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {saved ? <p className="text-sm text-chart-4">Token saved and validated.</p> : null}

          <div>
            <Button onClick={save} disabled={!token.trim() || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {saving ? "Validating..." : "Save token"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Recommended: environment variable</CardTitle>
          <CardDescription>
            For production, set <code className="rounded bg-muted px-1 py-0.5">HUBSPOT_TOKEN</code> in
            your Vercel project environment variables. It takes priority and persists across
            deployments and server restarts, so you won&apos;t need to re-enter it here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Required scopes: <code className="rounded bg-muted px-1 py-0.5">crm.objects.deals.read</code>,{" "}
            <code className="rounded bg-muted px-1 py-0.5">crm.objects.contacts.read</code>,{" "}
            <code className="rounded bg-muted px-1 py-0.5">crm.schemas.deals.read</code>, and owners read.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
