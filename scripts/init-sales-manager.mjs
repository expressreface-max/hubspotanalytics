// One-time / idempotent DDL for the Sales Manager page storage.
//   node scripts/init-sales-manager.mjs
// (load env first: `set -a; . /vercel/share/.env.project; set +a`)
import postgres from "postgres"

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
if (!url) {
  console.error("No POSTGRES_URL(_NON_POOLING) in env.")
  process.exit(1)
}
const sql = postgres(url, { ssl: "require", max: 1 })

try {
  // Nightly matrix (metric rows x time-window columns).
  await sql`
    create table if not exists sales_manager_metrics (
      period_key text primary key,
      label text not null,
      date_from timestamptz,
      date_to timestamptz,
      contacts int not null default 0,
      appointments int not null default 0,
      quotes int not null default 0,
      closed_won int not null default 0,
      won_revenue numeric not null default 0,
      updated_at timestamptz not null default now()
    )
  `
  // Nightly section snapshots (Meetings, Open Quote Pipeline, Sales Rep YTD).
  // Each row holds the pre-computed JSON payload the page renders verbatim.
  await sql`
    create table if not exists sales_manager_snapshots (
      section text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    )
  `
  // Daily per-quote AI scans. First scan for a deal = baseline (summary +
  // evaluation); subsequent daily scans = update (what changed + action items).
  // One row per deal per calendar day (re-running the same day overwrites it).
  await sql`
    create table if not exists open_quote_scans (
      id bigserial primary key,
      deal_id text not null,
      scan_date date not null,
      scan_type text not null,
      deal_name text,
      rep text,
      stage text,
      amount numeric,
      age_days int,
      days_since_contact int,
      engagement_count int not null default 0,
      last_engagement_at timestamptz,
      changes_detected boolean not null default false,
      markdown text not null,
      model text,
      created_at timestamptz not null default now(),
      unique (deal_id, scan_date)
    )
  `
  await sql`
    create index if not exists open_quote_scans_deal_idx
      on open_quote_scans (deal_id, created_at desc)
  `
  console.log("sales_manager_metrics + sales_manager_snapshots + open_quote_scans ready.")
} catch (err) {
  console.error("DDL failed:", err.message)
  process.exitCode = 1
} finally {
  await sql.end()
}
