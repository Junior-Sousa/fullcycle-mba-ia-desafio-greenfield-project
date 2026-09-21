import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { VideosService } from './videos.service';
const getQueueToken = (name: string) => `BullQueue_${name}`;
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import {
  InvalidVideoStateException,
  VideoNotFoundException,
  VideoNotOwnedByUserException,
} from '../exceptions/video.exceptions';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepositoryMock: any;
  let storageServiceMock: any;
  let queueMock: any;

  beforeEach(async () => {
    videoRepositoryMock = {
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'uuid-1' })),
      save: jest.fn().mockImplementation((video) => Promise.resolve({ ...video })),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
    };
    videoRepositoryMock.findOneBy.mockImplementation((where: any) =>
      videoRepositoryMock.findOne({ where }),
    );

    storageServiceMock = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id-123'),
      getPresignedPartUrl: jest.fn().mockResolvedValue('http://minio/presigned-part-url'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      getPresignedStreamUrl: jest.fn().mockResolvedValue('http://minio/stream-url'),
      getPresignedDownloadUrl: jest.fn().mockResolvedValue('http://minio/download-url'),
    };

    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepositoryMock,
        },
        {
          provide: StorageService,
          useValue: storageServiceMock,
        },
        {
          provide: getQueueToken('video-processing'),
          useValue: queueMock,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initiateUpload', () => {
    it('should create a DRAFT video and return presigned part URLs', async () => {
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
      expect(result.uploadId).toBe('upload-id-123');
      expect(result.parts).toHaveLength(2);
      expect(videoRepositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Video',
          status: VideoStatus.DRAFT,
          userId: 'user-1',
        }),
      );
    });
  });

  describe('confirmUpload', () => {
    it('should complete multipart upload, update status to UPLOADED and dispatch job to queue', async () => {
      const mockVideo = {
        id: 'uuid-1',
        videoId: 'short-123',
        userId: 'user-1',
        status: VideoStatus.DRAFT,
        s3Key: 'raw-videos/short-123/test.mp4',
      };
      videoRepositoryMock.findOne.mockResolvedValue(mockVideo);

      const confirmDto = {
        uploadId: 'upload-id-123',
        parts: [{ ETag: 'etag-1', PartNumber: 1 }],
      };

      const result = await service.confirmUpload('user-1', 'short-123', confirmDto);

      expect(result.status).toBe(VideoStatus.UPLOADED);
      expect(storageServiceMock.completeMultipartUpload).toHaveBeenCalledWith(
        'raw-videos/short-123/test.mp4',
        'upload-id-123',
        confirmDto.parts,
      );
      expect(queueMock.add).toHaveBeenCalledWith(
        'process-video',
        expect.objectContaining({ videoId: 'uuid-1', videoShortId: 'short-123' }),
        expect.any(Object),
      );
    });

    it('should throw VideoNotOwnedByUserException if user does not own video', async () => {
      const mockVideo = {
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
      const mockVideo = {
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
      const mockVideo = {
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
      const mockVideo = {
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
