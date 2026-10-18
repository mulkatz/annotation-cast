# 0008: separate modifier gestures for point and rectangle markers

- Status: accepted
- Date: 2026-10-18
- Supersedes: [0005](0005-shift-tap-markers.md)

## Context

Double/triple Shift shares a prefix. An intended third tap arriving after the
configured interval can follow an already published point. Timing cannot resolve
that intent reliably. The user selected separate one-finger gestures.

## Decision

- Double Control creates a point; double Shift starts rectangle drawing.
- Publish immediately at the second release. Freeze point evidence at that instant.
- Retain the existing saved interval (100–350 ms, default 180), strict hold/release
  timing, trusted-event checks, native editing, lifecycle resets, and fallbacks.
- Cancel partial sequences on mixed keys, chords, repeated/held input, IME,
  Shift/Control+pointer interaction, focus changes, and capture cleanup.
- Keep the existing persisted shiftTapIntervalMs field for settings compatibility;
  it now governs both modifier gestures. No raw key history is stored.

## Alternatives

- Increase triple-tap tolerance: retains the ambiguous prefix and delays every point.
- Caps Lock: changes native capitalization state and can be intercepted by the OS.
- Configurable gesture bindings: unnecessary complexity for the agreed scope.

## Consequences

A late third Shift cannot create a point. Existing timing settings survive updates,
but the point binding changes; the controls and documentation show the new mapping.
Browser/OS interception and inaccessible page contexts still require fallbacks.
