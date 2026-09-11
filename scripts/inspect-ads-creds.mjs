/**
 * One-time schema probe for the external Supabase project that stores the
 * Meta + Google Ads credentials. Run AFTER adding ADS_SUPABASE_URL and
 * ADS_SUPABASE_SERVICE_KEY to the environment:
 *
 *   set -a; . /vercel/share/.env.project; set +a; node scripts/inspect-ads-creds.mjs
 *
 * It lists candidate credential tables and their columns (values masked) so we
 * can confirm / adjust the column mapping in lib/ads-credentials.ts.
 */
const URL = process.env.ADS_SUPABASE_URL
const KEY = process.env.ADS_SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error("Set ADS_SUPABASE_URL and ADS_SUPABASE_SERVICE_KEY first.")
  process.exit(1)
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const CANDIDATE = /cred|token|secret|oauth|ads?|meta|google|facebook|fb|integration|connection|api[_-]?key|platform|marketing/i
const SENSITIVE = /token|secret|key|password|refresh|client_secret/i

const mask = (v) => {
  if (v === null || v === undefined) return null
  const s = String(v)
  if (s.length <= 8) return "•".repeat(s.length)
  return `${s.slice(0, 4)}…${s.slice(-2)} (len ${s.length})`
}

const spec = await (await fetch(`${URL}/rest/v1/`, { headers })).json()
const tables = spec.definitions ? Object.keys(spec.definitions) : []
console.log(`\nAll tables (${tables.length}):`, tables.join(", "))

const candidates = tables.filter((t) => CANDIDATE.test(t))
console.log(`\nCandidate credential tables:`, candidates.join(", ") || "(none — showing all)")

for (const t of candidates.length ? candidates : tables) {
  try {
    const rows = await (await fetch(`${URL}/rest/v1/${encodeURIComponent(t)}?select=*&limit=5`, { headers })).json()
    if (!Array.isArray(rows) || !rows.length) {
      console.log(`\n── ${t}: (empty)`)
      continue
    }
    console.log(`\n── ${t} (${rows.length} row[s]) — columns: ${Object.keys(rows[0]).join(", ")}`)
    rows.forEach((r, i) => {
      const masked = {}
      for (const [k, v] of Object.entries(r)) masked[k] = SENSITIVE.test(k) ? mask(v) : v
      console.log(`   row ${i}:`, JSON.stringify(masked))
    })
  } catch (e) {
    console.log(`\n── ${t}: error ${e.message}`)
  }
}
console.log("\nDone. Map the confirmed columns in lib/ads-credentials.ts if the fuzzy inference missed anything.")
