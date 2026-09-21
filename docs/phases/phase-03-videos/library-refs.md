---
libs:
  "@nestjs/bullmq":
    version: "^11.0.0"
    fetched_at: "2026-09-21T15:31:00-03:00"
  "bullmq":
    version: "^5.x"
    fetched_at: "2026-09-21T15:31:00-03:00"
  "ioredis":
    version: "^5.x"
    fetched_at: "2026-09-21T15:31:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    fetched_at: "2026-09-21T15:31:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    fetched_at: "2026-09-21T15:31:00-03:00"
  "fluent-ffmpeg":
    version: "^2.x"
    fetched_at: "2026-09-21T15:31:00-03:00"
  "@types/fluent-ffmpeg":
    version: "^2.x"
    fetched_at: "2026-09-21T15:31:00-03:00"
  "nanoid":
    version: "^3.x"
    fetched_at: "2026-09-21T15:31:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-21T15:27:27-03:00"
---

# Library References — phase-03-videos

## @nestjs/bullmq + bullmq

**Usage in scope:** TD-01 — Message Queue. Queue producer in `VideosModule` (API side); processor in the video worker via `WorkerHost`.

**Key APIs:**

- `BullModule.forRoot({ connection: { host, port } })` — register Redis connection globally in `AppModule` / `WorkerModule`.
- `BullModule.registerQueue({ name: 'video-processing' })` — register a named queue in a feature module.
- `@InjectQueue('video-processing') private queue: Queue` — inject producer queue in a service.
- `await this.queue.add('process-video', { videoId }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })` — publish a job with retry config.
- `@Processor('video-processing')` + `extends WorkerHost` — declare a worker processor class.
- `async process(job: Job<{ videoId: string }>): Promise<void>` — the main method to override; route by `job.name` with a switch.
- `@OnWorkerEvent('completed')` / `@OnWorkerEvent('failed')` — lifecycle event decorators.

**Module wiring:**

```typescript
// API side — VideosModule
imports: [
  BullModule.registerQueue({ name: 'video-processing' }),
]

// Worker side — WorkerModule
imports: [
  BullModule.registerQueue({ name: 'video-processing' }),
]
providers: [VideoProcessorService]  // the @Processor class
```

**Concurrency:** Set via `@Processor('video-processing', { concurrency: 2 })` — controls how many jobs run in parallel per worker instance.

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Usage in scope:** TD-02 (multipart upload), TD-06 (presigned GET for streaming/download).

**Critical MinIO config:** always set `forcePathStyle: true` in `S3Client`.

```typescript
const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,   // e.g. http://minio:9000
  region: 'us-east-1',
  forcePathStyle: true,                   // REQUIRED for MinIO
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
});
```

**Multipart upload flow (TD-02):**

1. `CreateMultipartUploadCommand({ Bucket, Key })` → returns `UploadId`
2. `getSignedUrl(s3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: N }), { expiresIn: 3600 })` — one presigned URL per part (100MB chunks → 100 URLs for 10GB)
3. Client uploads each part via PUT; gets ETag per part
4. `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` — API calls this after client confirms all parts

**Streaming/download (TD-06):**

```typescript
const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
// Return 302 redirect or JSON { streamUrl: url }
```

---

## fluent-ffmpeg + @types/fluent-ffmpeg

**Usage in scope:** TD-04 — metadata extraction (`ffprobe`) + thumbnail generation.

**Binary setup in worker Docker image:**
```dockerfile
RUN apt-get update && apt-get install -y ffmpeg
```
If binary is not on PATH, set programmatically:
```typescript
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');
```

**Metadata extraction (promise wrapper):**
```typescript
function probeVideo(path: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, (err, data) => err ? reject(err) : resolve(data));
  });
}
// Usage:
const meta = await probeVideo(localPath);
const duration = meta.format.duration;      // seconds (float)
const width = meta.streams[0].width;
const height = meta.streams[0].height;
const codec = meta.streams[0].codec_name;
```

**Thumbnail generation (TD-04 heuristic — seek to min(10s, duration×10%)):**
```typescript
function generateThumbnail(inputPath: string, outputDir: string, filename: string, seekTime: number): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        timestamps: [seekTime],   // e.g. Math.min(10, duration * 0.1)
        filename,
        folder: outputDir,
        size: '1280x720',
      })
      .on('end', () => resolve(filename))
      .on('error', (err) => reject(err));
  });
}
```

---

## nanoid (v3.x — CJS-compatible)

**Usage in scope:** TD-05 — unique video URL identifier.

**Why v3:** `nanoid` v4+ is ESM-only and throws `ERR_REQUIRE_ESM` in CommonJS NestJS apps. v3 is CJS-compatible with identical API.

```typescript
// CommonJS import (works in NestJS TypeScript compiled to CJS)
import { nanoid } from 'nanoid';

// Generate a 21-char URL-safe ID (default)
const videoId = nanoid();           // e.g. "V1StGXR8_Z5jdHi6B-myT"

// Custom length (e.g. 11 chars like YouTube)
const shortId = nanoid(11);

// Custom alphabet if needed
import { customAlphabet } from 'nanoid';
const generate = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
```

**Collision handling:** add `UNIQUE` index on `videos.videoId` column. On `UniqueConstraintViolation`, retry `nanoid()` once (astronomically rare at 21 chars).
