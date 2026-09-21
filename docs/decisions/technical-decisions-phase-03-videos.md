---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-09-21
scope_description: "Backend & Infra for video lifecycle: message queue technology, 10GB upload strategy via S3 presigned URLs, video worker runtime and FFmpeg processing, unique URL generation, video streaming strategy, video status lifecycle and failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers all video endpoints (initiate upload, confirm upload, stream, download), the StorageModule (S3/MinIO), the QueueModule (job publishing), the Video entity/migration, and the compose.yaml infra additions (MinIO, queue broker, video-worker).
- `next-frontend/` — out of scope for this phase per the challenge brief: "Este é um desafio de backend: a entrega é a API, o worker, a infraestrutura e os artefatos do processo." No open decision in this document.

---

## TD-01: Message Queue Technology

**Scope:** Repo-wide

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram marks the Message Queue as "TBD" — this is the main open stack decision of Phase 03. The API publishes a video-processing job after upload; the Video Worker consumes it. The choice affects the broker container added to compose.yaml, the NestJS client library, and the worker integration. The project already runs PostgreSQL and will add Redis or a dedicated broker.

**Options:**

### Option A: BullMQ + Redis
- BullMQ is a Node.js job queue library built on Redis. The broker is a Redis container; NestJS uses `@nestjs/bullmq` (the official NestJS module for BullMQ). The worker is a NestJS app (or standalone process) that consumes jobs via `@Processor` decorators.
- **Pros:** Native NestJS integration via `@nestjs/bullmq` — DI, decorators (`@InjectQueue`, `@Processor`, `@OnWorkerEvent`), lifecycle hooks out of the box. Redis is lightweight and widely used. BullMQ supports retries, delayed jobs, priority, and concurrency natively. No separate broker binary — Redis serves dual duty (queue + potential cache later). Dashboard tooling (Bull Board) available. ~400K weekly downloads.
- **Cons:** Adds Redis as a new infrastructure dependency. BullMQ requires Redis 6.2+. Job durability depends on Redis persistence config (AOF/RDB). Not a true message broker — no topic routing, fan-out, or competing-consumers patterns beyond what BullMQ implements.

### Option B: RabbitMQ + @nestjs/microservices (AMQP)
- RabbitMQ is a full AMQP message broker. NestJS integrates via `@nestjs/microservices` with the RabbitMQ transport, or directly via `amqplib`. The worker is a NestJS microservice that subscribes to a queue.
- **Pros:** True message broker — durable queues, dead-letter exchanges, topic routing, fan-out. AMQP semantics (ack/nack) provide reliable at-least-once delivery without custom logic. Management UI built-in. Scales well for complex event topologies in future phases.
- **Cons:** Heavier infrastructure footprint (RabbitMQ container is ~200MB+). `@nestjs/microservices` AMQP transport adds complexity (hybrid application setup). Setup involves exchanges, bindings, and queue declarations. Overkill for a single job type (video processing). No Redis for caching use cases unless a separate Redis is added later.

### Option C: PostgreSQL-backed queue (pg-boss)
- `pg-boss` implements a job queue using the existing PostgreSQL instance. No new infrastructure — jobs are rows in a `pgboss` schema. Worker polls the DB for jobs.
- **Pros:** Zero new infrastructure — reuses PostgreSQL already in the stack. Persistent by default (ACID). No new container in compose.yaml. Simple mental model.
- **Cons:** Polling-based — adds load to PostgreSQL, the primary DB. Video processing is CPU/IO-heavy; coupling processing jobs to the same DB instance creates operational risk. PostgreSQL is not optimized as a queue. Not a NestJS-native integration — requires custom worker setup. Harder to scale the worker independently. Not aligned with the architecture diagram (which shows a separate Queue container).

**Recommendation:** **Option A (BullMQ + Redis)** — Native NestJS integration via `@nestjs/bullmq`, lightweight Redis broker, retry/concurrency support, and the simplest path to a working worker process. The architecture diagram explicitly shows a separate Message Queue container, ruling out Option C. RabbitMQ (Option B) is overkill for a single job type and adds significant operational complexity. Redis is a standard addition to Node.js stacks and will be useful for future rate-limiting or caching needs.

**Decision:** _[BullMQ + Redis]_

---

## TD-02: 10GB Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API cannot receive a 10GB file body — it would block the Node.js event loop, exhaust memory, and create a single point of failure. The upload strategy determines how the frontend sends the file, how the API orchestrates the upload, and how the file lands in object storage. This is a cross-layer contract: the API endpoint shape and the storage interaction are coupled.

**Options:**

### Option A: S3 Multipart Presigned URLs (direct-to-storage upload)
- The API creates a multipart upload session in S3/MinIO (via `CreateMultipartUpload`), returns a list of presigned URLs (one per part, e.g., 100MB each for a 10GB file = 100 parts). The client uploads each part directly to MinIO using the presigned URLs (PUT requests). The client then calls the API to complete the upload (`CompleteMultipartUpload`). The API never receives the file bytes.
- **Pros:** File bytes never touch the API — no memory/CPU overhead on the NestJS process. Supports files up to 5TB (S3 limit). Each part can be retried independently on network failure. Parallelizable (client can upload multiple parts concurrently). Production-ready pattern (used by YouTube, Dropbox, etc.). AWS SDK v3 (`@aws-sdk/client-s3`) has built-in multipart helpers.
- **Cons:** More complex protocol — requires 3 API calls (initiate, complete, abort on failure) plus N direct-to-storage PUT requests from the client. The client must split the file into parts. Requires CORS configuration on MinIO. Signed URLs expire — long uploads (slow connections + large files) need URL refresh logic or generous TTLs.

### Option B: Single Presigned PUT URL (direct-to-storage, no multipart)
- The API generates a single presigned PUT URL for the entire file. The client uploads the file directly to MinIO in one request. The API is not in the data path.
- **Pros:** Simpler protocol — one presigned URL, one PUT. No part management. Easy client implementation.
- **Cons:** Single presigned PUT URL in S3 is limited to 5GB (hard limit). Cannot resume on failure — the entire upload must restart. Not viable for 10GB files. Violates the "up to 10GB" capability bullet directly.

### Option C: Streaming upload through the API (multipart/form-data)
- The client uploads the file to the API via `multipart/form-data`. The API streams the bytes to MinIO using the AWS SDK's streaming upload. No presigned URL needed.
- **Pros:** Simple client — standard file upload. No CORS configuration on MinIO. The API controls the upload completely.
- **Cons:** File bytes pass through the NestJS process — blocks the event loop for large files, consumes memory proportional to buffer size. Multer (default NestJS upload middleware) loads the entire file into memory or disk before streaming. 10GB via the API is the "wrong path" explicitly called out in the challenge brief. Not scalable.

**Recommendation:** **Option A (S3 Multipart Presigned URLs)** — The only option that satisfies 10GB without passing bytes through the API. Option B fails at 5GB. Option C is explicitly the wrong architectural choice per the challenge brief. The multipart protocol complexity is the correct trade-off for a video platform at scale. AWS SDK v3 is the reference client for MinIO's S3-compatible API.

**Decision:** _[S3 Multipart Presigned URLs]_

---

## TD-03: Video Worker Runtime

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The Video Worker consumes jobs from the queue and runs FFmpeg to process videos. The choice of how the worker runs (same NestJS process, separate NestJS app, or standalone script) affects the compose.yaml structure, the deployment model, and how the worker shares code with the API. Depends on TD-01 (queue technology).

**Options:**

### Option A: Separate NestJS application (standalone app) in the same monorepo
- A second `nestjs-project/src/worker.ts` entry point (or a separate `nestjs-project/worker/` directory) that bootstraps a NestJS standalone application with only the `BullMQ` processor, `TypeORM`, and `StorageModule`. It runs as a separate Docker service in compose.yaml (`video-worker`), sharing the same `node_modules` and source via volume mount.
- **Pros:** Process isolation — a crash in the worker does not affect the API. Independent scaling (run multiple worker replicas). Clear separation of concerns. Shares code (entities, repositories, config) with the API without duplication. The `video-worker` service in compose.yaml is self-documenting. Aligns with the architecture diagram (separate Worker container).
- **Cons:** Two NestJS application bootstraps — slightly more startup time. compose.yaml needs a separate service entry with its own `command`. Must ensure the worker entry point imports only the modules it needs (avoid pulling in HTTP server, etc.).

### Option B: Worker runs inside the API process (same NestJS app)
- The `BullMQ` processor is registered as part of the main API's `AppModule`. The same container handles HTTP requests and job processing.
- **Pros:** Single process — simpler compose.yaml (no separate service). Shared DI context — no separate module bootstrap needed. Less infrastructure to manage in development.
- **Cons:** A heavy FFmpeg job blocks CPU and can degrade API response times (even with worker threads, the process shares resources). Cannot scale the worker independently. A worker crash can bring down the API. Does not match the architecture diagram (separate Worker container). Not aligned with the challenge's "worker" concept.

### Option C: Standalone Node.js script (no NestJS)
- A plain Node.js/TypeScript script that connects to Redis, polls for jobs, runs FFmpeg via `fluent-ffmpeg`, and updates the DB directly. No NestJS DI.
- **Pros:** Minimal overhead — no NestJS bootstrap. Fastest cold start.
- **Cons:** Cannot reuse NestJS TypeORM repositories, ConfigService, or other DI-managed services without manual wiring. Must duplicate DB connection setup. Diverges from the project's TypeScript/NestJS conventions. Testing is harder (no NestJS testing utilities).

**Recommendation:** **Option A (Separate NestJS standalone app)** — Process isolation, independent scaling, code reuse via shared modules, and alignment with the architecture diagram. The single-process approach (Option B) creates operational risk with CPU-heavy FFmpeg jobs. A plain script (Option C) loses the NestJS ecosystem benefits that the project is built around.

**Decision:** _[Separate NestJS standalone app]_

---

## TD-04: Video Metadata Extraction and Thumbnail Generation Tool

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration, resolution, codec, and other metadata from the uploaded video, and generate a thumbnail from a specific frame. The choice is between the FFmpeg ecosystem (via Node.js wrappers) and alternative libraries. The architecture diagram already names FFmpeg as the Video Worker's technology.

**Options:**

### Option A: fluent-ffmpeg + ffprobe (Node.js FFmpeg wrapper)
- `fluent-ffmpeg` provides a fluent API over the `ffmpeg` and `ffprobe` CLI binaries. `ffprobe` extracts metadata (duration, resolution, codec, bitrate) as JSON. `ffmpeg` generates thumbnails by seeking to a timestamp and extracting a frame as JPEG/PNG. Binaries are installed in the Docker image via `apt-get install ffmpeg`.
- **Pros:** Mature library (~1.5M weekly downloads). Full FFmpeg feature set — any metadata field, any thumbnail configuration (time offset, size, format). `ffprobe` output is structured JSON — easy to parse. Well-documented NestJS + fluent-ffmpeg patterns. The architecture diagram explicitly names FFmpeg. Promise-based wrappers available.
- **Cons:** Requires `ffmpeg` binary in the Docker image — adds ~60MB to the image. `fluent-ffmpeg` API is callback-based (requires promisification). Binary path must be configured in the container.

### Option B: @ffmpeg/ffmpeg (WebAssembly FFmpeg)
- Runs FFmpeg compiled to WebAssembly in the Node.js process. No binary installation required.
- **Pros:** No system dependency — no `apt-get` in Dockerfile. Works in environments without FFmpeg installed.
- **Cons:** WASM FFmpeg is significantly slower than native binaries (5-20x for video processing). Memory overhead of loading WASM in Node.js. Designed for browser use — Node.js server-side use is not the primary target. Not suitable for production video processing workloads.

### Option C: Sharp (for thumbnails only) + custom ffprobe exec
- Use `sharp` (a fast image processing library) for thumbnail generation and a direct `child_process.exec` call to `ffprobe` for metadata extraction.
- **Pros:** `sharp` is very fast for image processing. No `fluent-ffmpeg` dependency.
- **Cons:** Sharp generates thumbnails from still images, not video frames — still requires FFmpeg/ffprobe to extract the frame first. This means FFmpeg binary is still needed. Combining Sharp + raw exec duplicates what `fluent-ffmpeg` already handles cleanly. Adds `sharp` as a dependency with native bindings (libvips).

**Recommendation:** **Option A (fluent-ffmpeg + ffprobe)** — The architecture diagram explicitly designates FFmpeg. `fluent-ffmpeg` is the standard Node.js wrapper with a mature API covering both metadata extraction and thumbnail generation in a single dependency. Options B and C are either non-viable for production (WASM) or unnecessarily complex.

**Decision:** _[fluent-ffmpeg + ffprobe]_

---

## TD-05: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, collision-resistant URL identifier (e.g., `streamtube.com/watch/dQw4w9WgXcQ`). The choice of ID format and generation strategy affects the URL aesthetics, collision probability, database indexing, and dependencies. This is separate from the database primary key (UUID).

**Options:**

### Option A: NanoID (random short URL-safe string)
- `nanoid` generates cryptographically random, URL-safe strings. Default alphabet: `A-Za-z0-9_-` (64 characters). Default length: 21 characters (collision probability ~1% at 149 billion IDs). Configurable length and alphabet.
- **Pros:** Designed for URL IDs — URL-safe by default. Cryptographically random — no sequential enumeration risk. No DB lookup needed for generation. Collision probability is configurable via length. ~17M weekly downloads. Tiny library (~180B gzipped for the non-secure version; `nanoid` uses `crypto.getRandomValues`). The `nanoid` ESM package works with Node.js 18+.
- **Cons:** IDs are not sortable by creation time (random). Slightly longer than a YouTube-style 11-char ID at the default 21 chars (configurable). Requires a uniqueness check in the DB (unique index on `videoId` column) to handle the astronomically rare collision.

### Option B: CUID2
- CUID2 generates collision-resistant IDs that are also sortable by creation time. Starts with a letter (safe for HTML `id` attributes).
- **Pros:** Sortable — IDs have temporal ordering. URL-safe. Collision-resistant. No central coordination needed.
- **Cons:** Longer than NanoID at the default configuration (~24 chars). Less widely used than NanoID in the NestJS ecosystem. The `@paralleldrive/cuid2` package is ESM-only — requires `import()` in CommonJS NestJS apps.

### Option C: Hashids from database ID
- Generate a short hash from the auto-increment or UUID primary key using the `hashids` library. The hash is deterministic — the same ID always produces the same hash.
- **Pros:** No separate column needed — the hash is computed from the PK. Short output (configurable). Reversible (the PK can be recovered from the hash).
- **Cons:** Reversibility is a double-edged sword — exposes DB enumeration if the salt is leaked. Requires a sequential/integer PK for best results (UUIDs produce longer hashes). The project uses UUIDs as PKs (TypeORM default). Adds a dependency for what `nanoid` solves more cleanly.

**Recommendation:** **Option A (NanoID)** — The standard choice for short URL identifiers in Node.js projects. URL-safe, cryptographically random, configurable length, minimal size, and widely used. A unique index on the `videoId` column handles the rare collision. The ESM/CommonJS issue is handled by using `nanoid` with dynamic `import()` or pinning to a CJS-compatible version.

**Decision:** _[NanoID]_

---

## TD-06: Video Streaming Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** The frontend player must start playback without downloading the complete file. The choice of streaming strategy determines the HTTP response format, the API endpoint implementation, and what the player needs on the frontend side. The architecture diagram shows "Frontend → Object Storage (Streams via HTTPS)" — suggesting direct-from-storage streaming as the target.

**Options:**

### Option A: HTTP Range Requests (206 Partial Content) served by the API
- The API proxies range requests to MinIO: the client sends `Range: bytes=0-1048575`, the API forwards the range to MinIO (or streams from MinIO) and returns `206 Partial Content`. Standard HTML5 `<video>` tag supports range requests natively.
- **Pros:** Works with native `<video>` tag — no special player. Range requests are the browser standard for video streaming. The API controls access (auth, signed URLs, download counting). Simple implementation with Node.js `http` streams + `Content-Range` headers. No additional infrastructure.
- **Cons:** All video bytes pass through the API — CPU and bandwidth overhead on the NestJS process. Does not scale to high concurrency without a reverse proxy (nginx) in front. For very large files, proxying is inefficient.

### Option B: Presigned URL redirect — client streams directly from MinIO
- The API generates a short-lived presigned GET URL for the video in MinIO and returns a `302 Redirect` (or the URL itself). The frontend player hits MinIO directly, which handles range requests natively (MinIO supports `206 Partial Content`).
- **Pros:** Video bytes never touch the API — zero API bandwidth for streaming. MinIO handles range requests natively. Aligns with the architecture diagram ("Frontend → Storage: Streams via HTTPS"). Scales independently of the API. Presigned URL TTL controls access duration.
- **Cons:** The API loses control of the stream after the redirect (cannot track per-byte progress, enforce mid-stream auth revocation). Presigned URLs can be shared (mitigated by short TTLs). Requires MinIO to be accessible from the browser (CORS + port exposure).

### Option C: HLS (HTTP Live Streaming) with adaptive bitrate
- FFmpeg transcodes the video into HLS segments (`.ts` files) and a manifest (`.m3u8`) at multiple resolutions. The player uses an HLS-capable player (e.g., `hls.js`) to stream the appropriate quality. Segments are stored in MinIO and served directly.
- **Pros:** Adaptive bitrate — player selects quality based on bandwidth. Efficient for large audiences (CDN-friendly). Seek anywhere without downloading. Standard for production video platforms.
- **Cons:** Significant FFmpeg processing time and storage overhead (multiple renditions × segments × manifest). Requires `hls.js` or similar player on the frontend. Much more complex worker implementation. Overkill for a backend-only phase where the frontend is out of scope.

**Recommendation:** **Option B (Presigned URL redirect)** — Aligns with the architecture diagram (frontend streams directly from storage), offloads bandwidth from the API, and MinIO's native range request support covers the "streaming without full download" requirement. Option A (API proxy) is simpler but creates a scaling bottleneck. Option C (HLS) is the production-correct approach for a real video platform but is excessive complexity for Phase 03's backend-only scope.

**Decision:** _[Presigned URL redirect]_

---

## TD-07: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The video entity progresses through several states: created at upload initiation, processed after the worker runs, and potentially errored on failure. The status enum values, the transitions, and the failure recovery strategy must be defined as a cross-cutting contract (DB schema, worker logic, API responses). This is a required constraint for the Data Model in plan-build.

**Options:**

### Option A: Linear enum — DRAFT → PROCESSING → READY | ERROR
- Four states: `DRAFT` (video row created, upload not yet confirmed), `PROCESSING` (worker job dispatched), `READY` (processing complete, video available), `ERROR` (worker failed). Transitions are linear. On error, a `processingError` text column captures the failure reason. Retries are handled by BullMQ's built-in retry mechanism (configurable attempts + backoff). After N failed attempts, BullMQ marks the job as failed and the worker sets status to `ERROR`.
- **Pros:** Simple and self-documenting. Four states cover the full lifecycle with no ambiguity. `ERROR` is a terminal state — the user can see the failure. BullMQ handles retries transparently. The `processingError` field gives observability.
- **Cons:** No intermediate state for "upload in progress vs. upload complete" — both are `DRAFT`. No `UPLOADED` state between `DRAFT` and `PROCESSING`. This could cause confusion if the client polls for status before the worker picks up the job.

### Option B: Extended enum — DRAFT → UPLOADED → PROCESSING → READY | ERROR
- Five states: `DRAFT` (row created, presigned URLs issued), `UPLOADED` (client confirmed multipart complete), `PROCESSING` (worker started), `READY`, `ERROR`.
- **Pros:** Clearer lifecycle — the API can distinguish "waiting for worker" (`UPLOADED`) from "worker running" (`PROCESSING`). Better client-side polling UX. The `UPLOADED → PROCESSING` transition happens when the worker picks up the job (worker updates status on job start).
- **Cons:** More states to document, validate, and test. The `UPLOADED` → `PROCESSING` transition requires the worker to update the DB at job pickup — an extra write. Marginal benefit over Option A for Phase 03's scope.

### Option C: Minimal enum — PENDING → READY | ERROR (no intermediate states)
- Three states: `PENDING` (covers draft + uploaded + processing), `READY`, `ERROR`.
- **Pros:** Simplest possible. Minimal code for state transitions.
- **Cons:** Loss of observability — cannot distinguish "not yet uploaded" from "processing". The client cannot give meaningful feedback during the upload and processing steps. Phase 04 will likely need the extra states anyway.

**Recommendation:** **Option B (DRAFT → UPLOADED → PROCESSING → READY | ERROR)** — The additional `UPLOADED` state provides meaningful client-side observability at low cost. Knowing whether a video is "awaiting upload confirmation" vs. "in the processing queue" is useful for the progress.md SI design and for future frontend integration (Phase 04+). BullMQ's retry logic is configured at the queue/worker level; the status only changes to `ERROR` after all retries are exhausted.

**Decision:** _[DRAFT → UPLOADED → PROCESSING → READY | ERROR]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Repo-wide | Message Queue Technology | BullMQ + Redis | _[BullMQ + Redis]_ |
| TD-02 | Cross-layer | 10GB Upload Strategy | S3 Multipart Presigned URLs | _[S3 Multipart Presigned URLs]_ |
| TD-03 | Repo-wide | Video Worker Runtime | Separate NestJS standalone app | _[Separate NestJS standalone app]_ |
| TD-04 | Backend | Video Metadata & Thumbnail Tool | fluent-ffmpeg + ffprobe | _[fluent-ffmpeg + ffprobe]_ |
| TD-05 | Backend | Unique Video URL Identifier | NanoID | _[NanoID]_ |
| TD-06 | Backend | Video Streaming Strategy | Presigned URL redirect (direct-to-storage) | _[Presigned URL redirect (direct-to-storage)]_ |
| TD-07 | Backend | Video Status Lifecycle | DRAFT → UPLOADED → PROCESSING → READY \| ERROR | _[DRAFT → UPLOADED → PROCESSING → READY \| ERROR]_ |
