---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 2
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-21T15:10:46-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T15:06:36-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "Thumbnail frame timestamp not specified — implementation-time ambiguity"
  - id: ICC-1
    status: open
    summary: "NanoID v4+ is ESM-only; project toolchain is CommonJS — import conflict"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — The capability "Geração automática de thumbnail a partir de um frame do vídeo" (covered by phase-03-videos/TD-04) does not specify which frame should be used for thumbnail generation (e.g., frame at 1 second, frame at 10% of duration, first non-black frame). Without this, the worker implementation will make an ad-hoc choice with no documented contract. Explicit choice: (a) fix by annotation in `plan-build` SI spec — document the timestamp heuristic as part of the worker SI (e.g., "seek to `min(10s, duration * 0.1)`"); (b) add a `**Revisions:**` block to phase-03-videos/TD-04 specifying the frame selection rule; (c) accept that this is an implementation detail and document it only in `progress.md`.

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

- **ICC-1** — phase-03-videos/TD-05 decided NanoID as the unique video URL identifier, but the project toolchain uses CommonJS (NestJS default build). `nanoid` v4+ is ESM-only and cannot be statically `require()`-d in a CommonJS module — it will throw `ERR_REQUIRE_ESM` at runtime. The `plan-resolve` step must pin a concrete resolution before `plan-build` can produce a valid SI. Explicit choice: (a) **Pin `nanoid` to v3.x** (`npm i nanoid@3`) — v3 is CJS-compatible, API is identical (`customAlphabet`, `nanoid(size)`), no dynamic import needed. Recommended: minimal change, zero runtime risk; (b) **Use `@paralleldrive/cuid2`** — ESM-only as well, same problem; (c) **Use `crypto.randomBytes` with base64url encoding** — zero new dependency, native Node.js, CJS-safe: `crypto.randomBytes(16).toString('base64url')` yields a 22-char URL-safe string; (d) **Dynamic `import()`** — wrap NanoID in an async factory and await it at module init via NestJS `OnModuleInit` hook — works but adds async complexity at startup. Resolution: run `/plan-resolve 3` and select choice (a) or (c); the TD will be updated with a `**Revisions:**` block recording the pinned approach.

### UI Coverage Gaps

_None._

### Custom rule findings

_(no custom rules loaded — `docs/rules/plan-validate/` is empty)_

## Cross-slice Advisories

_(phase has a single slice — cross-slice checks suppressed)_

## Active Suppressions

_(no custom rules loaded — section omitted)_

## Resolved Issues

_No issues resolved yet._
