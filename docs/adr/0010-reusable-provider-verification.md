# 0010: reusable provider verification and automatic local recording checks

- Status: accepted
- Date: 2026-10-18
- Partially supersedes: [0003](0003-provider-and-sanitization.md), [0004](0004-capture-lifecycle.md)

## Context

Repeating paid API probes before every recording adds cost and manual setup without
preventing later provider outages. Failed local capture and reopening controls also
forced unnecessary rechecks. The user requested a simpler recording workflow.

## Decision

- Verify timestamped speech and structured image output with the existing synthetic
  probes on explicit connection verification; label its possible API charges.
- Reuse success for strictly less than 24 hours in trusted extension local storage,
  bound to key digest, exact transcription/analysis models, and probe contract version.
- Invalidate on changed credentials/models/contract, expiry, or provider authentication,
  model-access, or compatibility failures. Local capture failures do not invalidate it.
- Start recording automatically checks microphone signal, selected tab/site access,
  quota/write access, and optional diagnostics. Keep fresh single-use local readiness
  bound to the tab and key; background enforces both receipts before capture.
- Serialize provider settings/receipt writes; a late failure for an older key cannot
  revoke a newer key verification. Only store probe success for the current saved key.
- Display connection verification time independently from local setup checks.
- Preserve cached verification for unchanged-key saves and reopened controls.

## Alternatives

- Remove all preflight: permits recordings with known unusable inputs or setup.
- Reprobe every recording: keeps the observed friction and repeated charges.
- Cache indefinitely: hides stale compatibility after provider changes.

## Consequences

Recording needs fewer manual steps while retaining actual local setup checks. Cached
provider success is not a guarantee of current credit, connectivity, or availability.
Expired verification requires an explicitly disclosed paid check, not a silent request.
