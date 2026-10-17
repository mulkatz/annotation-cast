# 0007: reconcile interrupted capture on worker boot

- Status: accepted
- Date: 2026-10-17

## Context

An actual isolated Chromium crash retained recording bytes and frame metadata, but
the command-line unpacked extension did not receive onStartup after relaunch.
Extension reloads also leave durable recording checkpoints without live capture.
An ordinary MV3 worker restart must preserve a surviving offscreen recording.

## Decision

- Reconcile once per worker boot, with onStartup registered to wake the worker.
- Query offscreen contexts successfully before deciding capture was lost. Preserve
  state when any offscreen document survives; never infer absence from API failure.
- Without an offscreen document, mark durable recording checkpoints interrupted,
  retain media, derive duration from saved evidence, and append a recovery gap.
- Clear stale active/readiness state only when recovering a checkpoint or stale
  active capture. Preserve fresh readiness across ordinary idle worker restarts.
- Gate recording creation, runtime operations, and toolbar initialization on the
  same boot promise, avoiding a new recording racing the recovery scan.
- Share concurrent attempts; cache success and allow a later operation to retry
  failed context/storage inspection. Persist a stable gap before its checkpoint
  so failed writes cannot lose or duplicate recovery evidence on retry.
- Hold the existing per-session mutation lock and re-read its checkpoint before
  writing, so a concurrent deletion cannot resurrect metadata from an older scan.

## Alternatives

- onStartup only: missed the observed unpacked crash/reload case.
- Recover on every worker activation without checking offscreen state: corrupts
  the status of valid recordings whose worker was suspended normally.

## Consequences

Reconciliation is idempotent. Retained bytes do not guarantee crash media is
playable, and unfinished audio segments may be lost. Failed context inspection
blocks dependent operations rather than incorrectly declaring capture interrupted.
