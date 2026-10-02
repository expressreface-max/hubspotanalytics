# Sales Watch validation checklist

The production integration is tested locally using synthetic records only. Actual HubSpot/model execution and nightly Vercel delivery require the deployment canary in `SALES-WATCH-DEPLOY.md`.

## Policy and persistence

- Sales top ten capped, deduplicated by customer, separate from service.
- No-call, no-phone, low-confidence, superseded and stale recommendations suppressed.
- Post-sale service remains visible.
- Customer holds override conflicting quote outreach suggestions.
- Every quoted context requires its own structured assessment, with literal evidence validation.
- Empty evidence cannot produce a non-review quote decision.
- Quote channel gaps downgrade immediate outreach to review-first.
- Inventory stages classified with optional explicit IDs; completed warranty stages excluded by default.
- Repeatable migration with and without Supabase roles; row-level security and revoked access.
- Run-scoped snapshots retain history without carrying moved deals into a new inventory.
- Database lease excludes concurrent workers; dispositions and no-call preferences persist separately.
- Actual source, Google SDK response parsing, runner and read-store exercised together with mocked HTTP and PGlite: new call, fulfilled promise/hold, no-call with zero findings, preference retention, partial batch and resumed completion.

## UI and HTTP checks

- Desktop and mobile initial view: hierarchy, readable rows, no horizontal overflow.
- Quote tab: assessments, filter selection and reset, evidence expansion, missing/pending status.
- Service and manager tabs: distinct queues and detailed recommendations.
- Search: matching customer and empty-result recovery.
- Refresh: confirmation, cancellation and synthetic successful state.
- Disposition: resolve, persistent note in returned state, removal from active queue.
- Dark mode and dense quote detail readability.
- Anonymous GET, missing/wrong cron auth, cross-origin POST and unconfirmed refresh blocked.
- Disabled cron skips and disabled disposition cannot write.

## Exclusions

No production database migration, customer communications, CRM mutations or model canary is performed by these local tests. The local Next build uses a deliberately unreachable synthetic Postgres URL to satisfy the existing database module's import-time configuration requirement; successful compilation is not a connectivity test.
