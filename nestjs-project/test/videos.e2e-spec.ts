/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { StorageService } from '../src/storage/storage.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;

  const storageServiceMock = {
    createMultipartUpload: jest.fn().mockResolvedValue('test-upload-id-123'),
    getPresignedPartUrl: jest
      .fn()
      .mockImplementation((key, uploadId, partNumber) =>
        Promise.resolve(
          `http://minio:9000/streamtube-videos/${key}?partNumber=${partNumber}&uploadId=${uploadId}`,
        ),
      ),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getPresignedStreamUrl: jest
      .fn()
      .mockResolvedValue('http://minio:9000/streamtube-videos/stream-url'),
    getPresignedDownloadUrl: jest
      .fn()
      .mockResolvedValue('http://minio:9000/streamtube-videos/download-url'),
  };

  const queueMock = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StorageService)
      .useValue(storageServiceMock)
      .overrideProvider('BullQueue_video-processing')
      .useValue(queueMock)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    try {
      await dataSource.query('DELETE FROM "videos"');
    } catch {
      // Table might be clean
    }
    await cleanAllTables(dataSource);
    jest.clearAllMocks();
  });

  async function registerAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ token: string; userId: string }> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return {
      token: loginRes.body.access_token,
      userId: regRes.body.id,
    };
  }

  describe('POST /videos/upload/initiate', () => {
    it('returns 401 when request is not authenticated', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .send({
          title: 'Aula 01',
          fileName: 'video.mp4',
          mimeType: 'video/mp4',
          fileSize: 10485760,
        })
        .expect(401);
    });

    it('returns 400 VALIDATION_ERROR on invalid body', async () => {
      const { token } = await registerAndLogin('user_val@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: '',
          fileName: 'video.mp4',
        })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 201 with presigned part URLs on valid request', async () => {
      const { token } = await registerAndLogin('creator@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Meu Primeiro Vídeo',
          description: 'Vídeo explicativo',
          fileName: 'aula01.mp4',
          mimeType: 'video/mp4',
          fileSize: 10485760, // 10MB -> 2 parts of 5MB
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.videoId).toHaveLength(10);
      expect(res.body.uploadId).toBe('test-upload-id-123');
      expect(res.body.parts).toHaveLength(2);
      expect(res.body.parts[0].partNumber).toBe(1);

      const dbVideo = await videoRepository.findOneBy({ id: res.body.id });
      expect(dbVideo).toBeDefined();
      expect(dbVideo?.status).toBe(VideoStatus.DRAFT);
    });
  });

  describe('POST /videos/:videoId/upload/confirm', () => {
    it('returns 401 when not authenticated', async () => {
      await request(app.getHttpServer())
        .post('/videos/some-id/upload/confirm')
        .send({
          uploadId: 'upload-123',
          parts: [{ PartNumber: 1, ETag: 'etag1' }],
        })
        .expect(401);
    });

    it('returns 404 when video does not exist', async () => {
      const { token } = await registerAndLogin('user_404@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/non-existent-id/upload/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({
          uploadId: 'upload-123',
          parts: [{ PartNumber: 1, ETag: 'etag1' }],
        })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 403 when user is not the video owner', async () => {
      const owner = await registerAndLogin('owner@example.com');
      const otherUser = await registerAndLogin('other@example.com');

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          title: 'Vídeo do Dono',
          fileName: 'video.mp4',
          mimeType: 'video/mp4',
          fileSize: 5242880,
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/videos/${initRes.body.videoId}/upload/confirm`)
        .set('Authorization', `Bearer ${otherUser.token}`)
        .send({
          uploadId: 'test-upload-id-123',
          parts: [{ PartNumber: 1, ETag: 'etag1' }],
        })
        .expect(403);

      expect(res.body.error).toBe('VIDEO_NOT_OWNED_BY_USER');
    });

    it('returns 200 and transitions status to UPLOADED and queues BullMQ job', async () => {
      const { token } = await registerAndLogin('uploader@example.com');

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Vídeo Confirmado',
          fileName: 'confirm.mp4',
          mimeType: 'video/mp4',
          fileSize: 5242880,
        })
        .expect(201);

      const confirmRes = await request(app.getHttpServer())
        .post(`/videos/${initRes.body.videoId}/upload/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          uploadId: 'test-upload-id-123',
          parts: [{ PartNumber: 1, ETag: 'etag1' }],
        })
        .expect(200);

      expect(confirmRes.body.status).toBe(VideoStatus.UPLOADED);
      expect(queueMock.add).toHaveBeenCalledWith(
        'process-video',
        expect.objectContaining({
          videoId: initRes.body.id,
          videoShortId: initRes.body.videoId,
        }),
        expect.any(Object),
      );

      const dbVideo = await videoRepository.findOneBy({ id: initRes.body.id });
      expect(dbVideo?.status).toBe(VideoStatus.UPLOADED);
    });

    it('returns 400 INVALID_VIDEO_STATE when video is not in DRAFT status', async () => {
      const { token } = await registerAndLogin('draft_check@example.com');

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Vídeo Dupla Confirmação',
          fileName: 'video.mp4',
          mimeType: 'video/mp4',
          fileSize: 5242880,
        })
        .expect(201);

      // First confirmation succeeds
      await request(app.getHttpServer())
        .post(`/videos/${initRes.body.videoId}/upload/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          uploadId: 'test-upload-id-123',
          parts: [{ PartNumber: 1, ETag: 'etag1' }],
        })
        .expect(200);

      // Second confirmation fails with INVALID_VIDEO_STATE
      const res = await request(app.getHttpServer())
        .post(`/videos/${initRes.body.videoId}/upload/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          uploadId: 'test-upload-id-123',
          parts: [{ PartNumber: 1, ETag: 'etag1' }],
        })
        .expect(400);

      expect(res.body.error).toBe('INVALID_VIDEO_STATE');
    });
  });

  describe('GET /videos/:videoId', () => {
    it('returns 404 when video is not found', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/non-existent-video-id')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns video metadata (public endpoint)', async () => {
      const { token } = await registerAndLogin('public_get@example.com');

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Vídeo Público',
          description: 'Descrição pública',
          fileName: 'public.mp4',
          mimeType: 'video/mp4',
          fileSize: 5242880,
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/videos/${initRes.body.videoId}`)
        .expect(200);

      expect(res.body.id).toBe(initRes.body.id);
      expect(res.body.title).toBe('Vídeo Público');
      expect(res.body.status).toBe(VideoStatus.DRAFT);
      expect(res.body.streamUrl).toBeNull();
    });
  });

  describe('GET /videos/:videoId/stream', () => {
    it('returns 400 INVALID_VIDEO_STATE when video is not READY', async () => {
      const { token } = await registerAndLogin('stream_not_ready@example.com');

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Vídeo Not Ready',
          fileName: 'not_ready.mp4',
          mimeType: 'video/mp4',
          fileSize: 5242880,
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/videos/${initRes.body.videoId}/stream`)
        .expect(400);

      expect(res.body.error).toBe('INVALID_VIDEO_STATE');
    });

    it('redirects (302) to presigned stream URL when video is READY', async () => {
      const { userId } = await registerAndLogin('stream_ready@example.com');

      const video = videoRepository.create({
        videoId: 'ready123456',
        title: 'Vídeo Pronto',
        status: VideoStatus.READY,
        s3Key: 'raw-videos/ready123456/ready.mp4',
        duration: 120,
        userId,
      });
      await videoRepository.save(video);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.videoId}/stream`)
        .expect(302);

      expect(res.header.location).toBe(
        'http://minio:9000/streamtube-videos/stream-url',
      );
    });
  });

  describe('GET /videos/:videoId/download', () => {
    it('returns 400 INVALID_VIDEO_STATE when video is not READY', async () => {
      const { token } = await registerAndLogin(
        'download_not_ready@example.com',
      );

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Vídeo Not Ready Download',
          fileName: 'download.mp4',
          mimeType: 'video/mp4',
          fileSize: 5242880,
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/videos/${initRes.body.videoId}/download`)
        .expect(400);

      expect(res.body.error).toBe('INVALID_VIDEO_STATE');
    });

    it('redirects (302) to presigned download URL when video is READY', async () => {
      const { userId } = await registerAndLogin('download_ready@example.com');

      const video = videoRepository.create({
        videoId: 'dlready1234',
        title: 'Vídeo Pronto Download',
        status: VideoStatus.READY,
        s3Key: 'raw-videos/dlready1234/ready.mp4',
        originalFileName: 'ready.mp4',
        duration: 120,
        userId,
      });
      await videoRepository.save(video);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.videoId}/download`)
        .expect(302);

      expect(res.header.location).toBe(
        'http://minio:9000/streamtube-videos/download-url',
      );
    });
  });
});
