import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(storageConfig)],
      providers: [StorageService],
    }).compile();

    service = module.get<StorageService>(StorageService);
    await service.onModuleInit();
  });

  it('ensures bucket exists and uploads/downloads a buffer', async () => {
    const key = `test-${Date.now()}.txt`;
    const content = Buffer.from('Hello StreamTube Integration Test');
    await service.uploadBuffer(key, content, 'text/plain');

    const stream = await service.getObjectStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
      );
    }
    const downloaded = Buffer.concat(chunks).toString('utf-8');
    expect(downloaded).toBe('Hello StreamTube Integration Test');
  });

  it('generates valid presigned stream and download URLs', async () => {
    const streamUrl = await service.getPresignedStreamUrl('test-video.mp4');
    expect(streamUrl).toContain('test-video.mp4');
    expect(streamUrl).toContain('X-Amz-Signature');

    const downloadUrl = await service.getPresignedDownloadUrl(
      'test-video.mp4',
      'my-video.mp4',
    );
    expect(downloadUrl).toContain('test-video.mp4');
    expect(downloadUrl).toContain('response-content-disposition');
  });
});
