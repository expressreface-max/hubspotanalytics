-- REVIEWED MIGRATION REQUIRED. This file is not automatically executed.
-- Separate from CRM: no HubSpot deal stages or owners are changed.
create table if not exists sales_watch_runs (
  id uuid primary key,
  day_key text not null,
  trigger text not null check (trigger in ('nightly','manual')),
  status text not null check (status in ('running','partial','complete','failed')),
  discovery_complete boolean not null default false,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  errors jsonb not null default '[]'
);
create unique index if not exists sales_watch_one_nightly on sales_watch_runs(day_key) where trigger = 'nightly';
create table if not exists sales_watch_lock (
  name text primary key,
  holder uuid not null,
  expires_at timestamptz not null
);
create table if not exists sales_watch_queue (
  run_id uuid references sales_watch_runs(id),
  subject_key text not null,
  subject_type text not null check (subject_type in ('deals','contacts','tickets')),
  subject_id text not null,
  status text not null default 'pending' check (status in ('pending','done','failed')),
  attempts int not null default 0,
  error text,
  primary key (run_id, subject_key)
);
create table if not exists sales_watch_items (
  id text primary key,
  subject_key text not null,
  payload jsonb not null,
  status text not null default 'open' check (status in ('open','snoozed','resolved')),
  snoozed_until timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists sales_watch_items_subject on sales_watch_items(subject_key);
create table if not exists sales_watch_actions (
  id bigserial primary key,
  item_id text not null references sales_watch_items(id),
  actor text not null,
  action text not null,
  note text not null,
  at timestamptz not null default now()
);
create index if not exists sales_watch_actions_item on sales_watch_actions(item_id, at desc);
-- Run-scoped snapshots: a complete discovery atomically publishes a new inventory.
-- Older inventories are retained; moved/deleted deals are absent from the new snapshot.
create table if not exists sales_watch_inventory (
  run_id uuid not null references sales_watch_runs(id),
  deal_id text not null,
  kind text not null check (kind in ('quoted','consultations','service')),
  payload jsonb not null,
  analyzed_at timestamptz,
  primary key(run_id,deal_id)
);
create table if not exists sales_watch_preferences (
  customer_key text primary key,
  do_not_call boolean not null default false,
  updated_at timestamptz not null default now()
);
create table if not exists sales_watch_assessments (
  subject_key text primary key,
  customer_key text not null,
  decision text not null check(decision in ('now','wait','no_contact','review')),
  updated_at timestamptz not null default now()
);
-- Server-side Postgres only. Do not expose customer communication to anon/authenticated REST.
alter table sales_watch_runs enable row level security;
alter table sales_watch_lock enable row level security;
alter table sales_watch_queue enable row level security;
alter table sales_watch_items enable row level security;
alter table sales_watch_actions enable row level security;
alter table sales_watch_inventory enable row level security;
alter table sales_watch_preferences enable row level security;
alter table sales_watch_assessments enable row level security;
-- Works on plain Postgres as well as Supabase, without assuming REST roles exist.
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on sales_watch_runs, sales_watch_lock, sales_watch_queue, sales_watch_items, sales_watch_actions, sales_watch_inventory, sales_watch_preferences, sales_watch_assessments from %I',role_name);
    end if;
  end loop;
end $$;
