# Annotation Cast

A standalone Chrome/Chromium Manifest V3 extension for narrated web app tests.
Record one tab and your microphone, mark observations, analyze with a personal
OpenRouter key, and download an evidence bundle for a coding agent. No backend
or local server is needed to use the extension.

## Install

Requires Node.js 22.12+ and Chrome/Chromium 120+.

```sh
npm ci
npm run verify
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `dist` directory.
3. Pin **Annotation Cast** to the toolbar. Open the web app you want to test and
   click the extension button on that tab. An extension control page opens.
4. Enter and save your personal OpenRouter key. Add optional session notes.
5. Run readiness, speaking into the microphone when prompted. The bundled
   synthetic audio/image requests may incur small API charges. Recording remains
   blocked until microphone signal, page access, local storage, timestamped
   transcription, and structured image analysis pass.
6. Start recording and return to the selected tab. Stop from the control page;
   reopening the toolbar button during recording opens the controls again.
7. Review the transfer overview, select **Start analysis**, then **Download ZIP**.

Rebuild after changing code and click **Reload** on the extension card. Reloading
or uninstalling during capture interrupts it. Uninstalling removes local data.

## Recording and evidence

- Only the selected tab's video and microphone are captured; tab audio is excluded.
  Closing the control page does not stop recording. Closing the selected tab finalizes it.
- Sessions stop automatically after 30 minutes. Readiness requires 1.5 GB available
  local quota; actual requirements depend on page content and browser encoding.
- **Alt+Shift+P** marks the current pointer without clicking the page.
  **Alt+Shift+R** starts a rectangle; drag and release, or press Escape to cancel.
  Configure conflicts at `chrome://extensions/shortcuts`.
- DOM candidates, their small style allowlist, viewport, theme preference, and
  explicit text selection are frozen with markers. Form values and keystrokes
  are not collected. Selectors help search; they do not identify confirmed source files.
  Selection traversal is bounded to 2,000 characters and 500 nodes, omits hidden
  and editable content, and records when the quote was shortened or content omitted.
- Evidence frames are extracted from the captured stream every two seconds, up to
  960 px wide, and tagged with measured timestamps. Pre/post-marker frames help
  avoid overlays. Sampling can miss a brief tooltip or state; associations may
  remain uncertain. Images are reduced samples, not pixel-perfect measurements.
- Same-tab navigation continues video and microphone capture. An origin change may
  revoke DOM permission: return to the recorded tab and click the toolbar button
  to restore temporary access. **Restore page access** can request ongoing access
  for an origin when its URL is available.
  Cross-origin iframe internals, browser pages, and some protected pages are inaccessible.
- Optional debugger diagnostics collect bounded console messages, errors/stacks,
  and network URL/method/status/duration/errors. No headers, cookies, or request or
  response bodies are exported. Only the attached main target and available in-process
  frames are covered; separate frame/worker targets are not automatically attached.
  DevTools can disconnect diagnostics independently of recording. Limits and gaps
  appear in status/event evidence.

## Providers and privacy

The single candidate combination is `openai/whisper-large-v3` for transcription and
`google/gemini-2.5-flash` for image/text analysis. It follows the current official
[OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt),
[image input](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding),
and [structured output](https://openrouter.ai/docs/guides/features/structured-outputs)
contracts. A candidate is usable only after the real readiness probe passes for
your key and current provider routing. Documentation and synthetic tests do not
establish live compatibility.

Keys stay in trusted extension storage. They are never sent to the tested page
or included in exports. Requests go directly to OpenRouter and its routed model
providers; their retention and billing policies apply. Do not use sensitive data
without understanding those policies.

Before text transmission and export, supported secret patterns, sensitive fields,
configured key values, URL credentials/query values/fragments are replaced or
removed locally. The returned transcript is sanitized again before image/text
analysis. The overview lists replacement counts and data types without showing
matched values. Sanitization is pattern based and cannot detect every secret.
**Audio, images, and the original video are not automatically anonymized.** Later
transcript sanitation cannot undo the audio already transferred for transcription.
You can cancel analysis and explicitly delete the local session.

## Processing, recovery, and ZIP format

Video is appended to an OPFS file and flushed every recorder chunk. Audio uses
independent, playable 60-second recordings starting every 59 seconds, preserving
one second of overlap. Segment timestamps map to the recording timeline; recorder
chunk numbers are not timestamps. Metadata/events and completed provider steps
are persisted locally. Analysis runs in two-minute batches with up to 12 images,
160 events / 48 KiB of event context, and 256 complete transcript statements /
64 KiB of transcript context per request. Omission counts appear in exported status
events; complete original evidence remains available in the sanitized export.
Frames are distributed across narration and markers throughout the batch.

Narration from 30 seconds before and after a batch supplies nearby context and
corrections. Findings belong to the batch of their supporting source statement;
their visual timestamps may describe an earlier moment. More distant corrections
do not automatically revise earlier findings and require manual review. A missing
statement or ambiguous association must not be interpreted as complete coverage.

Transient provider failures retry at most twice; authentication/schema errors and
long rate-limit waits fail explicitly. Retry resumes saved transcription and
analysis checkpoints. Closing the control page cancels its in-flight processing;
reopen and retry to continue. Separate control pages cannot process/delete/export
the same session simultaneously. After a browser crash, completed audio segments,
flushed video, and saved frames are retained best effort and interruptions marked.
An unfinished segment may be lost and a recovered recording may not be playable.

The normal export requires successful analysis; there is no standalone raw export,
results editor, or automatic code-fixing integration. Sessions persist until
explicit deletion. ZIP writing streams media from disk back to disk, without
building multiple full in-memory copies of the recording. Preparing a ZIP requires
additional local space roughly equal to the recording and images.

| Path                | Contents                                                                      |
| ------------------- | ----------------------------------------------------------------------------- |
| `README.md`         | Agent reading workflow and evidence/privacy limitations                       |
| `recording.webm`    | Selected tab video with synchronized microphone                               |
| `report.md`         | Unreviewed findings, quotes, screenshots, and time references                 |
| `issues.json`       | Versioned findings with stable IDs and evidence references                    |
| `transcript.json`   | Sanitized timestamped source statements                                       |
| `events.json`       | Sanitized markers, interactions, diagnostics, gaps                            |
| `session.json`      | Version, measured recording timeline, notes, models, processing state, frames |
| `screenshots/*.jpg` | Timestamped evidence samples                                                  |

Times are milliseconds from recording start; media time zero maps to session time
zero. Frames and speech use measured times rather than indices. WebM is recorded
as a continuous stream; some players may show an unknown duration until playback.
Use `session.json` for the measured timeline. Findings are automatically generated
and unreviewed. Observations and tentative AI causes are separate; unsupported
expected behavior and reproduction steps stay absent. Validate statements and
images before deciding a code change is required, and verify any later fix separately.

## Development and verification

```sh
npm run verify          # formatting, lint, strict types, synthetic tests, build, secrets
npm run format          # apply formatting
npx playwright install chromium
npm run test:browser    # isolated Chromium setup, microphone, toolbar, page-access smoke
npm run test:media      # canvas/microphone -> local media -> mocked AI -> streamed ZIP
npm run test:selection  # real DOM ranges, hidden/form text omission, traversal limits
BROWSER_CAPTURE=1 BROWSER_RECORD_SECONDS=65 npm run test:browser
# Set BROWSER_RECORD_SECONDS=1800 for the full-duration capture check.
```

`tests/setup.ts` blocks real fetch by default. Provider tests use synthetic fixtures;
no credentials, private captures, or user sessions belong in the repository.
Browser test artifacts/profiles and all scratch work live in ignored `.local/`.
The local secret scan prints locations/types only; CI additionally runs pinned
Gitleaks CLI full-history scans for pushes and pull requests, including forks,
without license keys, credentials, or PR commenting. Before first publication, also scan
full Git history. Runtime media sanitation and repository scanning are independent.
CI also runs the synthetic browser smoke, media/ZIP, and DOM selection checks without
provider credentials. The explicit real-tab capture check remains separate.
Architecture choices are recorded in `docs/adr/`; the agreed scope is `CONCEPT.md`.

## Manual acceptance walkthrough

Use a synthetic app and a short reference narration before testing real data.

1. Deny microphone access, try a bad key, and verify recording stays blocked. With
   a working key, readiness must return timed speech and correctly identify the sample image.
2. Record a hover state and mark it, draw two nearby rectangles, select ordinary
   text and mark it, then change DOM/styles. Say a delayed observation, correct an
   earlier statement, repeat one issue, and describe one issue without a marker.
3. Navigate within the tab, change origin, restore page access, scroll, resize/zoom,
   and inspect inaccessible iframe context. Verify separate microphone, recording,
   diagnostics, and context statuses. Open DevTools with diagnostics enabled and
   confirm recording continues after diagnostics disconnects.
4. Close/reopen controls during capture. Stop normally, then repeat with selected-tab
   closure. Inspect the video and captured marker coordinates/styles/selection.
5. Include synthetic bearer/key/query secrets in page/log text. Review the transfer
   overview and export: supported text matches must be absent; the unchecked-media
   warning must remain explicit. Do not use real secrets for this test.
6. Simulate a provider failure after transcription. Retry without repeating completed
   requests. Cancel analysis, reload controls, and resume. Inspect every ZIP file,
   its relative references, screenshots, source quotes, and uncertain associations.
7. Run a full 30-minute session, checking synchronization and bounded memory, playable
   WebM, automatic stop, ZIP integrity, and sufficient disk space. Test browser restart
   recovery separately. Score detection, false findings, and image association independently.

Implementation validation performed in this environment: the full `verify` gate,
Chromium setup/readiness-blocking/microphone/toolbar/page-access smoke, and a real
three-second canvas + synthetic microphone recording through OPFS, mocked API
processing, media decoding, sanitation, and complete ZIP inspection. Unit and
browser tests send no paid requests. These are synthetic media/provider checks.

The explicit real-tab capture test currently fails here at tab video acquisition
with `NotFoundError: Requested device not found`. A minimal implementation of the
official Chrome offscreen pattern reproduces the failure in Chromium 141 and 156,
including headed 156. Tab recording/playback, real audio overlap, navigation during
capture, and full 30-minute durability are therefore **not verified**. The explicit
capture command above retains these checks and fails when capture is unavailable;
the default smoke command does not silently claim them.

No provider credentials were available in the process environment or project-local
configuration. Live OpenRouter compatibility, real microphone permission/hardware,
crash recovery, and subjective finding quality still require the manual checks.
The documented model pair is provisional until a live readiness probe succeeds.
