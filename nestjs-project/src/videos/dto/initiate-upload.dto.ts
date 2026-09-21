import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class InitiateUploadDto {
  @ApiProperty({
    description: 'Título do vídeo',
    example: 'Meu Primeiro Vídeo',
  })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({
    description: 'Descrição do vídeo',
    example: 'Descrição detalhada sobre o vídeo...',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Nome original do arquivo',
    example: 'video_aula.mp4',
  })
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @ApiProperty({
    description: 'Tipo MIME do vídeo',
    example: 'video/mp4',
  })
  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @ApiProperty({
    description: 'Tamanho total do arquivo em bytes',
    example: 10485760,
  })
  @IsInt()
  @Min(1)
  fileSize: number;
}
