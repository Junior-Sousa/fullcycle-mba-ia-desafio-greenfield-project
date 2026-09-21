import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService', () => {
  let service: StorageService;

  const mockStorageConfig = {
    endpoint: 'localhost',
    port: 9000,
    useSsl: false,
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    bucket: 'test-bucket',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: storageConfig.KEY,
          useValue: mockStorageConfig,
        },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
