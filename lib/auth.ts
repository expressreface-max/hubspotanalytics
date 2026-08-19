// Lightweight session gate for the analytics dashboard.
//
// Staff sign in with their existing Express Reface proposal-tool credentials
// (email + password), which live in the shared Supabase project
// `edstjlktylkvzwodljdi`. We verify the password against that project's auth
// endpoint, check the email against an allowlist, then issue our OWN signed,
// httpOnly session cookie. The cookie is verified with Web Crypto (HMAC-SHA256)
// so the exact same code runs in Node route handlers and in Edge middleware.

export const SESSION_COOKIE = "er_analytics_session"
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7 // 7 days

// Proposal-tool Supabase project (pinned — same values the proposal app uses).
// The publishable key is safe to embed; overridable via env if it ever rotates.
const PROPOSALS_SUPABASE_URL =
  process.env.PROPOSALS_SUPABASE_URL || "https://edstjlktylkvzwodljdi.supabase.co"
const PROPOSALS_SUPABASE_ANON_KEY =
  process.env.PROPOSALS_SUPABASE_ANON_KEY || "sb_publishable_tpP7qkP3Qu5dkzRZ_4OqTQ_AQxjVmAK"

// Default allowlist (editable via the ALLOWED_ANALYTICS_EMAILS env var, which
// takes precedence when set — comma or whitespace separated).
const DEFAULT_ALLOWED_EMAILS = [
  "doug@kitchensnow.com",
  "boston@kitchensnow.com",
  "jenny@kitchensnow.com",
  "natasha@expressreface.com",
]

export function getAllowedEmails(): string[] {
  const raw = process.env.ALLOWED_ANALYTICS_EMAILS
  const list = raw && raw.trim() ? raw.split(/[,\s]+/) : DEFAULT_ALLOWED_EMAILS
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean)
}

export function isEmailAllowed(email: string): boolean {
  return getAllowedEmails().includes(email.trim().toLowerCase())
}

function signingSecret(): string {
  // A dedicated secret is preferred; fall back to the always-present Supabase
  // JWT secret so the gate works without extra configuration.
  return process.env.AUTH_SESSION_SECRET || process.env.SUPABASE_JWT_SECRET || "er-analytics-dev-secret"
}

// --- base64url helpers (Edge-safe, no Buffer) ---
function toBase64Url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmac(payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return new Uint8Array(sig)
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export async function createSessionToken(email: string): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ e: email.toLowerCase(), x: Date.now() + SESSION_TTL_MS })),
  )
  const sig = toBase64Url(await hmac(payload))
  return `${payload}.${sig}`
}

export async function verifySessionToken(token: string | undefined | null): Promise<{ email: string } | null> {
  if (!token || !token.includes(".")) return null
  const [payload, sig] = token.split(".")
  if (!payload || !sig) return null
  try {
    const expected = await hmac(payload)
    if (!timingSafeEqual(fromBase64Url(sig), expected)) return null
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { e: string; x: number }
    if (!data.e || !data.x || Date.now() > data.x) return null
    if (!isEmailAllowed(data.e)) return null
    return { email: data.e }
  } catch {
    return null
  }
}

// Verify email + password against the proposal-tool Supabase project.
// Returns the canonical user email on success, or null on bad credentials.
export async function verifyProposalCredentials(email: string, password: string): Promise<string | null> {
  const res = await fetch(`${PROPOSALS_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: PROPOSALS_SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) return null
  const data = (await res.json().catch(() => null)) as { user?: { email?: string } } | null
  return data?.user?.email ?? email
}

export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000
