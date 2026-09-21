import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('WorkerBootstrap');
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();
  logger.log(
    'Video Processing Worker initialized and processing BullMQ queues...',
  );
}

bootstrap().catch((err) => {
  console.error('Worker bootstrap failed:', err);
  process.exit(1);
});
