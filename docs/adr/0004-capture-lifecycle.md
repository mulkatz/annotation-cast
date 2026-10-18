# 0004: offscreen capture and measured evidence timeline

- Status: accepted; provider readiness scope updated by [0010](0010-reusable-provider-verification.md)
- Date: 2026-10-17

## Context

Capture must survive navigation and a closed control page. Recorder chunks are
not independently decodable, and microphone transcript timestamps must map to
actual recording time. Thirty-minute sessions cannot buffer full video in RAM.

## Decision

- Invoke the toolbar action on the selected HTTP(S) tab before opening setup.
- Enforce fresh, single-use readiness bound to the selected tab and key digest.
- Record tab video with microphone (without tab audio) in an MV3 offscreen document.
- Record one WebM stream with one-second OPFS append writes; close its writer on stop.
- Create independent microphone WebM recorders every 59 seconds for 60 seconds,
  recording actual segment starts/ends with one-second overlap.
- Use milliseconds from the recorder start epoch for events, frames, and segments.
- Persist JPEG evidence frames every two seconds at a maximum width of 960 pixels.
  Select these measured frames during analysis, avoiding unseekable WebM assumptions.
- Keep overlays layout-neutral; freeze bounded DOM candidates and allowlisted styles.
- Record bounded console/network metadata only through optional debugger access.
  Only the main target's available events are covered; embedded/worker completeness
  is not assumed. DevTools detach is a visible gap and does not stop media capture.
- Finalize on tab closure/track loss and stop at thirty minutes. On browser restart,
  retain existing data, mark interrupted sessions and explicitly record recovery gaps.

## Alternatives

- Pause/resume one audio recorder: segments would depend on earlier WebM headers.
- Seek the growing WebM for screenshots: seekability and final duration vary by browser.
- Capture all frames in memory: unacceptable thirty-minute memory growth.

## Consequences

Raw media remains sensitive, unredacted local evidence. Two-second frame sampling
can miss brief states; marker images are evidence with measured times, not exact
screenshots of every marker. Targeted real-browser and thirty-minute acceptance
remain necessary; synthetic lifecycle tests cannot prove media compatibility.

## References

- [Chrome background tab capture](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)
- [Chrome tabCapture invocation requirements](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
