# Change intelligence and release governance

Flowryn records deployment environments and immutable release revisions. It never runs a deployment, rollback, script, expression, repository operation, or user-provided URL. MongoDB remains authoritative; realtime messages are empty invalidation hints and clients reload REST state.

The Change Intelligence interface supports mobile and desktop layouts. Interactive controls use a minimum 44 CSS-pixel target, text may wrap without widening the document, and policy actions restore keyboard focus after confirmation and authoritative REST refresh.

Signed deployment ingestion uses the existing encrypted integration secret and raw-body HMAC verifier. Requests are limited to 64 KiB and 30 requests per integration per minute, require a UUID delivery ID, enforce the shared five-minute timestamp tolerance and constant-time comparison, and store a unique delivery receipt. Lifecycle sequence and event time prevent stale writes. Logs and responses omit bodies, signatures, credentials, metadata, and source details.

Policies are immutable workspace versions. Activation and rollback use replica-set transactions, expected-version comparison, and operation receipts. Approval decisions reauthorize active membership and the policy role at decision time, prevent duplicate voters, and enforce separation of duty. Approval records never cause deployment.

Risk is a deterministic 0–100 sum of ten bounded factors. Unknown SLO, monitor, ownership, or service evidence remains visible as unknown. Factors, weights, contributions, release revision, policy version, explanation, and evaluation time are immutable. Dependency and source queries cap counts at 100.

Pre/post health uses current bounded incident, alert, SLO, and monitor evidence and produces healthy, degraded, or unknown snapshots. It rechecks the release revision before persistence. Pre-deployment evaluation supports lifecycle governance. Terminal post-deployment evaluation is durable only when the active policy's `postHealthRequired` option is enabled; missing values on legacy policies default to enabled. Reconciliation and workers recheck the current active policy, so activation or rollback takes effect without treating obsolete queued work as a successful evaluation. Risk evaluation and terminal correlation remain mandatory regardless of this option. Correlations are candidates only; temporal proximity is never described as causation and confirmation is human-controlled.

The existing automation worker claims risk and health work with stable operation keys, 60-second leases, exponential retry bounded at five minutes, and dead-letter state after five attempts. Completion is fenced by lease owner. Administrative retry only accepts dead work.

Metrics use a maximum 366-day cohort. Empty cohorts return `insufficientData`; rates are `null` when their denominator is zero. Lists use stable `_id` cursors and at most 100 records.

Production requires the existing replica-set MongoDB, Redis realtime coordination, automation worker, and `AUTOMATION_ENCRYPTION_KEYS`. Integrations must explicitly allow `deployment.received` and rotate secrets using the existing integration API.
