import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { VideosService } from './videos.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import { ChannelsService } from '../../channels/channels.service';
import { Channel } from '../../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  VideoNotFoundException,
  VideoNotOwnedByUserException,
} from '../exceptions/video.exceptions';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepositoryMock: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    findOneBy: jest.Mock;
  };
  let storageServiceMock: {
    createMultipartUpload: jest.Mock;
    getPresignedPartUrl: jest.Mock;
    completeMultipartUpload: jest.Mock;
    getPresignedStreamUrl: jest.Mock;
    getPresignedDownloadUrl: jest.Mock;
  };
  let channelsServiceMock: {
    findByUserId: jest.Mock;
  };
  let queueMock: {
    add: jest.Mock;
  };

  const mockChannel = {
    id: 'channel-uuid-1',
    name: 'Test Channel',
    nickname: 'test_channel',
    description: null,
    user_id: 'user-1',
    created_at: new Date(),
    updated_at: new Date(),
  } as unknown as Channel;

  beforeEach(async () => {
    videoRepositoryMock = {
      create: jest.fn().mockImplementation((dto: Partial<Video>) => ({
        ...dto,
        id: 'uuid-1',
      })),
      save: jest
        .fn()
        .mockImplementation((video: Partial<Video>) =>
          Promise.resolve({ ...video }),
        ),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
    };
    videoRepositoryMock.findOneBy.mockImplementation(
      (where: {
        id?: string;
        videoId?: string;
      }): Promise<Partial<Video> | null> =>
        videoRepositoryMock.findOne({
          where,
        }) as Promise<Partial<Video> | null>,
    );

    storageServiceMock = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id-123'),
      getPresignedPartUrl: jest
        .fn()
        .mockResolvedValue('http://minio/presigned-part-url'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      getPresignedStreamUrl: jest
        .fn()
        .mockResolvedValue('http://minio/stream-url'),
      getPresignedDownloadUrl: jest
        .fn()
        .mockResolvedValue('http://minio/download-url'),
    };

    channelsServiceMock = {
      findByUserId: jest.fn().mockResolvedValue(mockChannel),
    };

    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepositoryMock as unknown as Repository<Video>,
        },
        {
          provide: StorageService,
          useValue: storageServiceMock as unknown as StorageService,
        },
        {
          provide: ChannelsService,
          useValue: channelsServiceMock as unknown as ChannelsService,
        },
        {
          provide: getQueueToken('video-processing'),
          useValue: queueMock as unknown as Queue,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initiateUpload', () => {
    it('should create a DRAFT video with channelId and return presigned part URLs', async () => {
      const dto = {
        title: 'Test Video',
        description: 'Description',
        fileName: 'test.mp4',
        mimeType: 'video/mp4',
        fileSize: 10485760, // ~10MB -> 2 parts of 5MB
      };

      const result = await service.initiateUpload('user-1', dto);

      expect(result).toBeDefined();
      expect(result.id).toBe('uuid-1');
      expect(result.videoId).toHaveLength(21);
      expect(result.uploadId).toBe('upload-id-123');
      expect(result.parts).toHaveLength(2);
      expect(videoRepositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Video',
          status: VideoStatus.DRAFT,
          userId: 'user-1',
          channelId: 'channel-uuid-1',
        }),
      );
    });

    it('should throw ChannelNotFoundException when user channel does not exist', async () => {
      channelsServiceMock.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload('user-without-channel', {
          title: 'Title',
          fileName: 'video.mp4',
          mimeType: 'video/mp4',
          fileSize: 1000,
        }),
      ).rejects.toThrow(ChannelNotFoundException);
    });
  });

  describe('getStreamUrl', () => {
    it('should return presigned stream URL when video is READY', async () => {
      const mockVideo: Partial<Video> = {
        id: 'uuid-1',
        videoId: 'short-123',
        status: VideoStatus.READY,
        s3Key: 'raw-videos/short-123/test.mp4',
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      const url = await service.getStreamUrl('short-123');

      expect(url).toBe('http://minio/stream-url');
      expect(storageServiceMock.getPresignedStreamUrl).toHaveBeenCalledWith(
        'raw-videos/short-123/test.mp4',
      );
    });

    it('should throw InvalidVideoStateException when video is not READY', async () => {
      const mockVideo: Partial<Video> = {
        id: 'uuid-1',
        videoId: 'short-123',
        status: VideoStatus.PROCESSING,
        s3Key: 'raw-videos/short-123/test.mp4',
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      await expect(service.getStreamUrl('short-123')).rejects.toThrow(
        InvalidVideoStateException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('should return presigned download URL when video is READY', async () => {
      const mockVideo: Partial<Video> = {
        id: 'uuid-1',
        videoId: 'short-123',
        status: VideoStatus.READY,
        s3Key: 'raw-videos/short-123/test.mp4',
        originalFileName: 'original.mp4',
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      const url = await service.getDownloadUrl('short-123');

      expect(url).toBe('http://minio/download-url');
      expect(storageServiceMock.getPresignedDownloadUrl).toHaveBeenCalledWith(
        'raw-videos/short-123/test.mp4',
        'original.mp4',
      );
    });

    it('should throw InvalidVideoStateException when video is not READY', async () => {
      const mockVideo: Partial<Video> = {
        id: 'uuid-1',
        videoId: 'short-123',
        status: VideoStatus.DRAFT,
        s3Key: 'raw-videos/short-123/test.mp4',
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      await expect(service.getDownloadUrl('short-123')).rejects.toThrow(
        InvalidVideoStateException,
      );
    });
  });

  describe('confirmUpload', () => {
    it('should complete multipart upload, update status to UPLOADED and dispatch job to queue', async () => {
      const mockVideo: Partial<Video> = {
        id: 'uuid-1',
        videoId: 'short-123',
        userId: 'user-1',
        channelId: 'channel-uuid-1',
        status: VideoStatus.DRAFT,
        s3Key: 'raw-videos/short-123/test.mp4',
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      const confirmDto = {
        uploadId: 'upload-id-123',
        parts: [{ ETag: 'etag-1', PartNumber: 1 }],
      };

      const result = await service.confirmUpload(
        'user-1',
        'short-123',
        confirmDto,
      );

      expect(result.status).toBe(VideoStatus.UPLOADED);
      expect(storageServiceMock.completeMultipartUpload).toHaveBeenCalledWith(
        'raw-videos/short-123/test.mp4',
        'upload-id-123',
        confirmDto.parts,
      );
      expect(queueMock.add).toHaveBeenCalledWith(
        'process-video',
        expect.objectContaining({
          videoId: 'uuid-1',
          videoShortId: 'short-123',
        }),
        expect.any(Object),
      );
    });

    it('should throw VideoNotOwnedByUserException if user does not own video', async () => {
      const mockVideo: Partial<Video> = {
        id: 'uuid-1',
        videoId: 'short-123',
        userId: 'other-user',
        status: VideoStatus.DRAFT,
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      await expect(
        service.confirmUpload('user-1', 'short-123', {
          uploadId: 'up-1',
          parts: [],
        }),
      ).rejects.toThrow(VideoNotOwnedByUserException);
    });

    it('should throw InvalidVideoStateException if video is not in DRAFT status', async () => {
      const mockVideo: Partial<Video> = {
        id: 'uuid-1',
        videoId: 'short-123',
        userId: 'user-1',
        status: VideoStatus.READY,
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      await expect(
        service.confirmUpload('user-1', 'short-123', {
          uploadId: 'up-1',
          parts: [],
        }),
      ).rejects.toThrow(InvalidVideoStateException);
    });

    it('should throw VideoNotFoundException if video does not exist', async () => {
      videoRepositoryMock.findOne.mockResolvedValue(null);

      await expect(
        service.confirmUpload('user-1', 'non-existent', {
          uploadId: 'up-1',
          parts: [],
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('getVideo', () => {
    it('should return video metadata and presigned URLs if READY', async () => {
      const mockVideo: Partial<Video> = {
        id: 'uuid-1',
        videoId: 'short-123',
        status: VideoStatus.READY,
        s3Key: 'raw-videos/short-123/test.mp4',
        thumbnailKey: 'thumbnails/short-123.jpg',
        originalFileName: 'test.mp4',
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      const result = await service.getVideo('short-123');

      expect(result.streamUrl).toBe('http://minio/stream-url');
      expect(result.downloadUrl).toBe('http://minio/download-url');
      expect(result.thumbnailUrl).toBe('http://minio/stream-url');
    });

    it('should return video without stream URLs if status is not READY', async () => {
      const mockVideo: Partial<Video> = {
        id: 'uuid-1',
        videoId: 'short-123',
        status: VideoStatus.PROCESSING,
        s3Key: 'raw-videos/short-123/test.mp4',
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      const result = await service.getVideo('short-123');

      expect(result.streamUrl).toBeNull();
      expect(result.downloadUrl).toBeNull();
      expect(result.thumbnailUrl).toBeNull();
    });
  });
});
