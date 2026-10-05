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

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, default uuid_generate_v4() | Identificador interno da entidade |
| videoId | varchar(21) | unique, not null | Identificador público NanoID para URLs limpas |
| title | varchar(255) | not null | Título do vídeo informado pelo usuário |
| description | text | nullable | Descrição textual do vídeo |
| status | enum | not null, default 'DRAFT' | `videos_status_enum` (DRAFT, UPLOADED, PROCESSING, READY, ERROR) |
| originalFileName | varchar(255) | nullable | Nome original do arquivo enviado |
| mimeType | varchar(100) | nullable | Tipo MIME do arquivo (ex.: 'video/mp4') |
| fileSize | bigint | nullable | Tamanho total do arquivo em bytes |
| s3Key | varchar(500) | nullable | Caminho do arquivo de vídeo no MinIO/S3 (`raw-videos/{videoId}/{fileName}`) |
| thumbnailKey | varchar(500) | nullable | Caminho do thumbnail no MinIO/S3 (`thumbnails/{videoId}.jpg`) |
| duration | double precision | nullable | Duração do vídeo em segundos extraída via `ffprobe` |
| processingError | text | nullable | Mensagem de erro caso o processamento falhe |
| userId | uuid | FK → users.id, not null | Usuário proprietário do vídeo (associado 1:1 ao Channel) |
| createdAt | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updatedAt | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:**
- Video → User (`ManyToOne`, onDelete: `CASCADE`). Cada usuário possui um único `Channel` (criado na Fase 02), garantindo a titularidade do canal sobre o vídeo.

**Indexes:**
- `(videoId)` — Unique index (`IDX_videos_videoId`) para busca rápida e segura por URL pública.
- `(userId)` — Foreign key index.

#### VideoStatus Enum & State Lifecycle

```
[ POST /videos/upload/initiate ]
              │
              ▼
           +--------+
           | DRAFT  | ─── (Upload multipart iniciado; URLs pré-assinadas geradas)
           +--------+
              │
              │ [ POST /videos/:videoId/upload/confirm ]
              ▼
          +----------+
          | UPLOADED | ─── (Multipart concluído no S3; Job publicado no BullMQ)
          +----------+
              │
              │ [ VideoProcessingProcessor inicia execução ]
              ▼
         +------------+
         | PROCESSING | ─── (Worker baixando stream, rodando ffprobe e ffmpeg)
         +------------+
           /        \
  (Sucesso)          (Falha após 3 tentativas)
     │                     │
     ▼                     ▼
 +-------+             +-------+
 | READY |             | ERROR | ── (Armazena erro em `processingError`)
 +-------+             +-------+
 (Stream/Download
   disponíveis)
```

---

### API Contracts

#### POST /videos/upload/initiate (SI-03.4)

Inicia uma sessão de upload multipart direto para o MinIO/S3, cadastrando o vídeo como `DRAFT`.

**Request headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <jwt-access-token>`

**Request body:**
```json
{
  "title": "Minha Primeira Aula",
  "description": "Introdução ao NestJS",
  "fileName": "aula01.mp4",
  "mimeType": "video/mp4",
  "fileSize": 104857600
}
```

**Response 201 Created:**
```json
{
  "id": "c3e98179-8dbd-4fc2-a329-373307b27814",
  "videoId": "V1StGXR8_Z5jdHi6B-myT",
  "uploadId": "VXBsb2FkIElEIGV4YW1wbGU",
  "s3Key": "raw-videos/V1StGXR8_Z5jdHi6B-myT/aula01.mp4",
  "parts": [
    {
      "partNumber": 1,
      "url": "http://minio:9000/streamtube-videos/raw-videos/V1StGXR8_Z5jdHi6B-myT/aula01.mp4?partNumber=1&uploadId=..."
    }
  ]
}
```

**Error responses:**
- 400 `VALIDATION_ERROR`: Schema inválido ou campos obrigatórios ausentes.
- 401 `UNAUTHORIZED`: Token de acesso JWT ausente ou expirado.

---

#### POST /videos/:videoId/upload/confirm (SI-03.5)

Confirma a montagem de todas as partes no S3, atualiza o status para `UPLOADED` e despacha o job de processamento assíncrono.

**Request headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <jwt-access-token>`

**Path parameters:**
- `videoId`: string (UUID ou NanoID de 21 caracteres)

**Request body:**
```json
{
  "uploadId": "VXBsb2FkIElEIGV4YW1wbGU",
  "parts": [
    {
      "PartNumber": 1,
      "ETag": "\"b10a8db164e0754105b7a99be72e3fe5\""
    }
  ]
}
```

**Response 200 OK:**
```json
{
  "id": "c3e98179-8dbd-4fc2-a329-373307b27814",
  "videoId": "V1StGXR8_Z5jdHi6B-myT",
  "status": "UPLOADED"
}
```

**Error responses:**
- 400 `VALIDATION_ERROR`: `uploadId` ausente ou lista de partes vazia/malformatada.
- 400 `INVALID_VIDEO_STATE`: Vídeo não está em status `DRAFT` (ex.: já confirmado ou processado).
- 401 `UNAUTHORIZED`: Token ausente ou inválido.
- 403 `VIDEO_NOT_OWNED_BY_USER`: O usuário autenticado não é o dono do vídeo.
- 404 `VIDEO_NOT_FOUND`: Vídeo não encontrado pelo ID ou NanoID informado.

---

#### GET /videos/:videoId (SI-03.7)

Recupera os metadados do vídeo e URLs pré-assinadas temporárias de streaming/download (se `READY`).

**Path parameters:**
- `videoId`: string (UUID ou NanoID)

**Response 200 OK:**
```json
{
  "id": "c3e98179-8dbd-4fc2-a329-373307b27814",
  "videoId": "V1StGXR8_Z5jdHi6B-myT",
  "title": "Minha Primeira Aula",
  "description": "Introdução ao NestJS",
  "status": "READY",
  "originalFileName": "aula01.mp4",
  "mimeType": "video/mp4",
  "fileSize": 104857600,
  "duration": 124.5,
  "streamUrl": "http://minio:9000/streamtube-videos/raw-videos/...?",
  "downloadUrl": "http://minio:9000/streamtube-videos/raw-videos/...?",
  "thumbnailUrl": "http://minio:9000/streamtube-videos/thumbnails/V1StGXR8_Z5jdHi6B-myT.jpg?...",
  "createdAt": "2026-09-21T18:00:00.000Z",
  "updatedAt": "2026-09-21T18:02:15.000Z"
}
```

**Error responses:**
- 404 `VIDEO_NOT_FOUND`: Vídeo não encontrado.

---

#### GET /videos/:videoId/stream (SI-03.7)

Redireciona diretamente para a URL pré-assinada do arquivo no MinIO/S3 para streaming via HTTP Range requests (206 Partial Content).

**Path parameters:**
- `videoId`: string (UUID ou NanoID)

**Response 302 Found:**
- Header `Location`: `http://minio:9000/streamtube-videos/raw-videos/...?X-Amz-Signature=...`

**Error responses:**
- 400 `INVALID_VIDEO_STATE`: Vídeo ainda não está com status `READY`.
- 404 `VIDEO_NOT_FOUND`: Vídeo não encontrado.

---

#### GET /videos/:videoId/download (SI-03.7)

Redireciona para o MinIO/S3 gerando download forçado através do parâmetro `response-content-disposition=attachment`.

**Path parameters:**
- `videoId`: string (UUID ou NanoID)

**Response 302 Found:**
- Header `Location`: `http://minio:9000/streamtube-videos/raw-videos/...?response-content-disposition=attachment...`

**Error responses:**
- 400 `INVALID_VIDEO_STATE`: Vídeo ainda não está com status `READY`.
- 404 `VIDEO_NOT_FOUND`: Vídeo não encontrado.

---

#### Validation Rules — Video Upload

| DTO | Field | Rule | Error Message |
|-----|-------|------|---------------|
| `InitiateUploadDto` | `title` | `@IsString()`, `@IsNotEmpty()` | title should not be empty |
| `InitiateUploadDto` | `fileName` | `@IsString()`, `@IsNotEmpty()` | fileName should not be empty |
| `InitiateUploadDto` | `mimeType` | `@IsString()`, `@IsNotEmpty()` | mimeType should not be empty |
| `InitiateUploadDto` | `fileSize` | `@IsInt()`, `@Min(1)` | fileSize must not be less than 1 |
| `ConfirmUploadDto` | `uploadId` | `@IsString()`, `@IsNotEmpty()` | uploadId should not be empty |
| `ConfirmUploadDto` | `parts` | `@IsArray()`, `@ValidateNested({ each: true })` | parts must be an array |
| `PartETagDto` | `ETag` | `@IsString()`, `@IsNotEmpty()` | ETag should not be empty |
| `PartETagDto` | `PartNumber` | `@IsInt()` | PartNumber must be an integer number |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Ownership Verified | Notes |
|----------|:------:|:-------------:|:------------------:|-------|
| `POST /videos/upload/initiate` | | ✓ | | Requer JWT válido (`user.sub` define o criador) |
| `POST /videos/:videoId/upload/confirm` | | ✓ | ✓ | Apenas o usuário que iniciou o upload pode confirmá-lo |
| `GET /videos/:videoId` | ✓ | | | Acesso público a metadados e URLs de reprodução |
| `GET /videos/:videoId/stream` | ✓ | | | Redirecionamento 302 público para streaming direto no storage |
| `GET /videos/:videoId/download` | ✓ | | | Redirecionamento 302 público para download com attachment |

---

### Error Catalog

Formato padrão da resposta de erro (herdado da Fase 02 via `DomainExceptionFilter`):
```json
{
  "statusCode": number,
  "error": string,
  "message": string
}
```

| Code | HTTP | Message | Trigger |
|------|:----:|---------|---------|
| `VIDEO_NOT_FOUND` | 404 | Video not found | Busca por `videoId` ou `id` inexistente no banco |
| `VIDEO_NOT_OWNED_BY_USER` | 403 | You do not own this video | Usuário tenta confirmar upload de vídeo criado por outro usuário |
| `INVALID_VIDEO_STATE` | 400 | Video is in status X, expected DRAFT / Video is not ready for streaming/download | Tentativa de confirmar upload fora de `DRAFT` ou acessar stream/download fora de `READY` |
| `VALIDATION_ERROR` | 400 | Array de mensagens de erro | Falha de validação dos campos do DTO via `ValidationPipe` |
| `UNAUTHORIZED` | 401 | Unauthorized | Token JWT ausente ou expirado nas rotas autenticadas |

---

### Queue Events & Messages (BullMQ)

#### Queue Configuration
- **Broker:** Redis 7 Alpine (`compose.yaml` service `redis:6379`)
- **Queue Name:** `video-processing`
- **Job Name:** `process-video`

#### Message / Job Payload Schema (`ProcessVideoJobData`)

```typescript
export interface ProcessVideoJobData {
  videoId: string;        // UUID da entidade Video no PostgreSQL
  videoShortId: string;   // NanoID (21 caracteres) único para identificação e thumbnail
  s3Key: string;          // Chave do vídeo no S3/MinIO (raw-videos/:videoId/:fileName)
}
```

#### Job Publication Options
- **Attempts:** `3`
- **Backoff Strategy:** `exponential` com delay base de `5000ms` (5s, 10s, 20s)
- **Publisher:** `VideosService.confirmUpload` após a conclusão bem-sucedida do upload multipart no S3.

#### Worker Processing Lifecycle (`VideoProcessingProcessor`)
1. **Job Arrival:** O processador consome o job do Redis no processo standalone `nestjs-worker`.
2. **Status Transition:** Atualiza o registro no banco para `PROCESSING`.
3. **Download Stream:** Faz streaming do arquivo do MinIO/S3 para arquivo temporário em `/tmp/streamtube-video-*`.
4. **Metadata Extraction:** Executa `ffprobe` para extrair a duração exata (`duration`) em segundos.
5. **Thumbnail Generation:** Executa `ffmpeg` com busca rápida para o timestamp `min(10s, duration * 0.1)`, extraindo um frame JPEG de alta definição.
6. **Storage Upload:** Envia o buffer do thumbnail para o MinIO com chave `thumbnails/{videoShortId}.jpg` (`image/jpeg`).
7. **Success Completion:** Atualiza a entidade com `duration`, `thumbnailKey`, `status = READY` e zera `processingError`.
8. **Failure & Exhaustion:** Se uma tentativa falhar, lança exceção para acionar retry do BullMQ. Ao atingir o limite de tentativas (`attemptsMade >= maxAttempts`), transiciona o status do vídeo para `ERROR` e registra a causa em `processingError`.
9. **Resource Cleanup:** O bloco `finally` garante a exclusão dos arquivos e diretórios temporários do disco local.

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
