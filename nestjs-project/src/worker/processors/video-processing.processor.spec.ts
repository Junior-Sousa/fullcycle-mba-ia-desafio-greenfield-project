import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import {
  ProcessVideoJobData,
  VideoProcessingProcessor,
} from './video-processing.processor';
import { Video } from '../../videos/entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import { Readable } from 'stream';

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
});
