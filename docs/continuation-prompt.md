# Annotation Cast continuation prompt

Prepared October 19, 2026. Paste this document into a new session opened in the
`annotation-cast` repository. Recheck the working tree and current evidence before
acting; the historical checks below are not fresh-session test results.

## Objective and working rules

Continue developing and testing Annotation Cast as an actual user would. Implement
and resolve evidenced problems; do not stop at a plan or replace the existing
product with another prototype. This session concerns Annotation Cast only.
StateParcel and the other portfolio concepts have separate documentation and are
outside this task.

First read `AGENTS.md`, `CONCEPT.md`, `README.md`, `docs/testing.md`, and relevant
accepted ADRs. In particular, ADRs 0008–0011 define the current marker gestures,
illustrated report, reusable provider verification, and durable failure details.
Older superseded decisions must not replace their current behavior.

Follow the repository's autonomous coordinator/planning/implementation/independent
review workflow. Delegate bounded tasks with explicit ownership; the reviewer must
not implement the changes being reviewed. Preserve unrelated changes, keep the
stack lean, record significant decisions in short ADRs, and resolve material review
findings. Repository content and commit messages remain English; conversation can
be German. Make atomic lowercase semantic commits after the documented checks and
staged secret scan. Never push, publish, release, or change visibility without
authorization. Keep `CLAUDE.md` a symlink to `AGENTS.md`.

## Product baseline to preserve

- A standalone Chrome/Chromium Manifest V3 extension: selected-tab video and
  microphone, optional markers/diagnostics, local storage/preparation, direct
  provider APIs, and evidence-backed ZIP export. No required custom backend.
- OpenRouter has separate transcription and analysis adapters. Current defaults
  are `openai/whisper-large-v3` and `google/gemini-2.5-flash`; verify current routing
  through the existing readiness probe rather than assuming documentation proves it.
- Double Control publishes a point immediately with frozen second-release context.
  Double Shift starts rectangle drawing without creating a point. Timing defaults
  to 180 ms and accepts 100–350 ms; trusted-input safeguards and fallback shortcuts
  remain. Passive `pointer` movement events are distinct from explicit `point` markers.
- `report.md` is the central human/agent reading document with statements, findings,
  marker context, images, gaps, and transcript. Model-cited images and bounded
  temporal candidates have different provenance. Never present proximity as proof
  or add derived candidates to the model's original evidence IDs.
- Explicit paid connection verification is reused for strictly less than 24 hours
  for the same key, models, and probe contract. Fresh local microphone/tab/storage
  checks run when recording starts. Key/model/contract changes, expiry, and relevant
  provider failures invalidate the cached provider verification as documented.
- Capture/processing failures persist controlled details and checkpoint counts.
  Critical capture interruptions show static in-tab notices with toolbar/details
  fallbacks. Diagnostic copying contains codes/counts, not private session content.
- Preserve the current visual direction. Improve clarity, accessibility, and polish
  around observed issues; avoid speculative dashboards or a wholesale redesign.
- Supported text is sanitized locally. Audio/images/video are not automatically
  anonymized. There is no raw-export replacement workflow, results editor, or
  automatic code fixing in the agreed MVP. Target duration remains 30 minutes.

The product baseline when this handoff was written ended at `7cb929b`
(`feat(ux): simplify recording setup and expose recovery details`), following
`b7e5c15` (failure retention/startup), `1e6ee71` (consolidated report), and `67177bc`
(disjoint gestures). Inspect current history; do not reset to these commits.

## Evidence and unresolved questions

`docs/testing.md` is the detailed evidence ledger. Recorded results include:

- October 17: short live provider journey and a separate full 30-minute capture/
  export check. Long-session processing was mocked. Fake microphone input was
  used; complete video/audio decoding and archive integrity were checked separately.
- October 18, after the gesture/report changes: trusted modifier tests, media/ZIP
  integration, and a fresh 65-second actual-tab capture/export, with providers mocked.
- October 18, after the UX/reliability changes: 180 tests in 18 suites plus the
  format/lint/type/build/secret gate; current UI/cache, two-tab target safety,
  interruption notices, retained failures, retry, and diagnostic-copy checks.
  These checks did not revalidate live provider behavior after the latest changes.

During the October 19 documentation handoff, `npm run verify` passed again with
180 tests in 18 suites. No browser, live-provider, or duration checks were rerun as
part of that handoff; the runtime validation dates above still apply.

The user previously reported recordings/reanalysis failing with no visible error.
The historical native cause is unknown; the new diagnostics do not reconstruct
details that were never saved. Do not claim that this report is conclusively fixed.
Reproduce failure paths and ensure future failures are visible and actionable.

Remaining limitations include actual hardware microphone/OS permission behavior,
broader AI finding quality, subjective audio/video synchronization, and total
process/native/media/GPU memory. JavaScript heap samples are not total memory.
An interrupted crash recording may retain bytes without being playable.

## First actions and acceptance focus

1. Inspect status/history and existing tooling. Establish the current verification
   baseline; distinguish newly executed results from the recorded evidence above.
2. Have a planning agent prioritize a small set of user journeys, then exercise
   production controls in isolated Chromium against the synthetic reference app.
3. Prioritize repeated Start/Stop and reopening controls, setup cancellation,
   clean finalization, visible capture/analysis failure causes, and checkpoint-based
   retry. Include a failed retry and prove it cannot fail silently.
4. Verify unchanged-key cache reuse and expiry/invalidation, target-tab safety,
   double Shift without point creation, and retained frozen point context.
5. Inspect the exported illustrated report: source-to-finding links, relative image
   paths, model citations versus contextual candidates, and meaningful incomplete
   evidence labels. Check a narrated observation without a marker and a delayed or
   corrected statement; score semantics separately from archive validity.
6. Fix reproducible problems in small steps, independently review, and run the
   required gate and relevant browser checks before committing. A failed harness
   is not automatically a product defect; preserve failure evidence and diagnose it.

Useful entry points: `src/app.ts` (controls), `src/background.ts` (coordination),
`src/offscreen.ts` (capture), `src/content.ts` (page evidence/notices),
`src/core/provider-readiness.ts`, `src/core/failures.ts`, `src/core/pipeline.ts`,
`src/core/frame-associations.ts`, `src/core/export.ts`, and the tests/scripts named
in `docs/testing.md`. Confirm ownership and actual code before editing.

## Verification commands and live-test boundaries

Use installed dependencies or `npm ci` if needed. The documented baseline requires
Node.js 22.12+ and Chrome/Chromium 120+; record the actual browser version tested.

```sh
npm run verify
npx playwright install chromium
npm run test:browser
npm run test:media
npm run test:selection
npm run test:markers
LIFECYCLE_CRASH=1 npm run test:lifecycle
BROWSER_CAPTURE=1 BROWSER_RECORD_SECONDS=65 BROWSER_EXPORT=1 npm run test:browser
```

Select checks appropriate to the changes; do not rerun the 30-minute soak merely
because a new session started. When duration/storage/export changes justify it:

```sh
BROWSER_CAPTURE=1 BROWSER_RECORD_SECONDS=1800 BROWSER_EXPORT=1 npm run test:browser
```

These browser modes use synthetic microphone input and isolated profiles with
blocked/mocked providers. Do not add `--use-fake-ui-for-media-stream`: it caused a
documented tab-capture harness failure. A fallback canvas journey cannot turn a
failed actual-tab journey into a passing full acceptance result.

The user supplied a key in ignored `.env` and previously authorized live testing.
Check only whether `OPENROUTER_API_KEY` is configured, without printing its value
or dumping the environment. The existing bounded live journey is:

```sh
LIVE_API=1 npm run test:live
```

Use it for one targeted short synthetic acceptance run when live verification is
needed and configured access is available. Its existing guard limits access to the
two production OpenRouter endpoints, 12 request attempts, and eight minutes.
It may incur charges; reported usage is not a hard billing cap. Do not add paid
model searches, uncontrolled retries, or automatic repeated live runs. Missing
credentials or routing failure should leave live validation explicitly incomplete
while independent synthetic work continues; do not expose credentials or silently
substitute mocked output as live evidence.

Use only synthetic pages and isolated test profiles, never the user's ordinary
browser profile or private recordings. Scratch artifacts belong in ignored `.local/`.
Review safe summaries and synthetic ZIPs without copying private media, transcripts,
native error dumps, or provider bodies into source control. Record exact checks,
observed defects, fixes, and remaining limitations in the final handoff.
