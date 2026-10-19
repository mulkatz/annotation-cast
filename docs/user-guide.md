# User guide

[Back to Annotation Cast](../README.md) · [Testing and acceptance](testing.md)

Annotation Cast records one selected tab and your microphone, then combines your
narration and captured evidence into an illustrated report. Processing runs through
your personal OpenRouter account. The extension needs no custom backend.

## First recording

Build and load the extension using the [quick start](../README.md#quick-start).
Node.js 22.12+ and Chrome/Chromium 120+ are required.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `dist` directory.
3. Pin **Annotation Cast** to the toolbar. Open the web app you want to test and
   click the extension button on that tab. An extension control page opens.
4. Enter and save your personal OpenRouter key. Add optional session notes. If needed,
   save a marker tap interval between 100 and 350 ms; the default is 180 ms. Saved
   timing applies to the next recording and is locked while recording.
5. Select **Verify connection**. The bundled synthetic audio/image requests may
   incur small API charges. Success is reused for strictly less than 24 hours for the
   same key, models, and probe contract. Changes, expiry, or relevant authentication,
   model-access, and compatibility failures require a new explicit verification.
6. Select **Start recording**. Speak during the automatic microphone check; tab
   access, storage, and optional diagnostics are also checked. Return to the selected
   tab to narrate. Stop from the control page; the toolbar reopens controls.
7. Review the transfer overview, select **Start analysis**, then **Download ZIP**.

Rebuild after changing code and click **Reload** on the extension card. Reloading
or uninstalling during capture interrupts it. Uninstalling removes local data.

## Recording and evidence

- Only the selected tab's video and microphone are captured; tab audio is excluded.
  Closing the control page does not stop recording. Closing the selected tab finalizes it.
- Sessions stop automatically after 30 minutes. Readiness requires 1.5 GB available
  local quota; actual requirements depend on page content and browser encoding.
- **Double Control** marks the current pointer without clicking. The second release
  immediately freezes and publishes the timestamp, position, and page evidence.
- **Double Shift** enters rectangle mode without creating a point. Drag and release
  to draw; press Escape to cancel. A late third Shift cannot create a point.
- Each modifier hold and the gap between consecutive completed key releases must be
  strictly shorter than the saved interval (default 180 ms, integer range 100–350 ms).
  Held/repeated keys, chords, IME composition, Shift/Control+pointer interaction,
  and focus/visibility changes reset the gesture. Native typing and focus are preserved.
  Isolated taps also work while an editable field remains focused; form values
  and key histories are not recorded.
- **Alt+Shift+P** and **Alt+Shift+R** remain fallback shortcuts; configure conflicts
  at `chrome://extensions/shortcuts`. Page gestures require recording, trusted page
  events, and available site access. They do not work from the address bar or
  inaccessible frames; the browser or OS may also intercept repeated modifier taps.
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

The initial combination is `openai/whisper-large-v3` for transcription and
`google/gemini-2.5-flash` for image/text analysis. It follows the current official
[OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt),
[image input](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding),
and [structured output](https://openrouter.ai/docs/guides/features/structured-outputs)
contracts. The pair is usable only after the real readiness probe passes for
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

| Path                | Contents                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `README.md`         | Agent reading workflow and evidence/privacy limitations                                        |
| `recording.webm`    | Selected tab video with synchronized microphone                                                |
| `report.md`         | Central illustrated report with notes, findings, quotes, marker context, gaps, full transcript |
| `issues.json`       | Versioned findings with stable IDs and evidence references                                     |
| `transcript.json`   | Sanitized timestamped source statements                                                        |
| `events.json`       | Sanitized markers, interactions, diagnostics, gaps                                             |
| `session.json`      | Version, measured recording timeline, notes, models, processing state, frames                  |
| `screenshots/*.jpg` | Timestamped evidence samples                                                                   |

Times are milliseconds from recording start; media time zero maps to session time
zero. Frames and speech use measured times rather than indices. WebM is recorded
as a continuous stream; some players may show an unknown duration until playback.
Use `session.json` for the measured timeline. Findings are automatically generated
and unreviewed. Observations and tentative AI causes are separate; unsupported
expected behavior and reproduction steps stay absent. Validate statements and
images before deciding a code change is required, and verify any later fix separately.

Start with `report.md` beside its `screenshots/` folder. Each finding groups its
source statements, cited marker data, and relevant images. Images explicitly cited
by the model are labeled separately from automatically selected temporal candidates;
proximity does not prove visual support. `issues.json` includes derived frame
associations without changing the original model evidence IDs. Passive `pointer`
events are the sampled movement trail, distinct from explicit `point` markers.

Session details show retained media counts, completed processing steps, and a bounded
failure history with actionable reasons. **Copy diagnostic summary** copies codes
and progress counts without page text, error messages, URLs, media, or API keys.
Critical capture interruptions also show a static notice in the recorded tab; if
page access is unavailable, inspect the toolbar error badge and extension controls.
Stopping before the browser produces any video can leave only audio and screenshots.
That session is marked interrupted with instructions to record again; it cannot be
repaired by retrying analysis.

## Further reading

- [Testing and manual acceptance](testing.md): commands, reference runs, and remaining limitations.
- [Product concept](../CONCEPT.md): agreed behavior and scope.
- [Architecture decisions](adr/): accepted decisions and their consequences.
