# cro-engine — CRO Measurement Pipeline

Server-side collector for GA4 events. Receives front-end funnel signals and purchase events, forwards to Google Analytics 4 Measurement Protocol.

Part of the CRO Framework (AGI-9000326).

## Architecture

- **Front-end events** (`/events`): thin first-party signal (event name + params) from pages
- **Server-side purchase** (`/purchase`): fired by stripe-payments after successful payment record
- **GA4 Measurement Protocol**: direct API call to Google's servers (no client-side gtag)

Multi-tenant: brand key resolved from `sites.clients.id`.

## Consent

Events currently forward without consent gating. Planned integration:

- **TrustCentre module** (preferred): directly check consent signal from trust-center worker
- **Zaraz bridge**: fallback consent consent gate if TC integration is delayed

Until wired, use the /health endpoint to verify bindings.

## Deployment

```bash
# Local dev
npm run dev

# Deploy (GitHub Actions only — see .github/workflows/deploy.yml)
git push origin main
```

GitHub Actions deploys via Cloudflare API (direct CF API, NOT wrangler).

## Endpoints

- `POST /events` — Frontend event ingest
- `POST /purchase` — Server-side purchase (from stripe-payments)
- `GET /health` — Binding status

## References

- Parent: AGI-9000326 (CRO Framework)
- Perf gate: AGI-9000298 (Rule 37)
- Consent: AGI-9000074 / AGI-9000260 / AGI-9000131
- Runbook: CRO Framework doc (Instrument a tenant + Conversion event taxonomy)
- Event vocabulary: page_view, health_index_start, health_index_complete, begin_checkout, purchase, member_activate
