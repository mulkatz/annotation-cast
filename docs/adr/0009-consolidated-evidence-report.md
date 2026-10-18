# 0009: consolidated report with explicit frame association provenance

- Status: accepted
- Date: 2026-10-18

## Context

Valid findings can cite markers without citing supplied frames. The existing report
then has no images, although the ZIP contains nearby sampled screen states. People
and coding agents need one traceable reading document without fabricated evidence.

## Decision

- Make report.md the central illustrated document: session notes and limitations,
  findings with statements, cited event data, relevant images, gaps, and transcript.
- Preserve original model evidenceIds and association labels. Ask analysis to cite
  supplied frame IDs when their visible content corroborates the observation.
- Resolve images with shared presentation/export logic. Distinguish model citations
  from bounded temporal candidates near cited markers or narrated finding anchors.
- Refuse contextual links across known navigation/context gaps or mismatched pages.
  Time proximity is not semantic proof and does not imply the model saw the image.
- Add derived frameAssociations alongside issues in issues.json; preserve existing
  version 1 issue/session contracts. Old completed sessions work without reanalysis.
- Reserve analysis image capacity for markers as well as narration; retain 12 images
  per batch. Keep all original frames in the ZIP and relative Markdown image paths.
- Explain passive pointer movement separately from explicit point/rectangle markers.

## Alternatives

- Require model frame citations for every finding: rejects valid nonvisual findings.
- Add nearest frames to evidenceIds: misrepresents temporal guesses as model support.
- Reanalyze old sessions: costs requests and is unnecessary for contextual rendering.

## Consequences

One Markdown document supports human reading and agent investigation, with JSON as
structured source data. Images require the adjacent screenshots folder. Two-second
sampling can miss short states; candidates and hypotheses require human judgment.
