# Public status pages

Status pages are workspace-owned records with globally unique ASCII slugs. Only active owners and administrators can manage them. Public reads use dedicated response allowlists: workspace IDs, internal incident IDs, people, integrations, activity metadata, and subscriber addresses never appear in public responses.

Publishing is explicit. Linking an internal incident does not copy its timeline, responders, runbooks, tasks, logs, resolution notes, or metadata. A public incident requires a separately written title, summary, impact statement, and first update. Later updates are append-only. Corrections should be represented by a new update linked to the original; internal activity records remain separate from public updates.

Public routes are under `/api/status/:slug` and the standalone client route is `/status/:slug`. Public snapshots are cached for 30 seconds and support ETags. Private previews require a 15-minute scoped token and use `private, no-store`; they are excluded from history, subscriptions, and public realtime delivery. Historical queries are paginated and limited to 90 days.

The public API provides `GET /api/status/:slug`, bounded component history at `GET /api/status/:slug/history`, and a dedicated read-only SSE stream at `GET /api/status/:slug/events`. SSE carries event categories only; clients recover the current allowlisted representation through the snapshot endpoint. `Last-Event-ID` resumes after the exact stored event, polling remains enabled, and publication is rechecked while each connection is open. Unknown, disabled, archived, draft, and private pages all return the same not-found response.

Maintenance timestamps are stored in UTC and displayed in the page's IANA timezone. The automation worker starts and completes due maintenance idempotently. It snapshots each component status and revision. Completion restores a prior status only when the component still has the maintenance revision, so a newer manual or incident change wins.

Subscriptions minimize stored data. Addresses are authenticated-encrypted with the automation keyring and indexed by a page-scoped hash. Verification and unsubscribe tokens are random, hashed, expiring where applicable, and consumed once. Email requires double opt-in. Public responses are generic to resist address enumeration. No email or webhook delivery is claimed when an adapter is unavailable; administrative delivery health records `DELIVERY_ADAPTER_UNAVAILABLE` instead.

`STATUS_WEBHOOK_SIGNING_SECRET` enables the generic HTTPS webhook adapter. The existing outbound transport rejects credentials, redirects, non-HTTPS destinations, private/reserved IP space, and DNS answers outside public ranges. Each body is signed with stable event and delivery IDs. Email has no built-in transport in this milestone and remains unavailable until an approved adapter is supplied. Tests inject a fake adapter and never call an external service.

`STATUS_SUBSCRIBER_LOOKUP_KEY` is a separate stable 32-byte hex HMAC key used only for address lookup. Keep it stable while rotating `AUTOMATION_ENCRYPTION_KEYS`; rotating it requires an explicit subscriber-hash migration.

Publication events share the existing durable worker. Event IDs and subscriber delivery keys are stable, eligibility is checked during fan-out, failures are isolated by subscriber, retries are bounded, and terminal failures remain visible. Worker leases and MongoDB transactions provide restart recovery. Deploy the API and automation worker against the same replica-set database and key configuration.

Delivery dispatch rechecks verification, unsubscribe state, incident/maintenance preferences, and component selection immediately before sending. Retry delay uses bounded exponential backoff and jitter; a stable idempotency key prevents duplicate rows after worker recovery. Administrators see aggregate subscriber counts and sanitized failure codes, never addresses or tokens. Retention can remove expired unverified subscribers and old terminal delivery rows according to the workspace policy without affecting status history.

Availability and duration metrics are calculated from Flowryn's recorded public component-status intervals. They are communication records, not independent synthetic or external monitoring.

Management endpoints live below `/api/workspaces/:workspaceId/status-pages` and require an active owner or administrator. They cover page publication and archival, component/group ordering and health, incident draft/publication/update/correction/link/archive, maintenance scheduling and lifecycle, aggregate subscribers, delivery retry, and metrics. Every identifier is validated and every database filter includes the authenticated workspace and page scope. Published incident updates are append-only; corrections append a record that points to the corrected update.

Public text is rendered as text, never raw HTML. Branding accepts only a URL and hex color. Public responses use a restrictive Content Security Policy, bounded collections, rate limits, and generic not-found behavior.
