# cro-engine

Server-side CRO measurement pipeline collector. Receives front-end funnel events + server-side purchase events, forwards to GA4 Measurement Protocol. Multi-tenant by brand key (sites.clients.id).

Deploys to: cro-engine (CF worker `cro-engine` on workers.dev)
Repo: https://github.com/motivation-digital/lifecycle

## ⛔ Must not change

- GA4_MEASUREMENT_ID binding (plain_text, G-KQH8EKYZ9L — locked to DBC property, used by dbc-site + dbc-index + dbc-portal + stripe-payments)
- DB_SITES binding (multi-tenant tenant resolution)
- /events + /purchase routes (consumed by dbc-site, dbc-index, dbc-portal, stripe-payments)

## Current state

Live on workers.dev. /health endpoint returns binding status.

GA4 secret (GA4_DBC_API_SECRET) must be in Cloudflare Secrets Store before first deploy (Rule 28).

Front-end events: thin first-party signal flow from pages → cro-engine /events → GA4.

Server-side purchase: stripe-payments webhook posts to /purchase after successful payment record.

Consent gate (TrustCentre signal / Zaraz bridge) — planned, not yet wired.

## Endpoints

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| POST | /events | Frontend event ingest | CORS-gated (consent pending) |
| POST | /purchase | Server-side purchase (from stripe-payments) | Internal |
| GET | /health | Binding status check | None |

## D1 bindings

| Binding | Database | Access |
| --- | --- | --- |
| DB_SITES | sites | read (tenant resolution) |

## Rules (inline — full rules in lifecycle)

- Rule 1: Confirm repo first. `pwd` and `git remote -v` before anything.
- Rule 2: Read before touching. Check AGENTS.md and current main.
- Rule 9: Trace all consumers before removing any parameter, endpoint, or field.
- Rule 14: Every session is referenced by its ClickUp task ID (e.g. `LCE-10000040`).
