import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import ffmpeg = require('fluent-ffmpeg');
import * as ffmpegStatic from 'ffmpeg-static';
import * as ffprobeStatic from '@ffprobe-installer/ffprobe';
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

    if (ffmpegStatic) {
      ffmpeg.setFfmpegPath(typeof ffmpegStatic === 'string' ? ffmpegStatic : (ffmpegStatic as any).default || ffmpegStatic);
    }
    if (ffprobeStatic && ffprobeStatic.path) {
      ffmpeg.setFfprobePath(ffprobeStatic.path);
    }
  }

  async process(job: Job<ProcessVideoJobData>): Promise<any> {
    const { videoId, videoShortId, s3Key } = job.data;
    this.logger.log(`Processing video job ${job.id} for videoId: ${videoId}`);

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

      // 2. Extract metadata (duration) using ffprobe
      const metadata = await this.extractMetadata(tempVideoPath);
      const duration = metadata.format.duration || 0;

      // 3. Compute thumbnail timestamp (AMB-1 resolution heuristic: min(10s, duration * 10%))
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
      video.thumbnailKey = thumbnailKey;
      video.processingError = null;
      await this.videoRepository.save(video);

      this.logger.log(`Video ${videoId} processed successfully (duration: ${duration}s)`);
    } catch (err: any) {
      this.logger.error(`Error processing video ${videoId}: ${err.message}`, err.stack);

      const maxAttempts = job.opts.attempts || 3;
      if (job.attemptsMade >= maxAttempts) {
        video.status = VideoStatus.ERROR;
        video.processingError = err.message || 'Unknown processing error';
        await this.videoRepository.save(video);
      }
      throw err;
    } finally {
      // Cleanup local temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupErr: any) {
        this.logger.warn(`Failed to cleanup temp dir ${tempDir}: ${cleanupErr.message}`);
      }
    }
  }

  private saveStreamToFile(stream: Readable, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      stream.pipe(writer);
      writer.on('finish', () => resolve());
      writer.on('error', (err) => reject(err));
    });
  }

  private extractMetadata(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
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
        .on('error', (err) => reject(err))
        .run();
    });
  }
}
