// Client-side fetch helpers used with TanStack Query.
// All requests are relative — Next.js route handlers live on the same origin.

export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" } })
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Request failed: ${res.status}`)
  return res.json()
}

export async function apiPost<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Request failed: ${res.status}`)
  return res.json()
}

export function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n || 0)
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n || 0)
}
