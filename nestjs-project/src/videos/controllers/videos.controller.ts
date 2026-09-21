import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import type { JwtPayload } from '../../auth/auth.types';
import { VideosService } from '../services/videos.service';
import { InitiateUploadDto } from '../dto/initiate-upload.dto';
import { ConfirmUploadDto } from '../dto/confirm-upload.dto';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @ApiBearerAuth()
  @Post('upload/initiate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Iniciar upload multipart de vídeo',
    description:
      'Pré-cadastra o vídeo em status DRAFT e retorna URLs pré-assinadas para envio direto em partes ao storage (MinIO/S3).',
  })
  @ApiResponse({
    status: 210,
    description: 'Upload multipart iniciado com sucesso',
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ) {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @ApiBearerAuth()
  @Post(':videoId/upload/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirmar conclusão de upload multipart',
    description:
      'Conclui a montagem do arquivo no S3/MinIO, atualiza status para UPLOADED e dispara processamento em segundo plano.',
  })
  async confirmUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.videosService.confirmUpload(user.sub, videoId, dto);
  }

  @Public()
  @Get(':videoId')
  @ApiOperation({
    summary: 'Obter metadados e URLs de vídeo por ID ou NanoID',
  })
  async getVideo(@Param('videoId') videoId: string) {
    return this.videosService.getVideo(videoId);
  }

  @Public()
  @Get(':videoId/stream')
  @ApiOperation({
    summary:
      'Reproduzir/Streamar vídeo por redirecionamento direto para o storage',
  })
  async getStreamUrl(@Param('videoId') videoId: string, @Res() res: Response) {
    const url = await this.videosService.getStreamUrl(videoId);
    return res.redirect(HttpStatus.FOUND, url);
  }

  @Public()
  @Get(':videoId/download')
  @ApiOperation({
    summary:
      'Download direto do vídeo via redirecionamento com Content-Disposition',
  })
  async getDownloadUrl(
    @Param('videoId') videoId: string,
    @Res() res: Response,
  ) {
    const url = await this.videosService.getDownloadUrl(videoId);
    return res.redirect(HttpStatus.FOUND, url);
  }
}
