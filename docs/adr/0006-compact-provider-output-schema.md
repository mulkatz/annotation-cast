# 0006: compact generation schemas with complete local validation

- Status: accepted
- Date: 2026-10-17

## Context

Live user acceptance reached recording and transcription, but Gemini 2.5 Flash
rejected the full findings JSON schema with HTTP 400: its combined length, array,
number, and pattern constraints produced too many serving grammar states.
The previous color-only readiness schema did not expose this incompatibility.

## Decision

- Generate the provider schema from the same Zod contract, omitting string lengths,
  patterns, array counts, and numeric bounds only from the transmitted schema.
- Retain required fields, types, enums, nullability, and closed object structure.
- Validate returned JSON against the complete original Zod schema, followed by all
  timeline, evidence, quote, and page checks. Invalid output fails explicitly.
- Include the findings structure alongside color recognition in the existing
  readiness image request; require blue and an empty findings array.
- Keep response token limits and bounded retries. Do not weaken local validation
  or silently accept malformed results to accommodate provider differences.

## Alternatives

- Switch models: unnecessary before testing the smaller supported schema.
- Maintain two independent contracts: risks drift between generation and validation.
- Keep color-only readiness: permits recording despite incompatible finding schemas.

## Consequences

Provider generation does not enforce every semantic limit; local validation does.
The readiness probe exercises the production findings structure without another
paid request. Live validation remains specific to the tested routing and date.

## References

- [Gemini structured output limitations](https://ai.google.dev/gemini-api/docs/structured-output)
- [Zod JSON schema overrides](https://zod.dev/json-schema#override)
