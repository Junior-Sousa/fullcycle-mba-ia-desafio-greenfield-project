/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import {
  ProcessVideoJobData,
  VideoProcessingProcessor,
} from './video-processing.processor';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import { Readable } from 'stream';

jest.mock('@ffprobe-installer/ffprobe', () => ({ path: '/mock/ffprobe' }));
jest.mock('ffmpeg-static', () => '/mock/ffmpeg');

type PrivateProcessor = {
  saveStreamToFile(stream: Readable, filePath: string): Promise<void>;
  extractMetadata(filePath: string): Promise<ffmpeg.FfprobeData>;
  extractThumbnail(
    videoPath: string,
    thumbPath: string,
    seekSeconds: number,
  ): Promise<void>;
};

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let videoRepositoryMock: {
    findOneBy: jest.Mock;
    save: jest.Mock;
  };
  let storageServiceMock: {
    getObjectStream: jest.Mock;
    uploadBuffer: jest.Mock;
  };

  beforeEach(async () => {
    videoRepositoryMock = {
      findOneBy: jest.fn(),
      save: jest
        .fn()
        .mockImplementation((video: Partial<Video>) =>
          Promise.resolve({ ...video }),
        ),
    };

    storageServiceMock = {
      getObjectStream: jest
        .fn()
        .mockResolvedValue(Readable.from(['fake video bytes'])),
      uploadBuffer: jest.fn().mockResolvedValue('thumbnails/short-123.jpg'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepositoryMock as unknown as Repository<Video>,
        },
        {
          provide: StorageService,
          useValue: storageServiceMock as unknown as StorageService,
        },
      ],
    }).compile();

    processor = module.get<VideoProcessingProcessor>(VideoProcessingProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  it('should return early if video is not found', async () => {
    videoRepositoryMock.findOneBy.mockResolvedValue(null);

    const job = {
      id: 'job-1',
      data: { videoId: 'uuid-1', videoShortId: 'short-123', s3Key: 'key' },
      opts: { attempts: 3 },
      attemptsMade: 1,
    } as unknown as Job<ProcessVideoJobData>;

    await processor.process(job);

    expect(storageServiceMock.getObjectStream).not.toHaveBeenCalled();
  });

  it('should process video successfully, update status to READY and persist metadata/thumbnail', async () => {
    const video: Partial<Video> = {
      id: 'uuid-1',
      videoId: 'short-123',
      status: VideoStatus.UPLOADED,
    };
    videoRepositoryMock.findOneBy.mockResolvedValue(video);

    const privateProcessor = processor as unknown as PrivateProcessor;

    jest
      .spyOn(privateProcessor, 'saveStreamToFile')
      .mockResolvedValue(undefined);

    const mockProbeData: ffmpeg.FfprobeData = {
      format: {
        duration: 125.5,
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        bit_rate: 2500000,
      } as unknown as ffmpeg.FfprobeFormat,
      streams: [
        {
          codec_type: 'video',
          width: 1920,
          height: 1080,
          codec_name: 'h264',
          r_frame_rate: '30/1',
        } as unknown as ffmpeg.FfprobeStream,
        {
          codec_type: 'audio',
          codec_name: 'aac',
        } as unknown as ffmpeg.FfprobeStream,
      ],
      chapters: [],
    };

    jest
      .spyOn(privateProcessor, 'extractMetadata')
      .mockResolvedValue(mockProbeData);

    jest
      .spyOn(privateProcessor, 'extractThumbnail')
      .mockImplementation((_videoPath: string, thumbPath: string) => {
        fs.writeFileSync(thumbPath, Buffer.from('fake-thumbnail-image'));
        return Promise.resolve();
      });

    const job = {
      id: 'job-1',
      data: {
        videoId: 'uuid-1',
        videoShortId: 'short-123',
        s3Key: 'raw-videos/short-123/video.mp4',
      },
      opts: { attempts: 3 },
      attemptsMade: 1,
    } as unknown as Job<ProcessVideoJobData>;

    await processor.process(job);

    expect(storageServiceMock.uploadBuffer).toHaveBeenCalledWith(
      'thumbnails/short-123.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );

    expect(videoRepositoryMock.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.READY,
        duration: 125.5,
        thumbnailKey: 'thumbnails/short-123.jpg',
        metadata: expect.objectContaining({
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          audioCodec: 'aac',
        }),
      }),
    );
  });

  it('should transition video to ERROR and save processingError on final attempt failure', async () => {
    const video: Partial<Video> = {
      id: 'uuid-1',
      videoId: 'short-123',
      status: VideoStatus.UPLOADED,
    };
    videoRepositoryMock.findOneBy.mockResolvedValue(video);

    const privateProcessor = processor as unknown as PrivateProcessor;

    jest
      .spyOn(privateProcessor, 'saveStreamToFile')
      .mockRejectedValue(new Error('Corrupt stream received'));

    const job = {
      id: 'job-1',
      data: {
        videoId: 'uuid-1',
        videoShortId: 'short-123',
        s3Key: 'raw-videos/short-123/video.mp4',
      },
      opts: { attempts: 3 },
      attemptsMade: 3, // Final attempt reached
    } as unknown as Job<ProcessVideoJobData>;

    await expect(processor.process(job)).rejects.toThrow(
      'Corrupt stream received',
    );

    expect(videoRepositoryMock.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.ERROR,
        processingError: 'Corrupt stream received',
      }),
    );
  });

  it('should rethrow error without setting ERROR status if attemptsMade < attempts', async () => {
    const video: Partial<Video> = {
      id: 'uuid-1',
      videoId: 'short-123',
      status: VideoStatus.UPLOADED,
    };
    videoRepositoryMock.findOneBy.mockResolvedValue(video);

    const privateProcessor = processor as unknown as PrivateProcessor;

    jest
      .spyOn(privateProcessor, 'saveStreamToFile')
      .mockRejectedValue(new Error('Network glitch'));

    const job = {
      id: 'job-1',
      data: {
        videoId: 'uuid-1',
        videoShortId: 'short-123',
        s3Key: 'raw-videos/short-123/video.mp4',
      },
      opts: { attempts: 3 },
      attemptsMade: 1, // First attempt
    } as unknown as Job<ProcessVideoJobData>;

    await expect(processor.process(job)).rejects.toThrow('Network glitch');

    expect(videoRepositoryMock.save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.ERROR,
      }),
    );
  });

  describe('helper methods', () => {
    it('should save stream to file', async () => {
      const stream = Readable.from(['chunk1', 'chunk2']);
      const tmpPath = path.join(os.tmpdir(), `test-save-${Date.now()}.txt`);
      const privateProcessor = processor as unknown as PrivateProcessor;

      await privateProcessor.saveStreamToFile(stream, tmpPath);

      expect(fs.existsSync(tmpPath)).toBe(true);
      const content = fs.readFileSync(tmpPath, 'utf8');
      expect(content).toBe('chunk1chunk2');
      fs.unlinkSync(tmpPath);
    });

    it('should reject saveStreamToFile on writer error', async () => {
      const stream = Readable.from(['chunk']);
      // Writing to an invalid path or directory that does not exist triggers writer 'error' event
      const invalidPath = path.join(
        os.tmpdir(),
        'non-existent-subfolder-xyz',
        'file.txt',
      );
      const privateProcessor = processor as unknown as PrivateProcessor;

      await expect(
        privateProcessor.saveStreamToFile(stream, invalidPath),
      ).rejects.toThrow();
    });

    it('should call ffprobe in extractMetadata and resolve probe data', async () => {
      const mockData = {
        format: { duration: 10 },
        streams: [],
      } as unknown as ffmpeg.FfprobeData;
      const spy = jest
        .spyOn(ffmpeg, 'ffprobe')
        .mockImplementation((_filePath: string, cb: unknown) => {
          (cb as (err: Error | null, data: ffmpeg.FfprobeData) => void)(
            null,
            mockData,
          );
        });

      const privateProcessor = processor as unknown as PrivateProcessor;
      const result = await privateProcessor.extractMetadata('fake-file.mp4');
      expect(result).toEqual(mockData);
      spy.mockRestore();
    });

    it('should call ffprobe in extractMetadata and reject on error', async () => {
      const spy = jest
        .spyOn(ffmpeg, 'ffprobe')
        .mockImplementation((_filePath: string, cb: unknown) => {
          (cb as (err: Error | null, data: ffmpeg.FfprobeData | null) => void)(
            new Error('ffprobe error'),
            null,
          );
        });

      const privateProcessor = processor as unknown as PrivateProcessor;
      await expect(
        privateProcessor.extractMetadata('fake-file.mp4'),
      ).rejects.toThrow('ffprobe error');
      spy.mockRestore();
    });
  });
});
