---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-21T14:12:31-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T15:27:27-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Implement the complete backend video processing pipeline for StreamTube: Object Storage integration (MinIO/S3), BullMQ message queue with Redis broker, S3 multipart direct-to-storage upload protocol (supporting files up to 10GB without API memory overhead), video status lifecycle management (`DRAFT` → `UPLOADED` → `PROCESSING` → `READY` | `ERROR`), unique NanoID URL generation, background Video Worker standalone process running FFmpeg for metadata extraction (`ffprobe`) and automatic thumbnail generation (`ffmpeg`), presigned URL streaming redirects, download endpoints, and dedicated Docker Compose infrastructure for all components including the video processing worker.

---

## Step Implementations

### SI-03.1 — StorageModule and S3/MinIO Integration

**Description:** Configure namespaced storage configuration, AWS SDK v3 S3 client provider, and `StorageService` for managing buckets, presigned upload/download/stream URLs, and S3 multipart upload lifecycle operations.

**Technical actions:**
- Create `src/config/storage.config.ts` using `registerAs('storage', ...)` reading `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME` (`streamtube-videos`), and `S3_FORCE_PATH_STYLE` (`true`).
- Update `src/config/env.validation.ts` with Joi schema for storage environment variables.
- Create `StorageService` in `src/storage/storage.service.ts` encapsulating AWS S3 client commands: `onModuleInit` bucket check/creation, `createMultipartUpload`, `getPresignedUploadPartUrl`, `completeMultipartUpload`, `abortMultipartUpload`, `getPresignedGetUrl`, and `uploadBuffer`.
- Create `StorageModule` exporting `StorageService`.

**Tests:**
- Unit test `storage.service.spec.ts` validating S3 client command construction and presigned URL parameters.

**Dependencies:** None

**Acceptance criteria:**
- `StorageService` initializes cleanly and creates the `streamtube-videos` bucket automatically on startup if it does not exist.
- S3 commands generate valid URLs for upload parts and presigned GET operations.

---

### SI-03.2 — QueueModule and BullMQ Configuration

**Description:** Configure namespaced queue configuration, `@nestjs/bullmq` module integration, and job queue definitions for the `video-processing` queue.

**Technical actions:**
- Create `src/config/queue.config.ts` using `registerAs('queue', ...)` reading `REDIS_HOST` (`redis`), `REDIS_PORT` (`6379`), `REDIS_PASSWORD`.
- Register `BullModule.forRootAsync` in `AppModule` using `queueConfig.KEY` and registering queue `'video-processing'`.

**Dependencies:** None

**Acceptance criteria:**
- `AppModule` connects to Redis without errors and registers the `'video-processing'` BullMQ queue.

---

### SI-03.3 — Video Entity, Status Lifecycle, and Migration

**Description:** Define the `Video` TypeORM entity, `VideoStatus` enum, foreign key relationship to `User`, and generate database migration.

**Technical actions:**
- Create `VideoStatus` enum (`DRAFT`, `UPLOADED`, `PROCESSING`, `READY`, `ERROR`).
- Create `Video` entity in `src/videos/entities/video.entity.ts` with fields: `id` (UUID), `videoId` (21-char NanoID, unique index), `title`, `description`, `status`, `originalFileName`, `mimeType`, `fileSize`, `s3Key`, `thumbnailKey`, `duration`, `processingError`, `userId` (FK to `users.id`, `ON DELETE CASCADE`), `createdAt`, `updatedAt`.
- Create migration for the `videos` table and `video_status_enum`.

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**
- Migration executes cleanly with `npm run migration:run`.
- Unique constraint on `videoId` enforced at database level.

---

### SI-03.4 — Video Upload Initiation Endpoint

**Description:** Implement `POST /videos/upload/initiate` endpoint allowing authenticated users to initiate a video upload, pre-register the video as `DRAFT`, and receive presigned part URLs.

**Technical actions:**
- Create DTO `InitiateUploadDto` (`title`, `description`, `originalFileName`, `mimeType`, `fileSize`, `partCount`).
- Implement `initiateUpload` in `VideosService`: generate 21-char NanoID via `nanoid@^3.x`, create `Video` record in status `DRAFT`, invoke `StorageService.createMultipartUpload`, generate N presigned part URLs, and return `videoId`, `uploadId`, `key`, and `parts` array.
- Expose `POST /videos/upload/initiate` in `VideosController` protected by `JwtAuthGuard`.

**Tests:**
- Unit test `videos.service.spec.ts` covering `initiateUpload`.

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**
- Endpoint creates a new `DRAFT` video record in DB with NanoID `videoId`.
- Returns HTTP 201 with `uploadId` and presigned part URLs matching requested `partCount`.

---

### SI-03.5 — Video Upload Confirmation Endpoint

**Description:** Implement `POST /videos/:videoId/upload/confirm` endpoint to finalize S3 multipart upload, update video status to `UPLOADED`, and dispatch background processing job to BullMQ.

**Technical actions:**
- Create DTO `ConfirmUploadDto` (`uploadId`, `parts: { PartNumber: number, ETag: string }[]`).
- Implement `confirmUpload` in `VideosService`: verify video ownership, execute `StorageService.completeMultipartUpload`, update status to `UPLOADED`, and add job `{ videoId, s3Key }` to BullMQ `video-processing` queue.
- Expose `POST /videos/:videoId/upload/confirm` in `VideosController`.

**Tests:**
- Unit test `videos.service.spec.ts` covering `confirmUpload`.

**Dependencies:** SI-03.4

**Acceptance criteria:**
- Endpoint completes S3 multipart upload.
- Video status transitions to `UPLOADED`.
- Job dispatched to BullMQ queue `'video-processing'`.

---

### SI-03.6 — Video Worker Process and FFmpeg Processing Processor

**Description:** Implement the standalone Video Worker process and BullMQ queue processor to extract video duration/metadata via `ffprobe`, generate automatic thumbnail via `ffmpeg`, upload thumbnail to S3, and update video status to `READY` (or `ERROR`).

**Technical actions:**
- Create standalone entry point `src/worker.ts` initializing NestJS application context with `AppModule`.
- Create `VideoProcessingProcessor` in `src/worker/processors/video-processing.processor.ts` decorated with `@Processor('video-processing')`.
- On job processing: update status to `PROCESSING`; download video stream or temporary file from S3; run `ffprobe` to extract `duration`, `resolution`, `codec`; run `ffmpeg` seeking to `min(10s, duration * 0.1)` to capture PNG/JPEG thumbnail frame; upload thumbnail to S3 (`thumbnails/{videoId}.jpg`); update video record with `duration`, `thumbnailKey`, and status `READY`.
- On failure after max retries: set status to `ERROR` and save error message to `processingError`.

**Tests:**
- Unit test `video-processing.processor.spec.ts` covering job execution and error handling.

**Dependencies:** SI-03.5

**Acceptance criteria:**
- `npm run start:worker` starts the isolated worker process cleanly.
- Worker processes queued jobs automatically, extracts duration, generates thumbnail, uploads thumbnail to S3, and sets status to `READY`.

---

### SI-03.7 — Video Metadata, Streaming, and Download Endpoints

**Description:** Implement `GET /videos/:videoId`, `GET /videos/:videoId/stream`, and `GET /videos/:videoId/download` endpoints.

**Technical actions:**
- `GET /videos/:videoId` (Public): Returns video metadata, status, duration, thumbnail URL, and stream/download endpoints.
- `GET /videos/:videoId/stream` (Public): Generates presigned GET URL for `s3Key` in MinIO and issues HTTP 302 Redirect.
- `GET /videos/:videoId/download` (Public): Generates presigned GET URL for `s3Key` with `response-content-disposition=attachment` header and issues HTTP 302 Redirect.

**Tests:**
- Unit tests in `videos.service.spec.ts` for metadata, streaming, and download logic.

**Dependencies:** SI-03.6

**Acceptance criteria:**
- `GET /videos/:videoId` returns video details and status.
- `GET /videos/:videoId/stream` redirects (302) to presigned S3 GET URL.
- `GET /videos/:videoId/download` redirects (302) to presigned S3 GET URL with attachment disposition.

---

### SI-03.8 — Docker Compose Infrastructure and Dedicated Worker Service

**Description:** Add Redis, MinIO, and a dedicated `nestjs-worker` background service to `nestjs-project/compose.yaml` so the stack processes videos automatically without manual commands.

**Technical actions:**
- Update `nestjs-project/compose.yaml`:
  - `redis`: Redis 7 Alpine image with healthcheck.
  - `minio`: MinIO S3 storage with console port and healthcheck.
  - `nestjs-worker`: Service built from `Dockerfile.dev`, running `command: npm run start:worker`, volume `.:/home/node/app`, and `depends_on` healthy `db`, `redis`, and `minio`.
  - Add `redis` and `minio` to `depends_on` of `nestjs-api`.

**Dependencies:** SI-03.6

**Acceptance criteria:**
- `docker compose up -d` starts API, DB, Mailpit, Redis, MinIO, and `nestjs-worker`.
- The stack automatically processes uploaded videos end-to-end without manual intervention.

---

## Dependency Map

```
SI-03.1, SI-03.2, SI-03.3
├── SI-03.4
    └── SI-03.5
        └── SI-03.6
            └── SI-03.7
                └── SI-03.8
```

---

## Deliverables

- [x] StorageModule connected to MinIO S3 with `streamtube-videos` bucket setup
- [x] QueueModule connected to Redis with BullMQ `video-processing` queue
- [x] `Video` entity with NanoID 21-char unique identifier and 5-state lifecycle enum
- [x] Multipart presigned upload initiation (`POST /videos/upload/initiate`)
- [x] Multipart upload confirmation (`POST /videos/:videoId/upload/confirm`) and job queue dispatch
- [x] Video Worker standalone NestJS app consuming BullMQ jobs, executing FFmpeg/ffprobe, generating thumbnail, updating status
- [x] Streaming redirect (`GET /videos/:videoId/stream`) and download redirect (`GET /videos/:videoId/download`)
- [x] Dedicated `nestjs-worker` service in `compose.yaml` running `npm run start:worker`
- [x] All unit, integration, and e2e tests passing
- [x] TypeScript clean compilation (`npx tsc --noEmit`)
