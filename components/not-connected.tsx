import Link from "next/link"
import { PlugZap } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export function NotConnected({ message }: { message?: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <PlugZap className="size-6" />
        </div>
        <div className="space-y-1">
          <p className="text-base font-medium">HubSpot is not connected</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {message ??
              "Add your HubSpot private app token to start pulling live CRM data into the dashboard."}
          </p>
        </div>
        <Button render={<Link href="/settings">Go to Settings</Link>} />
      </CardContent>
    </Card>
  )
}
