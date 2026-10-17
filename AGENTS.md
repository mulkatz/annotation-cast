# Agent instructions

## Scope and autonomy

- Follow the user's current instructions, `CONCEPT.md`, and relevant accepted ADRs. Read only task-relevant sources.
- Work autonomously within the agreed scope: inspect, plan, implement, verify, review, and resolve findings without routine approval requests.
- Choose reversible technical details independently. Ask only for material unresolved product choices, missing access, or destructive actions, spending, or publication not already authorized.
- Keep changes small; minimize dependencies and abstractions. Preserve unrelated user changes. Do not add speculative features or mandatory task reports.
- All code, identifiers, comments, UI copy, prompts, documentation, and commit messages must be English. Conversation may follow the user's language; captured user content retains its original language.

## Agent workflow

| Role                 | Responsibility                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Coordinator          | Own scope, delegate bounded tasks, integrate changes, and report results.                                                     |
| Planning agent       | Inspect relevant code; define approach, acceptance criteria, risks, and necessary ADRs.                                       |
| Implementation agent | Implement the agreed task, update affected docs, and run focused checks.                                                      |
| Review agent         | Independently inspect actual changes and verification evidence; identify correctness, security, regression, and scope issues. |

- Use separate planning, implementation, and review agents for substantive implementation work. The reviewer must not be the implementer.
- Reuse agents; parallelize independent tasks with explicit file ownership. Keep planning/review proportional for documentation and mechanical changes.
- Resolve material review findings before completion; re-review affected changes. Escalate genuine blockers with evidence, without repeating ineffective attempts.

## Code quality and verification

- Prefer strict types; no `any` or unchecked casts hiding errors. Validate external data, extension messages, persisted records, and model output at boundaries.
- Keep provider access behind adapters with bounded retries and rate-limit handling. Follow established patterns before introducing new ones.
- Test changed behavior and meaningful failure cases; prioritize capture lifecycle, timestamps, permissions, sanitation, provider failures, and export integrity. Avoid tests that mirror implementation.
- Use synthetic fixtures matching documented API contracts. Automated tests must block real provider calls by default; live checks require explicit opt-in and configured credentials.
- Run focused checks during iteration. Before handoff/commit, run the documented verification gate on the integrated result; repeat only when changes or failures warrant it.
- During project setup, establish one `verify` entry point and CI for formatting checks, linting, type checking, tests, build, and secret scanning. Document actual commands; no tooling is configured yet.
- Report executed checks and remaining limitations accurately. Never claim unrun checks passed or bypass a failing gate.

## Architecture decisions

- Record significant architecture, storage/export format, permissions/privacy, provider, or major dependency choices in `docs/adr/NNNN-short-title.md` before or alongside implementation.
- Each ADR: status/date, context, decision, alternatives, consequences; target at most 60 lines. Routine implementation details need no ADR.
- Agents may accept technical ADRs within agreed scope. ADRs do not create an additional user approval gate or override product decisions.
- Preserve accepted decision history; supersede changed decisions with a linked ADR. Keep `CONCEPT.md` aligned when agreed product behavior changes.

## Open-source safety

- Never commit secrets, credentials, private session data, real recordings/transcripts/screenshots, or sensitive logs. Use synthetic fixtures and placeholder-only config examples.
- Keep local config, credentials, generated session artifacts, and scratch files ignored; use `.local/` for temporary work. Avoid personal paths, accounts, and environment-specific defaults.
- Inspect staged changes and run a secret scan before commits; scan history before first publication. CI must enforce secret scanning, including fork contributions without access to secrets.
- If a secret is found, stop its propagation, report only its location/type, remove exposure, and arrange revocation/rotation with the owner. Never reproduce the value in output or reports.
- Repository hygiene and runtime sanitation are separate requirements. Do not infer that a clean scan guarantees secret-free audio, images, or text.

## Git and completion

- Atomic semantic commits: `<type>: <summary>` or `<type>(<scope>): <summary>`; all message text lowercase English, no emojis. Example: `feat: add recording preflight`.
- Commit only task-owned changes. Do not rewrite shared history without authorization. Push, publish, and release only within the user's authorization.
- Finish with a short summary of changes, verification, and material limitations. Keep `CLAUDE.md` a symlink to this file; no duplicate rule sets.
