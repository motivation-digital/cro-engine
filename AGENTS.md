# cro-engine

Server-side CRO measurement pipeline collector. Receives front-end funnel events + server-side purchase events, forwards to GA4 Measurement Protocol. Multi-tenant by brand key (sites.clients.id).

Deploys to: cro-engine (CF worker `cro-engine` on workers.dev)
Repo: https://github.com/motivation-digital/lifecycle

## ⛔ Must not change

- GA4_MEASUREMENT_ID binding (plain_text, G-KQH8EKYZ9L — locked to DBC property, used by dbc-site + dbc-index + dbc-portal + stripe-payments)
- GA4_API_SECRET binding (Secrets Store key cro-engine-dbc — provisioned in Rule 28 pattern)
- DB_SITES binding (multi-tenant tenant resolution)
- /events + /purchase routes (consumed by dbc-site, dbc-index, dbc-portal, stripe-payments)

## Current state

Live on workers.dev. /health endpoint returns binding status.

GA4 secret (cro-engine-dbc in Cloudflare Secrets Store) provisioned. Binding wired via deploy.yml metadata (Rule 28).

Front-end events: thin first-party signal flow from pages → cro-engine /events → GA4.
GA4 Measurement Protocol credentials are query parameters (not JSON fields); `/measurement/:tenant`
validates the payload, reads GA4 key events + Google Ads links, and exposes current event counts.
`/funnel/:tenant` reconciles the selected period from non-test D1 Contacts through the consented
measurement ledger, GA4 observation and Google Ads conversion-action attribution. It never treats
the difference between two sources as automatically lost leads. Result-page fallback delivery is a
separate diagnostic and never stands in for consented browser/ad-click identity.

Server-side purchase: stripe-payments webhook posts to /purchase after successful payment record.

Consent gate (TrustCentre signal / Zaraz bridge) — planned, not yet wired.

## Endpoints

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| POST | /events | Frontend event ingest | CORS-gated (consent pending) |
| POST | /purchase | Server-side purchase (from stripe-payments) | Internal |
| GET | /health | Binding status + deployed build SHA | None |
| GET | /funnel/:tenant?range=7\|30\|all | One selected-period funnel contract across GA4 traffic, Health Index leads, D1→GA4→Ads reconciliation, Google Ads engagement and Stripe checkout people/attempts, buyers, refunds and exclusions; defaults to 30 | None |
| GET | /measurement/:tenant | GA4 payload validation, key-event/link state, and 7/30-day lead/purchase event counts | None |
| POST | /measurement/:tenant | Idempotently create `health_index_complete` as a once-per-session GA4 key event | X-Admin-Key |

## D1 bindings

| Binding | Database | Access |
| --- | --- | --- |
| DB_SITES | sites | read (tenant resolution) |
| DB_INDEX | dbc-index | read (Health Index leads) |
| DB_PAYMENTS | payments | read (tenant-scoped payment outcomes + attribution exclusions) |

## Rules (inline — full rules in lifecycle)

- Rule 1: Confirm repo first. `pwd` and `git remote -v` before anything.
- Rule 2: Read before touching. Check AGENTS.md and current main.
- Rule 9: Trace all consumers before removing any parameter, endpoint, or field.
- Rule 14: Every session is referenced by its ClickUp task ID (e.g. `LCE-10000040`).
