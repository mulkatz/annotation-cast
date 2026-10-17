# 0005: isolated Shift tap marker gestures

- Status: accepted
- Date: 2026-10-17

## Context

Narrated tests need markers without clicking away hover states. Double Shift and
triple Shift must be distinguishable without moving focus or recording key history.
The existing Alt+Shift+P/R extension commands remain useful fallbacks.

## Decision

- Recognize trusted page keyboard events only during recording and with page access.
- Two isolated Shift taps queue a point; three enter the existing rectangle flow
  and discard that point. Escape cancels rectangle drawing.
- Persist an integer tap interval from 100–350 ms, default 180 ms for new/old settings.
  Save timing for the next recording; prevent timing changes during active capture.
- Require each Shift hold and consecutive completed keyup gap to be strictly shorter
  than the interval. Repeats, chords, and held Shift are not taps.
- Freeze the complete point event at the second keyup, including session time, URL,
  pointer, viewport, candidates/styles, and explicit source selection. Delay its
  publication by one interval; do not reread changed page state when publishing.
- Suspend the point timer on a possible third keydown; publish no point while held.
  The third release must still satisfy the original timing window, otherwise cancel.
- Reset on other keys/modifiers, repeat, composition, Shift+pointer interaction,
  focus changes, blur/hidden page, navigation initialization, and recording cleanup.
- Allow isolated gestures while an editable field remains focused. Do not intercept
  native typing, selection, or focus; do not persist raw keyboard events/form values.
- Retain Alt+Shift+P/R fallbacks and existing trusted-pointer availability checks.

## Alternatives

- Publish the double immediately: triple Shift would create an unwanted point.
- Capture point context after waiting: hover, selection, DOM, or pointer evidence drifts.
- Disable gestures in editable fields: prevents deliberate marking during form tests.
- Replace extension commands entirely: loses a fallback for intercepted gestures.

## Consequences

Point display/publication is slightly delayed, but its evidence retains the second
release timestamp. Triple/invalid input cancels the candidate without a stale point.
Page gestures are unavailable from the address bar or inaccessible frames and depend
on site access. Browser/OS interception remains possible; fallbacks may be needed.
Synthetic trusted-key browser checks establish gesture behavior independently of
tab recording and provider compatibility; they do not prove either of those paths.
