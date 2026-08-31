-- Deal-keyed RealEstateAPI enrichment table.
-- One row per HubSpot deal that has ever entered a Quoted stage or closed
-- (won or lost). Superset of the address-keyed customer_property_enrichment
-- cache (kept for backward compatibility with lib/realestate.ts), with the
-- richer property + owner + MLS + territory fields captured in the one-time
-- contact-table enrichment.
CREATE TABLE IF NOT EXISTS reapi_deal_enrichment (
  deal_id TEXT PRIMARY KEY,
  contact_id TEXT,
  address_key TEXT,               -- joins to customer_property_enrichment.address_key
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,

  -- Territory routing (from HubSpot deal properties, snapshotted at enrich time)
  er_territory TEXT,
  er_sub_region TEXT,
  er_region TEXT,

  -- Deal status at the time of enrichment (informational; live status always
  -- comes from HubSpot — this is just for auditing why a deal was picked up)
  deal_stage_at_enrich TEXT,

  -- Property facts
  property_data_available BOOLEAN DEFAULT FALSE,
  property_fetch_error TEXT,
  estimated_value NUMERIC,
  estimated_equity NUMERIC,
  equity_percent NUMERIC,
  estimated_mortgage_balance NUMERIC,
  estimated_mortgage_payment NUMERIC,
  last_sale_date DATE,
  last_sale_price NUMERIC,
  owner_occupied BOOLEAN,
  absentee_owner BOOLEAN,
  out_of_state_absentee_owner BOOLEAN,
  in_state_absentee_owner BOOLEAN,
  vacant BOOLEAN,
  free_clear BOOLEAN,
  high_equity BOOLEAN,
  corporate_owned BOOLEAN,
  property_type TEXT,
  year_built INTEGER,
  living_square_feet INTEGER,
  bedrooms INTEGER,
  bathrooms NUMERIC,
  lot_square_feet INTEGER,
  flood_zone BOOLEAN,
  flood_zone_type TEXT,

  -- MLS
  mls_active BOOLEAN,
  mls_listing_price NUMERIC,
  mls_status TEXT,

  -- Owner / SkipTrace facts
  owner_data_available BOOLEAN DEFAULT FALSE,
  owner_fetch_error TEXT,
  owner_full_name TEXT,
  owner_age TEXT,
  owner_gender TEXT,
  owner_marital_status TEXT,
  owner_occupation TEXT,
  owner_emails JSONB,
  owner_phones JSONB,
  owner_dnc_all_phones BOOLEAN,

  -- Raw payloads for anything not broken out above
  property_json JSONB,
  owner_json JSONB,

  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'nightly_cron' -- 'backfill' | 'nightly_cron'
);

CREATE INDEX IF NOT EXISTS reapi_deal_enrichment_contact_id_idx ON reapi_deal_enrichment (contact_id);
CREATE INDEX IF NOT EXISTS reapi_deal_enrichment_address_key_idx ON reapi_deal_enrichment (address_key);

-- Tracks each nightly cron run so the job knows the high-water mark
-- (lastmodifieddate) it already covered, and to report volume/cost per run.
CREATE TABLE IF NOT EXISTS reapi_enrichment_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  candidate_deals INTEGER,       -- deals in Quoted/Closed scope with no enrichment yet
  api_calls_made INTEGER,        -- new RealEstateAPI lookups this run (property+skiptrace pairs)
  deals_enriched INTEGER,        -- rows upserted this run
  capped BOOLEAN DEFAULT FALSE,  -- true if the nightly cap was hit and backlog remains
  errors INTEGER DEFAULT 0,
  notes TEXT
);
