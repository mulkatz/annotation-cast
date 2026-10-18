# 0011: durable failure details and recording interruption notices

- Status: accepted
- Date: 2026-10-18

## Context

Generic capture replies erased actionable causes. Analysis preflight errors happened
outside the persisted failure boundary, so retries could fail without session details.
Audio-recorder startup exceptions could leave an unresolved completion promise.

## Decision

- Roll back recorder startup failures and settle pending work before finalization;
  handle recurring audio-start exceptions by interrupting and releasing capture.
- Keep at most 20 optional structured failures per session: phase, code, controlled
  message, time, retryability, and optional step/HTTP status. Old sessions remain valid.
- Preserve original capture causes through cleanup/finalization. Validate required
  local media before paid processing; resume successful checkpoints after failure.
- Classify provider transport, JSON/schema, evidence-reference and timeline errors
  without storing provider bodies, offending values, constraints, or raw native text.
- Show durable session details, retained work counts, and actionable retry guidance.
  Copy diagnostics includes codes/counts only, never page/media content or messages.
- Notify the recorded page of critical interruption/muted media via static copy in a
  closed shadow root, without focus or layout changes; toolbar badge and extension
  details remain fallback when page access is unavailable. Clear recovered warnings.

## Alternatives

- Toasts alone: disappear and do not diagnose failures after reopening controls.
- Raw exception/provider dumps: risk exposing credentials and private session content.
- Reset all checkpoints on retry: repeats paid work and loses successful progress.

## Consequences

Failures become inspectable without exporting private evidence. This diagnoses future
failures; historical sessions cannot reconstruct causes that were never recorded.
Capture warnings can appear in the recorded video and contain only static safe text.
