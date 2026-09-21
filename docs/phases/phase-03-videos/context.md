---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-21T14:12:31-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T15:06:36-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-21T14:12:31-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-21T14:12:31-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Frontend screens for upload/playback (next-frontend not initialized), video editing (Fase 04), social interactions (Fase 06), video categories (Fase 04), visibility control (Fase 04).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (API + compose.yaml infra + video-worker entry point)

**Deferred subprojects:** `next-frontend/` — Upload UI, player, and download button are deferred to a future phase.

**Sequencing notes:** Depends on Fase 01 (config base, TypeORM, Docker) and Fase 02 (auth — upload endpoints require authenticated user).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (prior — auth guard reused for upload endpoints)
- **Phase 04:** Gerenciamento de Vídeos e Canal (next — depends on Video entity and READY status introduced here)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Repo-wide | Message Queue Technology | decided | BullMQ + Redis | @nestjs/bullmq, bullmq, ioredis |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | 10GB Upload Strategy | decided | S3 Multipart Presigned URLs | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Repo-wide | Video Worker Runtime | decided | Separate NestJS standalone app | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Metadata & Thumbnail Tool | decided | fluent-ffmpeg + ffprobe | fluent-ffmpeg, @types/fluent-ffmpeg |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | NanoID | nanoid |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Video Streaming Strategy | decided | Presigned URL redirect (direct-to-storage) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | DRAFT → UPLOADED → PROCESSING → READY \| ERROR | — |

_Source files:_

- `phase-03-videos` — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-06 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

_(current-phase TDs only)_

### phase-03-videos/TD-01

**Recommendation:** Native NestJS integration via `@nestjs/bullmq`, lightweight Redis broker, retry/concurrency support, and the simplest path to a working worker process. The architecture diagram explicitly shows a separate Message Queue container, ruling out a DB-backed queue. RabbitMQ is overkill for a single job type and adds significant operational complexity. Redis is a standard Node.js stack addition and will be useful for future rate-limiting or caching needs.

**Libraries:** `@nestjs/bullmq`, `bullmq`, `ioredis`

### phase-03-videos/TD-02

**Recommendation:** The only option that satisfies 10GB without passing bytes through the API. A single presigned PUT URL fails at 5GB (S3 hard limit). Streaming upload through the API is explicitly the wrong architectural choice per the challenge brief. The multipart protocol complexity is the correct trade-off for a video platform at scale. AWS SDK v3 (`@aws-sdk/client-s3`) is the reference client for MinIO's S3-compatible API.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-03

**Recommendation:** Process isolation, independent scaling, code reuse via shared NestJS modules (entities, repositories, config), and alignment with the architecture diagram's separate Worker container. The single-process approach creates operational risk with CPU-heavy FFmpeg jobs. A plain Node.js script loses the NestJS ecosystem benefits (DI, TypeORM, ConfigService, BullMQ processors via `@Processor` decorator).

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** The architecture diagram explicitly designates FFmpeg. `fluent-ffmpeg` is the standard Node.js wrapper with a mature API covering both metadata extraction (via `ffprobe`) and thumbnail generation in a single dependency. WebAssembly FFmpeg is 5-20x slower than native — not viable for production video processing. The Sharp + raw exec alternative still requires FFmpeg binary and adds unnecessary complexity.

**Libraries:** `fluent-ffmpeg`, `@types/fluent-ffmpeg`

### phase-03-videos/TD-05

**Recommendation:** The standard choice for short URL identifiers in Node.js projects. URL-safe alphabet (`A-Za-z0-9_-`), cryptographically random, configurable length (default 21 chars → astronomically low collision probability), minimal bundle size, and widely used. A unique index on the `videoId` column handles the rare collision. The ESM/CJS compatibility issue is resolved by dynamic `import()` or using the CJS build.

**Libraries:** `nanoid`

### phase-03-videos/TD-06

**Recommendation:** Aligns with the architecture diagram (frontend streams directly from storage via HTTPS). Offloads all video bandwidth from the NestJS API — zero API bandwidth cost for streaming. MinIO natively supports HTTP Range requests (`206 Partial Content`), covering the "streaming without full download" requirement. API proxy (Option A) creates a scaling bottleneck. HLS (Option C) is the production-correct approach for a real video platform but is excessive complexity for this backend-only phase.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-07

**Recommendation:** The five-state lifecycle (DRAFT → UPLOADED → PROCESSING → READY | ERROR) provides meaningful client-side observability at low cost. The `UPLOADED` state distinguishes "awaiting upload confirmation" from "in the processing queue". BullMQ's built-in retry logic handles transient worker failures; the status only transitions to `ERROR` after all configured retry attempts are exhausted. A `processingError` text column captures the failure reason for observability.

**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases — from phase-02-auth and phase-01-configuracao-base)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem — factory is dual-purpose: DI token + plain importable function.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion. New env vars for Phase 03 (MinIO, Redis) must be added to the Joi schema in `src/config/env.validation.ts`.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. Phase 03 adds `src/config/storage.config.ts` and `src/config/queue.config.ts` per this pattern.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-02

**Recommendation:** Custom `AuthGuard` using NestJS `CanActivate` + `JwtService`. Upload endpoints require this guard — video upload is authenticated-only.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer with NestJS `ValidationPipe`. All Phase 03 DTOs (InitiateUploadDto, ConfirmUploadDto) follow this pattern.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter `{ statusCode, error, message }`. All Phase 03 domain exceptions (VideoNotFound, VideoNotOwnedByUser, UploadAlreadyConfirmed) follow this contract.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Services throw domain exceptions (not NestJS `HttpException`); exception filters handle HTTP mapping. _(from phase 02)_
- All HTTP endpoints with user input are validated via `ValidationPipe` (global) + class-validator DTOs. _(from phase 02)_
- Upload and video endpoints require the custom `AuthGuard` from Phase 02. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------| 
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------| 
| (empty on first assembly — plan-resolve appends rows as user marks capabilities) | | | |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with side-effect dep (storage, queue) | Integration: real capture adapter (MinIO local, Redis local) |
| Module with configured imports (`BullModule`, `TypeOrmModule`) | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |

_Note: Phase 03 introduces two new side-effect dependencies — object storage (MinIO) and message queue (Redis/BullMQ). Per `testing-guide-nestjs-project` → `references/external-systems.md`, integration tests for storage services should use the real local MinIO container; queue tests should use the real local Redis container. Worker processor tests run in-process against a real Redis test instance. See the testing guide's `artifacts/services.md` for the full recipe._
