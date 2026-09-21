import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideosTable1780000000000 implements MigrationInterface {
  name = 'CreateVideosTable1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('DRAFT', 'UPLOADED', 'PROCESSING', 'READY', 'ERROR')`,
    );

    await queryRunner.query(
      `CREATE TABLE "videos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "videoId" character varying(21) NOT NULL,
        "title" character varying(255) NOT NULL,
        "description" text,
        "status" "public"."videos_status_enum" NOT NULL DEFAULT 'DRAFT',
        "originalFileName" character varying(255),
        "mimeType" character varying(100),
        "fileSize" bigint,
        "s3Key" character varying(500),
        "thumbnailKey" character varying(500),
        "duration" double precision,
        "processingError" text,
        "userId" uuid NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_videoId" UNIQUE ("videoId"),
        CONSTRAINT "PK_videos_id" PRIMARY KEY ("id")
      )`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_videos_videoId" ON "videos" ("videoId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_videos_userId"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_videoId"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
