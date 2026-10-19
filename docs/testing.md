# Autonomous user acceptance

The normal verification gate and browser tests block paid providers. The separate
user acceptance runner uses a personal key and must be enabled explicitly:

```sh
npm run verify
npx playwright install chromium
LIVE_API=1 npm run test:live
```

Configure `OPENROUTER_API_KEY` in the process environment or ignored project `.env`.
The runner checks `LIVE_API=1` before loading that file or starting any network access.
Never put credentials in command arguments, fixtures, reports, or version control.

The browser harness keeps `--use-fake-device-for-media-stream` for synthetic
microphone input and grants only microphone permission. Do not add
`--use-fake-ui-for-media-stream`: that automation switch caused tab video
`NotFoundError` in the tested Chromium builds. Removing it restored genuine tab
capture; a 65-second production recording and exact fixture-color checks passed.
This was a harness failure, not proof that the browser could not capture tabs.

## Development commands

```sh
npm run verify          # formatting, lint, strict types, synthetic tests, build, secrets
npm run format          # apply formatting
npx playwright install chromium
npm run test:browser    # setup, microphone, toolbar, page access, provider cache
npm run test:media      # canvas/microphone, mocked AI, checkpoints, streamed ZIP
npm run test:selection  # DOM ranges, hidden/form text omission, traversal limits
npm run test:markers    # trusted gestures, frozen point context, rectangle and focus
LIFECYCLE_CRASH=1 npm run test:lifecycle
```

`tests/setup.ts` blocks real fetch by default. Provider tests use synthetic fixtures;
no credentials, private captures, or user sessions belong in the repository.
Browser artifacts, isolated profiles, and scratch work live in ignored `.local/`.

The local secret scan prints locations/types only. CI also runs pinned Gitleaks CLI
full-history scans for pushes and pull requests, including forks, without credentials,
license keys, or PR commenting. Before first publication, scan full Git history.
Repository scanning and runtime media sanitation are independent requirements.
CI runs the 65-second capture/export, crash-inclusive lifecycle, trusted gestures,
media, and DOM selection checks with blocked or mocked providers. Live APIs and
the half-hour soak remain opt-in.

See the [user guide](user-guide.md) for operating instructions and the
[continuation prompt](continuation-prompt.md) for a new development session.

## Documentation demo

Requires Playwright Chromium (`npx playwright install chromium`) and FFmpeg/FFprobe
on `PATH`. Build the extension, then generate the README demo:

```sh
npm run build
node scripts/create-demo.mjs
```

The silent demo records the production controls and actual selected-tab capture against a
synthetic app with a fake microphone and mocked AI responses. It loads no `.env`,
uses an isolated profile, and makes no paid provider calls. Raw recordings, profiles,
and scratch files stay in ignored `.local/`; final documentation media is written to
`docs/assets/`. This demonstrates the workflow, not live provider compatibility.

## Verification layers

- `npm run verify` checks strict types, formatting, lint, synthetic behavior, build,
  and secrets with real provider fetch blocked by default.
- `npm run test:browser`, `npm run test:selection`, and `npm run test:markers`
  exercise the actual extension UI, browser permissions, DOM evidence, trusted
  keyboard gestures, and focus behavior without paid requests.
- `npm run test:media` records synthetic canvas/microphone media and exercises
  production local storage, mocked provider contracts, and streamed ZIP integrity.
  It also drives analysis failure, reopening controls, another failed retry, and
  recovery through the production UI, asserting checkpoint reuse and visible history.
- `LIVE_API=1 npm run test:live` drives the real product journey with the synthetic
  reference app and actual provider calls. Its full-journey result must pass every
  stage; a successful partial canvas result cannot turn a failed tab journey green.

The runner drives the actual toolbar and production controls: save a key, run real
readiness, start the selected tab and synthetic microphone, place modifier markers,
navigate, stop, analyze, and download a ZIP. It uses a local synthetic app and the
bundled synthetic spoken WAV, never a personal page or hardware microphone.
The reference narration reports a missing blue primary button. The runner checks
that a finding cites the timestamped source statement containing that observation;
`referenceObservationLinked` establishes that link, not semantic correctness.
Inspect the synthetic ZIP report for correct descriptions, negations, false findings,
and visual association separately from timestamp, sanitation, and archive integrity.
The absence-only reference also requires null expected behavior, no invented
reproduction steps, and no workflow-blockage claim in its title or description.
These targeted checks caught an actual unsupported impact claim; they are not a
general semantic validator for arbitrary recordings.

Only the two production OpenRouter endpoints are allowed, with at most 12 request
attempts and an eight-minute deadline. The short fixture creates about ten seconds
of audio and two images in the partial path. Production request token/retry limits
still apply. Requests may incur charges; reported usage costs are aggregated when
the provider supplies them and are not a guaranteed hard billing cap. The runner
performs no arbitrary automatic reruns or additional model searches.

If actual tab capture fails, that stage stays failed and the command exits nonzero.
The runner then attempts a separate, explicitly labeled canvas-video session through
real transcription, real analysis, and the actual results/download UI. It seeds only
synthetic media through production local storage; it does not bypass recording
readiness, replace the failed tab path, or establish tab/microphone synchronization.
A failed readiness probe stops paid processing rather than retrying an unsuitable pair
through the partial path.

Ignored `.local/user-acceptance/run-*` contains synthetic ZIPs and a scrubbed summary.
The isolated browser profile, including its key, is deleted on completion. No HAR,
trace, request bodies, headers, key values, or provider response bodies are logged.
A cleanup failure is reported and must be resolved before sharing local artifacts.

## Lifecycle checks without providers

```sh
npm run test:lifecycle
LIFECYCLE_CRASH=1 npm run test:lifecycle
```

These isolated checks use actual synthetic-app tab video, a fake microphone, and
synthetic readiness only; they load no `.env` and block provider requests. They
close and reopen controls, change origin from `127.0.0.1` to `localhost`, verify a
visible context gap while frames continue, restore access through the actual
toolbar, place a trusted Control marker, and close the selected tab. Clean closure
must finalize a stopped session with decodable video and independent audio.
The runner also stops immediately after completed Start: it requires playable media
or a durable, visible nonretryable empty-video failure after reopening controls.
Three further production Start/Stop cycles in the same offscreen document wait for
persisted video before normal Stop, decode the results, check released streams,
and preserve the provider receipt; one cycle reopens controls during capture.

The optional crash case crashes only its isolated browser process and restarts
the same profile. It requires interrupted status, retained flushed media/frames,
and a recovery gap; it does not require or claim playable crash-interrupted media.
Failures remain nonzero. All temporary profiles and synthetic media are removed.

## Longer recording checks

The live runner is intentionally limited to short synthetic sessions; its media
inspection may read one short video into memory to compare exported hashes.
A short passing journey establishes only that tested model routing and browser build.
After it passes, run the provider-free capture modes:

```sh
BROWSER_CAPTURE=1 BROWSER_RECORD_SECONDS=65 BROWSER_EXPORT=1 npm run test:browser
BROWSER_CAPTURE=1 BROWSER_RECORD_SECONDS=1800 BROWSER_EXPORT=1 npm run test:browser
```

The 65-second mode checks independently decodable segments, start/end coverage,
and every overlap boundary. The 30-minute mode requires automatic stop, at least
850 sampled frames reaching the final ten seconds, and no long frame gaps. It
samples the offscreen JavaScript heap; native/media/GPU/process memory is not measured.

`BROWSER_EXPORT=1` closes the capture browser before reopening its isolated profile.
It runs the production processing and download UI with explicitly mocked provider
responses, checks every ZIP entry checksum, and compares the video and all image
SHA256 hashes to their originals. Original video and archive reads stream from disk.
It establishes full-size storage/export integrity, not long-form transcription quality.
These commands load no `.env` and never call paid providers.

Profiles are deleted by default. Set `BROWSER_KEEP_ARTIFACTS=1` only to retain the
ignored synthetic profile, then rerun a fresh stopped recording's export with:

```sh
npm run test:soak-export -- .local/browser/run-<id>
```

The export check rejects an active profile and requires unprocessed synthetic
capture data. Do not point it at a personal browser profile. CI runs the 65-second
record/export case and the crash-inclusive lifecycle case; the half-hour soak is
an explicit longer local check.

Full-duration subjective playback/synchronization, hardware permissions, and
total process memory still need separate assessment. Reference sessions should separately
score delayed observations, corrections, repeated issues, hover-state association,
false findings, permissions, diagnostic interruptions, and export evidence. Automated
synthetic media checks do not establish subjective finding quality or every platform.

## Manual acceptance walkthrough

Use a synthetic app and a short reference narration before testing real data.

1. Deny microphone access, try a bad key, and verify recording stays blocked. With
   a working key, readiness must return timed speech and correctly identify the sample image.
2. Record a hover state and mark it with double Control. Move the pointer or change
   DOM/styles afterward and verify the point retains its second-tap context.
   Double Shift must open rectangle mode without saving a point, even with a late
   third Shift; draw two nearby rectangles and test Escape. Try both fallback shortcuts,
   change the saved timing before a new recording, and check that held/chorded keys
   and ordinary editing do not create markers. Select ordinary text and mark it. Say a
   delayed observation, correct an earlier statement, repeat one issue, and describe
   one issue without a marker.
3. Navigate within the tab, change origin, restore page access, scroll, resize/zoom,
   and inspect inaccessible iframe context. Verify separate microphone, recording,
   diagnostics, and context statuses. Open DevTools with diagnostics enabled and
   confirm recording continues after diagnostics disconnects.
4. Close/reopen controls during capture. Stop normally, then repeat with selected-tab
   closure. Repeat Start/Stop and try stopping immediately after Start completes;
   require playable media or an explicit retained failure. Inspect the video and
   captured marker coordinates/styles/selection.
5. Include synthetic bearer/key/query secrets in page/log text. Review the transfer
   overview and export: supported text matches must be absent; the unchecked-media
   warning must remain explicit. Do not use real secrets for this test.
6. Simulate a provider failure after transcription. Retry without repeating completed
   requests, including a second failed retry with visible details after reopening.
   Cancel analysis, reload controls, and resume. Inspect every ZIP file,
   its relative references, screenshots, source quotes, and uncertain associations.
7. Run a full 30-minute session, checking synchronization and bounded memory, playable
   WebM, automatic stop, ZIP integrity, and sufficient disk space. Test browser restart
   recovery separately. Score detection, false findings, and image association independently.

## Observed limitations

Two intermittent recording setup failures occurred during initial lifecycle
development, without an exposed native cause. Subsequent diagnostic batches passed
five fresh-profile starts and eight immediate Stop/Start cycles in one unchanged
offscreen document. Those passes do not establish the earlier failure's cause;
retain a synthetic diagnostic trace if setup fails again. Tests never retry failed
recording setup silently or turn a partial provider check into a passing full journey.

## Verified reference runs

Observed locally on 2026-10-17 with Chromium 156.0.8078.4:

| Check                         | Observed result                                                                                                                                      | Boundary                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Integrated gate               | 118 tests in 15 suites; formatting, lint, strict types, build, secret scanning pass                                                                  | Providers blocked                                                      |
| Trusted input and DOM         | Double/triple Shift, immutable point context, native editing, focus, selection privacy pass                                                          | Synthetic session context                                              |
| Real 65-second capture/export | 2 overlapping audio segments, 33 frames; video/image hashes and every ZIP checksum match                                                             | Actual tab media; mocked processing                                    |
| Live user journey             | Actual toolbar/readiness/recording/markers/navigation/analysis/download pass; 2 timed statements, 1 grounded reference finding                       | 4 real provider requests in the final run                              |
| Lifecycle and actual crash    | Controls-independent recording, origin gap/restoration, clean tab close, retained bytes/frames and explicit recovery gap pass                        | Fake microphone; no crash-media playability guarantee                  |
| Full-duration capture         | Automatic stop at 1,799,997 ms; 31 independent audio files cover the full timeline with every boundary overlapping; 900 frames, maximum gap 2,002 ms | Actual tab video; synthetic microphone                                 |
| Full-duration export          | 30,359,181-byte ZIP; original 19,568,467-byte video and all 900 images match SHA256, every entry passes CRC                                          | 31 mocked transcriptions and 15 mocked analysis batches; no paid calls |

The long capture's offscreen JavaScript heap was 15.9 MiB initially (also the
highest sampled value) and
5.6 MiB at the final sample. This is not total native, media, GPU, or process memory.
Live compatibility and the reference finding were checked separately from the
long fixture's mocked provider output. These results do not establish general AI
accuracy, hardware microphone behavior, or semantic audio/video synchronization.

FFmpeg also decoded both tracks of the complete thirty-minute WebM to null with
`-v error -xerror` and no errors. This validates the full stream, rather than only
the browser's initial loaded-data event. Packet timestamps were inspected, but
variable-rate video packets can omit duration; this is not a semantic sync test.
For a retained synthetic recording, this optional local check can be repeated with:

```sh
ffmpeg -v error -xerror -i .local/browser/run-<id>/export-check/original.webm -map 0 -f null -
```

On 2026-10-18, the disjoint double Control/Shift mapping passed trusted Chromium
input checks, including immediate frozen points and a late third Shift without a
point. The canvas/microphone integration passed marker-only finding previews,
labeled contextual images in Markdown, machine-readable association provenance,
text sanitation, and streamed ZIP checks with mocked providers. A fresh 65-second
actual-tab run produced 33 frames and two audio segments; exported video/images
matched hashes and every ZIP entry passed CRC. These checks made no live provider
requests and do not revalidate model behavior after the prompt clarification.

The UX/reliability revision on 2026-10-18 passed 180 tests in 18 suites plus the
format/lint/type/build/secret gate. Latest-build Chromium checked cached provider
verification across same-key save/reopen, mocked HTTP 401 recheck invalidation, two-tab
target safety, local setup cancellation, and trusted in-tab notices without layout
or focus changes. An eight-second actual-tab capture used a fake microphone.
The lifecycle runner also closed all controls during real capture and then injected
a test-only ended event on the captured microphone track: it required interrupted
status, retained failure history, cleared active capture, ERR badge, a page notice
visible to the browser accessibility tree, and visible details after reopening.
This is simulated track loss, not a hardware-disconnection claim. The media runner
checked successful export retry clearing its current error while retaining history,
and code/count-only diagnostic copying. All these checks used blocked or mocked
providers; no live compatibility or paid requests were involved in this revision.
The user's earlier failure without visible text cannot be reconstructed from code
inspection alone. Its historical cause remains unknown.

A new browser-fixture race was reproduced with safe write-order tracing: the fixture
published a synthetic verification before its queued key save cleared the prior
receipt. Production verification already uses the provider settings lock. The
fixture now waits for the completed save notice and publishes under that same lock.
Two fresh parallel Chromium runs passed afterward without retries or weaker checks.

On 2026-10-19, a fresh baseline gate passed 180 tests in 18 suites plus formatting,
lint, strict types, build, and secret scanning. Chromium 156.0.8078.4 passed the
existing browser, media, selection, trusted-marker, and crash-inclusive lifecycle
checks. These provider-free checks used isolated profiles and synthetic microphone
input; the lifecycle interruption was a simulated track-ended event.

One explicitly enabled bounded live run then passed the actual toolbar, paid
connection verification, selected-tab recording, markers, navigation, analysis,
and ZIP download. It made four provider requests and reported $0.002242 usage
(not a billing cap). The isolated credential-bearing profile was removed. The
6,888 ms recording yielded two transcript statements, four frames, and one finding.
Separate inspection of the exported report and cited screenshot confirmed the
expected missing-blue-button observation, a resolving source statement, an existing
relative image path, and matching model-cited provenance in `issues.json`. The finding
invented no expected workflow action, reproduction steps, or blocking impact. No
additional findings were returned for this fixture. This narrow semantic check does
not establish delayed/corrected narration quality or general model accuracy.

The new immediate-Stop journey reproduced a product defect twice: stopping roughly
100 ms after completed Start could save status `stopped` with audio and a screenshot,
but no combined-video file. Empty recorder payloads were ignored and closing an
unopened media handle succeeded, so finalization never checked for actual video.
Finalization now counts successfully persisted video bytes and records an actionable,
nonretryable `recording-empty` interruption when none exist. Available audio and
frames remain local, streams are released, and an existing setup/storage cause is
preserved. Synthetic recorder tests cover both empty and absent final payloads.

The live run above preceded this finalization fix. The provider adapters and prompts
were unchanged; checks of the fixed build use blocked or mocked providers. The
synthetic report fixture preserves an unmarked observation, delayed source statement,
correction, direct versus contextual images, unchanged model evidence IDs, and an
explicit incomplete association. Predetermined findings test report/source integrity,
not provider interpretation of corrections.

The fixed build passed `npm run verify` with 184 tests in 18 suites and all
format/lint/type/build/secret checks. Updated browser acceptance passed exact
24-hour cache expiry (including the specific background rejection), changed-key
invalidation, same-key reuse, setup cancellation, HTTP401 invalidation, and target
safety. Media acceptance showed two visible HTTP402 analysis failures across
controls reopening, followed by recovery with exactly one transcription and three
analysis calls, preserved checkpoints, and retained failure history. Lifecycle
acceptance with `LIFECYCLE_CRASH=1` observed immediate Stop at 106 ms with zero video
bytes and a visible retained failure, then three playable production Start/Stop
cycles, simulated microphone loss, interruption notices, and crash recovery; all
provider requests were blocked. These results establish the new failure path, not
the unknown historical cause of the user's silent failures.

A fresh fixed-build 65-second actual-tab capture/export passed: 65,066 ms, 33 frames,
two independently finalized audio segments, 616,145 video bytes, and a 1,029,814-byte
ZIP. Video and every image matched their original hashes, and all ZIP entry checksums
passed. Processing used two mocked transcriptions and one mocked analysis; no paid
requests occurred. Offscreen JavaScript heap samples were 20.0 MiB initially/peak and
11.9 MiB finally, not total native/media/GPU/process memory. The 30-minute soak was
not repeated because duration, storage format, and export behavior were unchanged.

During harness development, assertions initially raced unfinished Start and restored
an assumed synthetic key instead of the stored key. Waiting for completed setup
and restoring the actual original key/receipt resolved those fixture failures; they
were distinct from the reproduced zero-video finalization defect.
