import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { WorkerAppModule } from './worker-app.module';

jest.mock('@ffprobe-installer/ffprobe', () => ({ path: '/mock/ffprobe' }));
jest.mock('ffmpeg-static', () => '/mock/ffmpeg');

describe('WorkerAppModule bootstrap', () => {
  it('should bootstrap WorkerAppModule and load all related entity metadata successfully', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [WorkerAppModule],
    }).compile();

    const app = module.createNestApplication();
    await app.init();

    const dataSource = app.get(DataSource);
    expect(dataSource.isInitialized).toBe(true);
    expect(dataSource.hasMetadata('Video')).toBe(true);
    expect(dataSource.hasMetadata('User')).toBe(true);
    expect(dataSource.hasMetadata('Channel')).toBe(true);

    await app.close();
  });
});
