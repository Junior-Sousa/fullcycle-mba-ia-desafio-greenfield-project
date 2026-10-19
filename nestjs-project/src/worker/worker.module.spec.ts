import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkerModule } from './worker.module';
import { WorkerAppModule } from './worker-app.module';
import { Video } from '../videos/entities/video.entity';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { createTestDataSource } from '../test/create-test-data-source';

jest.mock('@ffprobe-installer/ffprobe', () => ({ path: '/mock/ffprobe' }));
jest.mock('ffmpeg-static', () => '/mock/ffmpeg');

describe('Worker modules', () => {
  it('WorkerModule and WorkerAppModule should be defined', () => {
    expect(WorkerModule).toBeDefined();
    expect(WorkerAppModule).toBeDefined();
  });

  it('WorkerModule should compile with TypeOrmModule resolving Video, User and Channel entities', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(
          createTestDataSource([Video, User, Channel]).options,
        ),
        WorkerModule,
      ],
    })
      .overrideProvider(StorageService)
      .useValue({
        getObjectStream: jest.fn(),
        uploadBuffer: jest.fn(),
      })
      .overrideProvider('BullQueue_video-processing')
      .useValue({
        add: jest.fn(),
      })
      .compile();

    expect(module).toBeDefined();

    const videoRepo = module.get<Repository<Video>>(getRepositoryToken(Video));
    const userRepo = module.get<Repository<User>>(getRepositoryToken(User));
    const channelRepo = module.get<Repository<Channel>>(
      getRepositoryToken(Channel),
    );

    expect(videoRepo).toBeDefined();
    expect(userRepo).toBeDefined();
    expect(channelRepo).toBeDefined();

    await module.close();
  });
});
