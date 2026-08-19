import { NextResponse, type NextRequest } from "next/server"
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth"

// Routes that must stay reachable WITHOUT a session. The cron entry point is
// public here but gated by CRON_SECRET inside the route.
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/cron"]

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (isPublic(pathname)) return NextResponse.next()

  const session = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)
  if (session) return NextResponse.next()

  // Unauthenticated: data/API routes get a hard 401; pages redirect to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  const loginUrl = req.nextUrl.clone()
  loginUrl.pathname = "/login"
  loginUrl.search = ""
  // Preserve where the user was headed so we can bounce them back after login.
  if (pathname && pathname !== "/") loginUrl.searchParams.set("next", pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // Run on everything except Next internals and static asset files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|gif|txt|xml|json)$).*)"],
}
