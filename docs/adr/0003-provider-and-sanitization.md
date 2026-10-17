# 0003: direct provider adapters and local text sanitation

- Status: accepted
- Date: 2026-10-17

## Context

Annotation Cast needs timestamped speech and structured image analysis without a backend.
Provider model and endpoint capabilities change; documentation alone is insufficient proof.
Audio and screenshots may expose sensitive content that text pattern matching cannot remove.

## Decision

- Use separate direct OpenRouter transcription and analysis adapters with the user's personal key.
- Initially offer `openai/whisper-large-v3` and `google/gemini-2.5-flash` only.
- Request `verbose_json` segment/word timestamps through `/audio/transcriptions`.
- Request strict JSON schema image/text output with `require_parameters: true`.
- Before recording, require a paid probe with bundled synthetic spoken WAV and a synthetic blue PNG; reject missing speech timestamps or invalid image/schema output.
- Treat the combination as ready only after this actual probe succeeds in the current installation.
- Convert provider seconds to the explicit audio segment's session timeline in milliseconds.
- Validate output shapes, durations, page references, duplicate IDs, and evidence/quote IDs locally.
- Limit requests to three attempts, bound backoff and timeout, respect cancellation, and defer long Retry-After waits to an explicit later retry.
- Sanitize supported text recursively before analysis and text export, including known configured key values, supported credential formats, sensitive named string fields, and URL query values/fragments.
- Never include provider error bodies, request content, or credentials in errors.
- Treat captured content as untrusted evidence. Observations cite transcript statements; tentative causes remain separate hypotheses.

## Alternatives

- Generic audio chat: insufficient reliable timestamps.
- `gpt-4o-transcribe`: official OpenRouter docs explicitly identify unsupported verbose output.
- Dedicated backend or local transcription server: outside the standalone MVP.
- Claim automatic media anonymization: unsupported and misleading.

## Consequences

Readiness may incur small charges and does not guarantee future credit or availability.
Pattern matching is incomplete; audio/images and the original video remain unchecked media.
Silence may produce an empty transcript, but a readiness sample must produce actual timestamped speech.
Adapters use synthetic mocked HTTP fixtures by default; live compatibility requires explicit configured access.

## References

- [OpenRouter speech-to-text](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding)
- [Current transcription models](https://openrouter.ai/api/v1/models?output_modalities=transcription)
- [Analysis endpoint capabilities](https://openrouter.ai/api/v1/models/google/gemini-2.5-flash/endpoints)
