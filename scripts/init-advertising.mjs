import postgres from "postgres"

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
if (!url) {
  console.error("[v0] No POSTGRES_URL env var")
  process.exit(1)
}

const sql = postgres(url, { ssl: "require", max: 1, connect_timeout: 15 })

// Real P&L spend from data/Advertising-887ea2.xlsx (Jan 2023 - May 2026),
// Digital/Television/Print only. Mirrors ADVERTISING_DATA in
// data/advertising-data.ts — keep the two in sync.
const seed = [
  ["2023-01", 11813.97, 28531.98, 0],
  ["2023-02", 6056.29, 26778.36, 0],
  ["2023-03", 8809.31, 29340.98, 25560],
  ["2023-04", 6152.53, 30953, 25560],
  ["2023-05", 15198.68, 24239, 25560],
  ["2023-06", 12311.29, 33516.2, 42952.7],
  ["2023-07", 11895.23, 31863, 40720.41],
  ["2023-08", 11139.34, 29126, 20680.07],
  ["2023-09", 10678.5, 28454.65, 18046],
  ["2023-10", 10579.09, 32607.38, 12060],
  ["2023-11", 7660.97, 30029.85, 12060],
  ["2023-12", 5586.2, 27724, 12060],
  ["2024-01", 6174.68, 24421, 12060],
  ["2024-02", 9728.79, 30952, 15907],
  ["2024-03", 13369.79, 33294, 36997],
  ["2024-04", 8986.01, 42899.01, 36997],
  ["2024-05", 4736.29, 39140.01, 36997],
  ["2024-06", 12625.8, 42361.98, 36997],
  ["2024-07", 14683.25, 20570, 36997],
  ["2024-08", 17363.9, 43157, 36997],
  ["2024-09", 18826.52, 49694.39, 36997],
  ["2024-10", 18896.17, 48643.69, 44570.5],
  ["2024-11", 22366.05, 75110.25, 496.99],
  ["2024-12", 16943, 54610.25, 36856.99],
  ["2025-01", 21856.15, 41188.56, 26197],
  ["2025-02", 44318.6, 41058.5, 35975.3],
  ["2025-03", 42986.17, 34811.25, 26100],
  ["2025-04", 27277.66, 29770.75, 26100],
  ["2025-05", 21917.72, 30165, 26100],
  ["2025-06", 27496.11, 30994.92, 26100],
  ["2025-07", 39879.75, 27634.5, 26100],
  ["2025-08", 61722.74, 29341.75, 26100],
  ["2025-09", 57767.01, 27202.62, 57125],
  ["2025-10", 56709.34, 24600, 31025],
  ["2025-11", 49450.35, 10725, 31025],
  ["2025-12", 44617.3, 33973, 0],
  ["2026-01", 40897.23, 23500, 13300],
  ["2026-02", 43488.44, 8425, 13300],
  ["2026-03", 53407.59, 28350.01, 13300],
  ["2026-04", 89222.47, 30400, 5945],
  ["2026-05", 59678.39, 21650, 5945],
]

try {
  await sql`
    create table if not exists public.advertising_spend (
      month text primary key,
      digital numeric not null default 0 check (digital >= 0),
      television numeric not null default 0 check (television >= 0),
      print numeric not null default 0 check (print >= 0),
      updated_at timestamptz not null default now()
    )
  `
  await sql`alter table public.advertising_spend enable row level security`
  await sql`drop policy if exists "read advertising spend" on public.advertising_spend`
  await sql`create policy "read advertising spend" on public.advertising_spend for select using (true)`

  for (const [month, digital, television, print] of seed) {
    await sql`
      insert into public.advertising_spend (month, digital, television, print)
      values (${month}, ${digital}, ${television}, ${print})
      on conflict (month) do update set
        digital = excluded.digital,
        television = excluded.television,
        print = excluded.print,
        updated_at = now()
    `
  }

  const [{ count }] = await sql`select count(*)::int as count from public.advertising_spend`
  console.log("[v0] advertising_spend ready, rows:", count)
} catch (err) {
  console.error("[v0] migration failed:", err.message)
  process.exitCode = 1
} finally {
  await sql.end()
}
