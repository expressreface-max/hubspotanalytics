// Runtime token store. The canonical source is the HUBSPOT_TOKEN environment
// variable. The Settings page can also set a token at runtime (best-effort,
// kept in module memory for the current server instance). For production,
// always set HUBSPOT_TOKEN as a Vercel environment variable.

let runtimeToken: string | null = null

export function setRuntimeToken(token: string) {
  runtimeToken = token.trim() || null
}

export function getActiveToken(req?: Request): string | null {
  const header = req?.headers.get("x-hubspot-token")
  return header || runtimeToken || process.env.HUBSPOT_TOKEN || null
}

export function isConfigured(req?: Request): boolean {
  return Boolean(getActiveToken(req))
}

// A masked hint so the UI can show whether a token is present without leaking it.
export function tokenHint(): string | null {
  const t = runtimeToken || process.env.HUBSPOT_TOKEN || null
  if (!t) return null
  if (t.length <= 8) return "••••"
  return `${t.slice(0, 4)}••••${t.slice(-4)}`
}
