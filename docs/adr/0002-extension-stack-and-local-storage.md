# 0002: extension stack and local storage

- Status: accepted
- Date: 2026-10-17

## Context

Annotation Cast needs background recording, durable local sessions, direct API access,
and exports suitable for thirty-minute recordings without a server.

## Decision

- Use Chrome MV3 (Chrome 120+) with TypeScript, esbuild, and plain HTML/CSS.
- Keep orchestration in the service worker, media capture in an offscreen document,
  and setup, processing, and results in an extension page.
- Store validated session metadata/events in IndexedDB; append media to OPFS files.
- Use Zod for external boundary validation and zip.js for streamed ZIP writing to OPFS.
- Use ESLint, Prettier, TypeScript, Vitest, and a repository secret scan in `npm run verify`.
- CI additionally runs Gitleaks on pull requests including fork contributions.
- Use activeTab and optional site access; diagnostics need explicit debugger consent.
  Never collect request bodies, headers, form values, or keystrokes.

## Alternatives

- Backend service or native helper: violates standalone requirements.
- UI framework and component library: unnecessary for this small control surface.
- In-memory ZIP/media assembly: duplicates large recordings and weakens recovery.

## Consequences

- Local recordings depend on browser quota; readiness checks space and persistence.
- OPFS/IndexedDB data is local to the extension installation and removed on uninstall.
- Browser and live provider acceptance remain separate from synthetic verification.
