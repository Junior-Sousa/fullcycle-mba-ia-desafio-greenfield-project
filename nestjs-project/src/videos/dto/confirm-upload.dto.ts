import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  ValidateNested,
} from 'class-validator';

export class PartETagDto {
  @ApiProperty({
    description: 'ETag retornado pelo S3/MinIO no upload da parte',
  })
  @IsString()
  @IsNotEmpty()
  ETag: string;

  @ApiProperty({ description: 'Número da parte (1-based)' })
  @IsInt()
  PartNumber: number;
}

export class ConfirmUploadDto {
  @ApiProperty({ description: 'ID da sessão de Multipart Upload no S3/MinIO' })
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @ApiProperty({
    description: 'Lista de ETags e números de partes enviadas',
    type: [PartETagDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PartETagDto)
  parts: PartETagDto[];
}
