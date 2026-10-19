import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from '@ffprobe-installer/ffprobe';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import { Readable } from 'stream';

export interface ProcessVideoJobData {
  videoId: string;
  videoShortId: string;
  s3Key: string;
}

@Injectable()
@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();

    if (fs.existsSync('/usr/bin/ffmpeg')) {
      ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
    } else if (ffmpegPath && typeof ffmpegPath === 'string') {
      ffmpeg.setFfmpegPath(ffmpegPath);
    }

    if (fs.existsSync('/usr/bin/ffprobe')) {
      ffmpeg.setFfprobePath('/usr/bin/ffprobe');
    } else if (ffprobeStatic && typeof ffprobeStatic.path === 'string') {
      ffmpeg.setFfprobePath(ffprobeStatic.path);
    }
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId, videoShortId, s3Key } = job.data;
    this.logger.log(
      `Processing video job ${job.id ?? 'unknown'} for videoId: ${videoId}`,
    );

    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      this.logger.error(`Video ${videoId} not found in database`);
      return;
    }

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamtube-video-'));
    const tempVideoPath = path.join(tempDir, `video_${videoShortId}.mp4`);
    const tempThumbPath = path.join(tempDir, `thumb_${videoShortId}.jpg`);

    try {
      // 1. Download video stream to local temp file
      const stream = await this.storageService.getObjectStream(s3Key);
      await this.saveStreamToFile(stream, tempVideoPath);

      // 2. Extract metadata (duration + format/stream specs) using ffprobe
      const probeData = await this.extractMetadata(tempVideoPath);
      const duration = probeData.format.duration ?? 0;

      const videoStream = probeData.streams?.find(
        (s) => s.codec_type === 'video',
      );
      const audioStream = probeData.streams?.find(
        (s) => s.codec_type === 'audio',
      );

      const metadata: Record<string, any> = {
        formatName: probeData.format.format_name,
        bitRate: probeData.format.bit_rate,
        width: videoStream?.width,
        height: videoStream?.height,
        videoCodec: videoStream?.codec_name,
        audioCodec: audioStream?.codec_name,
        frameRate: videoStream?.r_frame_rate,
      };

      // 3. Compute thumbnail timestamp (heuristic: min(10s, duration * 10%))
      const thumbnailSeek = Math.min(10, duration * 0.1);

      // 4. Extract thumbnail frame using ffmpeg
      await this.extractThumbnail(tempVideoPath, tempThumbPath, thumbnailSeek);

      // 5. Upload thumbnail buffer to MinIO S3
      const thumbnailBuffer = fs.readFileSync(tempThumbPath);
      const thumbnailKey = `thumbnails/${videoShortId}.jpg`;
      await this.storageService.uploadBuffer(
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      // 6. Update video entity status to READY
      video.status = VideoStatus.READY;
      video.duration = duration;
      video.metadata = metadata;
      video.thumbnailKey = thumbnailKey;
      video.processingError = null;
      await this.videoRepository.save(video);

      this.logger.log(
        `Video ${videoId} processed successfully (duration: ${duration}s)`,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;

      this.logger.error(
        `Error processing video ${videoId}: ${errorMessage}`,
        errorStack,
      );

      const maxAttempts = job.opts.attempts ?? 3;
      if (job.attemptsMade >= maxAttempts) {
        video.status = VideoStatus.ERROR;
        video.processingError = errorMessage || 'Unknown processing error';
        await this.videoRepository.save(video);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      // Cleanup local temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupErr: unknown) {
        const cleanupMsg =
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        this.logger.warn(
          `Failed to cleanup temp dir ${tempDir}: ${cleanupMsg}`,
        );
      }
    }
  }

  private saveStreamToFile(stream: Readable, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      stream.pipe(writer);
      writer.on('finish', () => resolve());
      writer.on('error', (err: Error) => reject(err));
    });
  }

  private extractMetadata(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(
        filePath,
        (err: Error | null, data: ffmpeg.FfprobeData) => {
          if (err) {
            return reject(err instanceof Error ? err : new Error(String(err)));
          }
          resolve(data);
        },
      );
    });
  }

  private extractThumbnail(
    videoPath: string,
    thumbPath: string,
    seekSeconds: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(seekSeconds)
        .frames(1)
        .output(thumbPath)
        .on('end', () => resolve())
        .on('error', (err: Error) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        )
        .run();
    });
  }
}
