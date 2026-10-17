# 0001: autonomous agent workflow

- Status: accepted
- Date: 2026-10-17

## Context

- Annotation Cast is intended for open-source publication.
- Development should require minimal user interaction while retaining independent review and documented architectural decisions.

## Decision

- Use a coordinator with separate planning, implementation, and independent review agents for substantive implementation work.
- Let agents resolve routine technical choices within the agreed product scope.
- Keep repository instructions in `AGENTS.md`, with `CLAUDE.md` pointing to it.
- Write repository content in English; use atomic semantic commits with lowercase messages and no emojis.
- Record significant technical choices as short ADRs; enforce verification and secret scanning when project tooling is established.

## Alternatives

- One agent without independent review: less coordination, weaker independent scrutiny.
- User approval at every phase: more interruptions than the requested workflow allows.

## Consequences

- Delegated work needs clear ownership; the coordinator integrates and resolves review findings.
- Documentation and mechanical changes use proportionate planning and review.
- Tooling and publication remain separate tasks; this decision does not select a stack, license, or release destination.
