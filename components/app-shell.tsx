"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"
import {
  LayoutDashboard,
  Handshake,
  Users,
  UserCheck,
  FileBarChart,
  Filter,
  CalendarCheck,
  CalendarRange,
  GitCompareArrows,
  Gauge,
  ScrollText,
  UserRound,
  Megaphone,
  Target,
  Crosshair,
  Settings,
  Moon,
  Sun,
  Hexagon,
  CircleCheck,
  CircleAlert,
  LogOut,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useQuery } from "@tanstack/react-query"
import { apiGet } from "@/lib/api"

const NAV_ITEMS = [
  { title: "Sales Manager", href: "/sales-manager", icon: Gauge },
  { title: "Dashboard", href: "/", icon: LayoutDashboard },
  { title: "Deals", href: "/deals", icon: Handshake },
  { title: "Contacts", href: "/contacts", icon: Users },
  { title: "Customers", href: "/customers", icon: UserCheck },
  { title: "Reports", href: "/reports", icon: FileBarChart },
  { title: "Funnel", href: "/territory", icon: Filter },
  { title: "Meetings", href: "/meetings", icon: CalendarCheck },
  { title: "Deal Analysis", href: "/deal-analysis", icon: CalendarRange },
  { title: "Period Compare", href: "/period-compare", icon: GitCompareArrows },
  { title: "Quotes", href: "/quotes", icon: ScrollText },
  { title: "Sales Rep", href: "/sales-rep", icon: UserRound },
  { title: "Advertising", href: "/advertising", icon: Megaphone },
  { title: "Attribution", href: "/attribution", icon: Target },
  { title: "Territory Potential", href: "/territory-potential", icon: Crosshair },
  { title: "Settings", href: "/settings", icon: Settings },
]

function ConnectionBadge() {
  const { data } = useQuery({
    queryKey: ["config-status"],
    queryFn: () => apiGet<{ configured: boolean }>("/api/hs/config/status"),
  })
  const configured = data?.configured

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
      {configured ? (
        <>
          <CircleCheck className="size-4 text-chart-4" />
          <span className="text-muted-foreground">HubSpot connected</span>
        </>
      ) : (
        <>
          <CircleAlert className="size-4 text-destructive" />
          <span className="text-muted-foreground">Not connected</span>
        </>
      )}
    </div>
  )
}

function UserFooter() {
  const { data } = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => apiGet<{ authenticated: boolean; email?: string }>("/api/auth/me"),
    retry: false,
  })

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" })
    window.location.assign("/login")
  }

  if (!data?.email) return null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="truncate px-2 text-xs text-muted-foreground" title={data.email}>
        {data.email}
      </div>
      <Button variant="outline" size="sm" className="w-full justify-start gap-2" onClick={signOut}>
        <LogOut className="size-4" />
        <span>Sign out</span>
      </Button>
    </div>
  )
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const isDark = theme === "dark"

  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full justify-start gap-2"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {mounted && isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      <span>{mounted ? (isDark ? "Light mode" : "Dark mode") : "Theme"}</span>
    </Button>
  )
}

function AppSidebar() {
  const pathname = usePathname()

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Hexagon className="size-5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Express Reface</span>
            <span className="text-xs text-muted-foreground">Territory Analytics</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const active =
                  item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={item.title}
                      render={
                        <Link href={item.href}>
                          <item.icon className="size-4" />
                          <span>{item.title}</span>
                        </Link>
                      }
                    />
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Separator className="mb-1" />
        <ConnectionBadge />
        <ThemeToggle />
        <UserFooter />
      </SidebarFooter>
    </Sidebar>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // The login page renders without the dashboard chrome.
  if (pathname === "/login") return <>{children}</>

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <span className="text-sm font-medium text-muted-foreground">
            HubSpot Data Analytics By Territory
          </span>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
