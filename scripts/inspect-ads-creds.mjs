/**
 * Checks whether the Meta + Google Ads credentials are present in the
 * environment and does a live smoke-test of each platform.
 *
 * Run AFTER adding the credential Vars:
 *   set -a; . /vercel/share/.env.project; set +a; node scripts/inspect-ads-creds.mjs
 */

const mask = (v) => (v ? `${String(v).slice(0, 4)}…(${String(v).length} chars)` : "(missing)")
const digits = (v) => String(v ?? "").replace(/[^0-9]/g, "")

const META_TOKEN = process.env.META_ACCESS_TOKEN
const META_ACCT = digits(process.env.META_AD_ACCOUNT_ID || "100233233849429")
const META_VER = process.env.META_API_VERSION || "v22.0"

const G_DEV = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
const G_ID = process.env.GOOGLE_ADS_CLIENT_ID
const G_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET
const G_REFRESH = process.env.GOOGLE_ADS_REFRESH_TOKEN
const G_CUST = digits(process.env.GOOGLE_ADS_CUSTOMER_ID || "5685999331")
const G_LOGIN = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) : null
const G_VER = process.env.GOOGLE_ADS_API_VERSION || "v21"

console.log("=== Meta ===")
console.log("  META_ACCESS_TOKEN:", mask(META_TOKEN))
console.log("  META_AD_ACCOUNT_ID:", META_ACCT)
console.log("  META_API_VERSION:", META_VER)

async function metaSmoke() {
  if (!META_TOKEN) return console.log("  -> skip (no token)")
  try {
    const url = `https://graph.facebook.com/${META_VER}/act_${META_ACCT}/insights?fields=spend,impressions,clicks&date_preset=yesterday&access_token=${encodeURIComponent(META_TOKEN)}`
    const res = await fetch(url)
    const json = await res.json()
    if (json.error) console.log("  -> Meta API ERROR:", json.error.message)
    else console.log("  -> Meta API OK. yesterday rows:", (json.data || []).length, JSON.stringify(json.data?.[0] || {}))
  } catch (e) {
    console.log("  -> Meta fetch failed:", e.message)
  }
}

console.log("\n=== Google Ads ===")
console.log("  GOOGLE_ADS_DEVELOPER_TOKEN:", mask(G_DEV))
console.log("  GOOGLE_ADS_CLIENT_ID:", mask(G_ID))
console.log("  GOOGLE_ADS_CLIENT_SECRET:", mask(G_SECRET))
console.log("  GOOGLE_ADS_REFRESH_TOKEN:", mask(G_REFRESH))
console.log("  GOOGLE_ADS_CUSTOMER_ID:", G_CUST)
console.log("  GOOGLE_ADS_LOGIN_CUSTOMER_ID:", G_LOGIN || "(unset / self-managed)")
console.log("  GOOGLE_ADS_API_VERSION:", G_VER)

async function googleSmoke() {
  if (!(G_DEV && G_ID && G_SECRET && G_REFRESH)) return console.log("  -> skip (incomplete creds)")
  try {
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: G_ID, client_secret: G_SECRET, refresh_token: G_REFRESH, grant_type: "refresh_token" }),
    })
    const tok = await tokRes.json()
    if (!tok.access_token) return console.log("  -> OAuth ERROR:", tok.error_description || tok.error)
    console.log("  -> OAuth OK (access token acquired)")
    const headers = { Authorization: `Bearer ${tok.access_token}`, "developer-token": G_DEV, "Content-Type": "application/json" }
    if (G_LOGIN) headers["login-customer-id"] = G_LOGIN
    const q = "SELECT campaign.id, campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING YESTERDAY"
    const res = await fetch(`https://googleads.googleapis.com/${G_VER}/customers/${G_CUST}/googleAds:searchStream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: q }),
    })
    const text = await res.text()
    if (!res.ok) console.log("  -> Google Ads API ERROR", res.status, ":", text.slice(0, 300))
    else {
      const chunks = JSON.parse(text)
      const rows = (Array.isArray(chunks) ? chunks : []).flatMap((c) => c.results || [])
      console.log("  -> Google Ads API OK. yesterday campaign rows:", rows.length)
    }
  } catch (e) {
    console.log("  -> Google smoke failed:", e.message)
  }
}

await metaSmoke()
await googleSmoke()
console.log("\nDone.")
