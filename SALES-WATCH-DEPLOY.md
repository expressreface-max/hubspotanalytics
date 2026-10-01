# Sales Manager deployment

This branch integrates the inside-sales activity watch into the existing `/sales-manager` page. It does not contain customer snapshots or change HubSpot records. Deployment is gated off until the database migration and environment checks below are complete.

## Deploy this branch

- Repository: `expressreface-max/hubspotanalytics`.
- Branch: `feature/sales-manager-watch`.
- Intended Vercel project: `hubspot-analytics-dashboard`, under `expressreface-1896s-projects`.
- Before deploying, confirm in Vercel that this project owns the intended live Sales Manager domain and is connected to this repository. The automation connection could not independently verify this association.
- Select this branch for a preview deployment first. Do not replace the production branch or merge unrelated changes. This branch starts from `c858880` and contains only the Sales Manager integration and its tests.

## Database migration

Run `migrations/sales_watch.sql` against the analytics app's existing Postgres database, identified by its actual Vercel `POSTGRES_URL_NON_POOLING` or `POSTGRES_URL`. Do not assume the authentication Supabase project is also the analytics database.

The SQL creates eight isolated `sales_watch_*` tables and indexes. It is repeatable and does not alter existing analytics tables or HubSpot data. All tables have RLS enabled and access revoked from Supabase's `anon` and `authenticated` roles when those roles exist. Use the existing privileged server-side database connection, not a browser-facing key.

Do not expose connection strings or tokens in client variables, screenshots, source control, or this document. Sales Watch writes now require `VERCEL_ENV=production` in addition to activation. Preview and local development can read saved analysis, but refresh, cron execution and dispositions cannot mutate the shared database. Automated runtime tests set the production flag only against synthetic HTTP and embedded PostgreSQL; never set it locally against the production database to bypass this guard.

## Vercel environment

| Variable | Requirement |
|---|---|
| `POSTGRES_URL_NON_POOLING` or `POSTGRES_URL` | Existing analytics database, with migration applied and a server-side role authorized for the new tables. |
| `HUBSPOT_TOKEN` | Existing server-side token. A token set only through the Settings page's in-memory store is not sufficient for reliable scheduled execution. |
| `AUTH_SESSION_SECRET` or `SUPABASE_JWT_SECRET` | Strong existing signing secret. The watch API rejects the app's development fallback. |
| `CRON_SECRET` | Required for all Sales Manager cron endpoints. Vercel's request must send its matching Bearer secret. |
| `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY` | If using the app's existing direct Google model path. Otherwise validate the existing Vercel AI Gateway path and its authorization. Model availability and quota need a deployment-time canary. |
| `SALES_WATCH_ENABLED` | Leave unset or `false` until migration and prerequisites are verified. Set `true` to activate manual analysis and scheduled execution. |
| `SALES_WATCH_BATCH_SIZE` | Optional, default `20`, range `1–100`. Maximum analysis attempts per invocation; actual work is also limited by the 230-second worker budget. Use `1` for a canary, then tune from measured throughput. |
| `SALES_WATCH_QUOTED_STAGES` | Optional comma-separated explicit HubSpot stage IDs, additive to quoted/proposal-sent label matching. |
| `SALES_WATCH_CONSULTATIONS_STAGES` | Optional explicit stage IDs for pre-quote candidates. |
| `SALES_WATCH_SERVICE_STAGES` | Optional explicit stage IDs for service/remake/warranty inventory. |

HubSpot must permit reading deals, contacts, owners, pipelines, relevant properties and associations, plus the activity channels used by the app: calls, notes, meetings, tasks, email and communications; tickets are included where available. Missing or unreadable channels are reported as coverage gaps, not interpreted as inactivity. Do not grant sending, deletion or CRM write permissions for this feature.

Environment changes require a new deployment to take effect. Keep secrets server-side and scoped to the intended environments.

## Nightly execution and manual refresh

The new cron is `/api/cron/sales-watch`, scheduled `*/10 10-13 * * *`: every ten minutes from 10:00 through 13:50 UTC. That is 3:00–6:50 AM Pacific during daylight time, and 2:00–5:50 AM Pacific during standard time.

The Vercel project must support that frequency and the route's 300-second maximum duration. Verify the project's cron configuration and limits before promoting; the code alone does not prove the scheduler is active.

Each invocation resumes the oldest unfinished run under a six-minute database lease. Complete discovery saves the entire inventory and queue in one transaction. Prior snapshots remain in the database; deals that moved out of tracked stages do not remain in a newly discovered inventory. Inventory rows begin with an explicit pending review rather than a fabricated assessment.

Gemini assessments use native schema-constrained JSON, followed by unchanged literal-source and safety validation. Unsupported evidence is rejected, not silently accepted. Quoted/pre-quote/service inventory reviews, including retries, are prioritized ahead of the general background queue so a failed quote does not wait behind thousands of untouched contacts and deals.

Each subject gets at most three attempts in a run. Runs with failed reads, partial channel coverage or exhausted retries remain visibly partial. A new run can retry those records once there is no resumable prior work. A manual refresh resumes pending work; starting a new full run is limited to once per fifteen minutes. Large backlogs can need multiple nightly windows or manual continuations; measure throughput rather than assuming one invocation reviews the whole account.

The existing performance-matrix job remains in place. The legacy quote-only scheduled AI scan skips when Sales Watch is enabled to avoid duplicate scheduled quote analysis; its historical UI data is not rewritten by the new watch.

## Acceptance checks before promotion

- Sign in as an allowed staff user and load `/sales-manager`. Verify anonymous requests to `/api/hs/sales-manager/watch` fail with 401.
- With migration applied, enable the feature and use batch size `1`. Click **Refresh analysis**, then **Confirm refresh**. This reads HubSpot and uses the configured model; it sends nothing to customers.
- Verify the quoted inventory against HubSpot across pipelines, including legacy stages. Check the configured label/ID mapping for this account.
- Inspect a reviewed quote's summary, evidence, contact links, reason, next step, timing basis, review time and coverage. Pending rows must remain **Review first**.
- Test a known customer hold, no-call request, fulfilled promise and unresolved service issue. Confirm service is separate from the sales call list, even on closed-won jobs.
- Validate consultation-stage candidates against actual meetings and quote delivery. A Scheduled outcome, a future appointment or missing meeting is not proof of an overdue quote.
- Confirm **Refresh analysis** resumes progress and that call recommendations are not fabricated to fill ten slots. Low confidence, no phone, no-call preferences, sales holds, closed-deal sales recommendations and recommendations older than 36 hours are excluded.
- Test resolve/snooze/reopen with a meaningful note. These affect only the app's queue, not HubSpot. Confirm the saved disposition survives reload.
- Increase the batch size only after checking provider quota, runtime and throughput. Promote the intended deployment only after its data matches HubSpot.
- Inspect the first actual nightly execution in Vercel and the next morning's run counts, errors and last-complete time. Verify a second night before treating automation as operationally proven.

## Safety and interpretation

Inside sales owns follow-through; the rep is context. Closure recommendations require literal customer decision evidence and manager review. No code automatically closes deals lost.

Quote assessments exist independently of findings, so a quote with no recommended call still gets a wait/no-contact/review explanation. Literal evidence IDs and excerpts are validated. Incomplete quote context downgrades immediate outreach to review-first. Staff call notes take precedence over supplemental automated summaries in the analysis instructions.

Unresolved findings are not silently erased when a later model output omits them. Instead, an older recommendation loses automatic call eligibility after that subject's next review unless reaffirmed. Customer no-call preferences persist separately even when the model returns no findings; clearing them requires a verified, authorized administrative change, not merely resolving a task.

This is a review assistant, not exhaustive surveillance. It cannot see unlogged communications, independent inboxes, recordings without readable text, or activity without customer associations. Contact-linked histories can mix jobs. Each finding and quote displays evidence and uncertainty for staff verification.

## Rollback

Set `SALES_WATCH_ENABLED=false` and redeploy to stop the watch's manual/scheduled work. Keep the new tables for audit history; no destructive rollback is needed. The legacy quote-only schedule resumes when the feature is disabled.

## Validation status

Local validation covers deterministic policies, literal-evidence validation, synthetic PostgreSQL migration/persistence/security tests, TypeScript, production compilation, HTTP authorization boundaries and responsive UI checks. Live production database access, HubSpot token scopes, model execution, cron delivery and project/domain ownership must still be verified in the actual Vercel environment. Do not describe a GitHub push as a production deployment.
