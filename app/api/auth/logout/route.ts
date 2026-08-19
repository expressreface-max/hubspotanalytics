import { NextResponse } from "next/server"
import { SESSION_COOKIE } from "@/lib/auth"

export const runtime = "nodejs"

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    // Must match the attributes used when the cookie was set (see login route)
    // so the browser clears it, including inside the cross-site preview iframe.
    sameSite: "none",
    path: "/",
    maxAge: 0,
  })
  return res
}
