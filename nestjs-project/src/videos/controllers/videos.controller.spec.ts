import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { VideosController } from './videos.controller';
import { VideosService } from '../services/videos.service';
import { VideoStatus } from '../entities/video.entity';
import type { JwtPayload } from '../../auth/auth.types';

describe('VideosController', () => {
  let controller: VideosController;
  let videosServiceMock: {
    initiateUpload: jest.Mock;
    confirmUpload: jest.Mock;
    getVideo: jest.Mock;
    getStreamUrl: jest.Mock;
    getDownloadUrl: jest.Mock;
  };

  const mockUser: JwtPayload = {
    sub: 'user-uuid-1',
    email: 'user@example.com',
  };

  beforeEach(async () => {
    videosServiceMock = {
      initiateUpload: jest.fn(),
      confirmUpload: jest.fn(),
      getVideo: jest.fn(),
      getStreamUrl: jest.fn(),
      getDownloadUrl: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VideosController],
      providers: [
        {
          provide: VideosService,
          useValue: videosServiceMock,
        },
      ],
    }).compile();

    controller = module.get<VideosController>(VideosController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('initiateUpload', () => {
    it('should delegate to videosService.initiateUpload with userId and dto', async () => {
      const dto = {
        title: 'Video Title',
        fileName: 'video.mp4',
        mimeType: 'video/mp4',
        fileSize: 1048576,
      };
      const expectedResult = {
        id: 'uuid-1',
        videoId: 'short-123',
        uploadId: 'up-123',
        parts: [],
      };
      videosServiceMock.initiateUpload.mockResolvedValue(expectedResult);

      const result = await controller.initiateUpload(mockUser, dto);

      expect(result).toBe(expectedResult);
      expect(videosServiceMock.initiateUpload).toHaveBeenCalledWith(
        'user-uuid-1',
        dto,
      );
    });
  });

  describe('confirmUpload', () => {
    it('should delegate to videosService.confirmUpload with userId, videoId and dto', async () => {
      const dto = {
        uploadId: 'up-123',
        parts: [{ ETag: 'etag-1', PartNumber: 1 }],
      };
      const expectedResult = {
        id: 'uuid-1',
        status: VideoStatus.UPLOADED,
      };
      videosServiceMock.confirmUpload.mockResolvedValue(expectedResult);

      const result = await controller.confirmUpload(mockUser, 'short-123', dto);

      expect(result).toBe(expectedResult);
      expect(videosServiceMock.confirmUpload).toHaveBeenCalledWith(
        'user-uuid-1',
        'short-123',
        dto,
      );
    });
  });

  describe('getVideo', () => {
    it('should delegate to videosService.getVideo', async () => {
      const expectedResult = {
        id: 'uuid-1',
        title: 'Title',
        status: VideoStatus.READY,
      };
      videosServiceMock.getVideo.mockResolvedValue(expectedResult);

      const result = await controller.getVideo('short-123');

      expect(result).toBe(expectedResult);
      expect(videosServiceMock.getVideo).toHaveBeenCalledWith('short-123');
    });
  });

  describe('getStreamUrl', () => {
    it('should redirect (302) to presigned stream URL', async () => {
      videosServiceMock.getStreamUrl.mockResolvedValue('http://minio/stream');
      const redirectMock = jest.fn();
      const res = { redirect: redirectMock } as unknown as Response;

      await controller.getStreamUrl('short-123', res);

      expect(videosServiceMock.getStreamUrl).toHaveBeenCalledWith('short-123');
      expect(redirectMock).toHaveBeenCalledWith(
        HttpStatus.FOUND,
        'http://minio/stream',
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('should redirect (302) to presigned download URL', async () => {
      videosServiceMock.getDownloadUrl.mockResolvedValue(
        'http://minio/download',
      );
      const redirectMock = jest.fn();
      const res = { redirect: redirectMock } as unknown as Response;

      await controller.getDownloadUrl('short-123', res);

      expect(videosServiceMock.getDownloadUrl).toHaveBeenCalledWith(
        'short-123',
      );
      expect(redirectMock).toHaveBeenCalledWith(
        HttpStatus.FOUND,
        'http://minio/download',
      );
    });
  });
});
