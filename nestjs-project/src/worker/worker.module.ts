import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Video } from '../videos/entities/video.entity';
import { StorageModule } from '../storage/storage.module';
import { VideoProcessingProcessor } from './processors/video-processing.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    BullModule.registerQueue({
      name: 'video-processing',
    }),
  ],
  providers: [VideoProcessingProcessor],
})
export class WorkerModule {}
