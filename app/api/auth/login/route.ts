import { NextResponse } from "next/server"
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  isEmailAllowed,
  verifyProposalCredentials,
} from "@/lib/auth"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null
  const email = (body?.email || "").trim()
  const password = body?.password || ""

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 })
  }

  // Reject non-allowlisted emails before we ever touch the auth backend.
  if (!isEmailAllowed(email)) {
    return NextResponse.json(
      { error: "This account is not authorized for the analytics dashboard." },
      { status: 403 },
    )
  }

  const verifiedEmail = await verifyProposalCredentials(email, password)
  if (!verifiedEmail) {
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 })
  }

  // Double-check the canonical email from the auth provider is still allowed.
  if (!isEmailAllowed(verifiedEmail)) {
    return NextResponse.json(
      { error: "This account is not authorized for the analytics dashboard." },
      { status: 403 },
    )
  }

  const token = await createSessionToken(verifiedEmail)
  const res = NextResponse.json({ ok: true, email: verifiedEmail })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    // SameSite=None so the cookie is accepted inside the v0 preview iframe
    // (cross-site). Requires Secure, which is set above. Works top-level too.
    sameSite: "none",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
  return res
}
