import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import { InitiateUploadDto } from '../dto/initiate-upload.dto';
import { ConfirmUploadDto } from '../dto/confirm-upload.dto';
import {
  InvalidVideoStateException,
  VideoNotFoundException,
  VideoNotOwnedByUserException,
} from '../exceptions/video.exceptions';

@Injectable()
export class VideosService {
  private readonly PART_SIZE = 5 * 1024 * 1024; // 5MB minimum part size for S3/MinIO

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @InjectQueue('video-processing')
    private readonly videoQueue: Queue,
  ) {}

  async initiateUpload(userId: string, dto: InitiateUploadDto) {
    const videoId = nanoid(10);
    const s3Key = `raw-videos/${videoId}/${dto.fileName}`;

    const uploadId = await this.storageService.createMultipartUpload(
      s3Key,
      dto.mimeType,
    );

    const partCount = Math.max(1, Math.ceil(dto.fileSize / this.PART_SIZE));
    const partsPromises: Promise<{ partNumber: number; url: string }>[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      partsPromises.push(
        this.storageService
          .getPresignedPartUrl(s3Key, uploadId, partNumber)
          .then((url) => ({ partNumber, url })),
      );
    }

    const parts = await Promise.all(partsPromises);

    const video = this.videoRepository.create({
      videoId,
      title: dto.title,
      description: dto.description || null,
      status: VideoStatus.DRAFT,
      originalFileName: dto.fileName,
      mimeType: dto.mimeType,
      fileSize: dto.fileSize,
      s3Key,
      userId,
    });

    await this.videoRepository.save(video);

    return {
      id: video.id,
      videoId: video.videoId,
      uploadId,
      s3Key,
      parts,
    };
  }

  async confirmUpload(
    userId: string,
    idOrVideoId: string,
    dto: ConfirmUploadDto,
  ) {
    const video = await this.findVideoByIdOrVideoId(idOrVideoId);

    if (video.userId !== userId) {
      throw new VideoNotOwnedByUserException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException(
        `Video is in status ${video.status}, expected DRAFT`,
      );
    }

    await this.storageService.completeMultipartUpload(
      video.s3Key!,
      dto.uploadId,
      dto.parts,
    );

    video.status = VideoStatus.UPLOADED;
    await this.videoRepository.save(video);

    await this.videoQueue.add(
      'process-video',
      {
        videoId: video.id,
        videoShortId: video.videoId,
        s3Key: video.s3Key,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    );

    return {
      id: video.id,
      videoId: video.videoId,
      status: video.status,
    };
  }

  async getVideo(idOrVideoId: string) {
    const video = await this.findVideoByIdOrVideoId(idOrVideoId);

    let streamUrl: string | null = null;
    let downloadUrl: string | null = null;
    let thumbnailUrl: string | null = null;

    if (video.status === VideoStatus.READY) {
      if (video.s3Key) {
        streamUrl = await this.storageService.getPresignedStreamUrl(video.s3Key);
        downloadUrl = await this.storageService.getPresignedDownloadUrl(
          video.s3Key,
          video.originalFileName || undefined,
        );
      }
      if (video.thumbnailKey) {
        thumbnailUrl = await this.storageService.getPresignedStreamUrl(
          video.thumbnailKey,
        );
      }
    }

    return {
      ...video,
      streamUrl,
      downloadUrl,
      thumbnailUrl,
    };
  }

  async getStreamUrl(idOrVideoId: string): Promise<string> {
    const video = await this.findVideoByIdOrVideoId(idOrVideoId);

    if (video.status !== VideoStatus.READY || !video.s3Key) {
      throw new InvalidVideoStateException('Video is not ready for streaming');
    }

    return this.storageService.getPresignedStreamUrl(video.s3Key);
  }

  async getDownloadUrl(idOrVideoId: string): Promise<string> {
    const video = await this.findVideoByIdOrVideoId(idOrVideoId);

    if (video.status !== VideoStatus.READY || !video.s3Key) {
      throw new InvalidVideoStateException('Video is not ready for download');
    }

    return this.storageService.getPresignedDownloadUrl(
      video.s3Key,
      video.originalFileName || undefined,
    );
  }

  private async findVideoByIdOrVideoId(idOrVideoId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: [{ id: idOrVideoId }, { videoId: idOrVideoId }],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }
}
