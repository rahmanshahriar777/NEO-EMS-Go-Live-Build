import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  StreamableFile,
  Header,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { DocumentsService, DocumentViewer } from './documents.service';
import { DocumentQueryDto, UploadDocumentDto } from './dto/document.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

@ApiTags('Documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  private toViewer(user: JwtPayload): DocumentViewer {
    return { userId: user.sub, employeeId: user.employeeId, roles: user.roles };
  }

  @Get()
  @Permissions('DOCUMENT:READ')
  @ApiOperation({ summary: 'List documents (A5: employeeId filter ignored unless HR/admin)' })
  findAll(@Query() query: DocumentQueryDto, @CurrentUser() user: JwtPayload) {
    return this.service.findAll(this.toViewer(user), query);
  }

  @Get('expiring')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER, SystemRole.EMPLOYEE)
  @Permissions('DOCUMENT:READ')
  @ApiOperation({ summary: 'List documents expiring within N days (scoped)' })
  listExpiring(@CurrentUser() user: JwtPayload, @Query('withinDays') withinDays?: string) {
    const days = Math.min(Math.max(parseInt(withinDays || '30', 10) || 30, 1), 365);
    return this.service.listExpiring(this.toViewer(user), days);
  }

  @Get(':id/download')
  @Permissions('DOCUMENT:READ')
  @ApiOperation({
    summary: 'Download a document (B5: access-checked, decrypted, streamed, audited)',
  })
  @Header('Cache-Control', 'private, no-store')
  async download(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    const { buffer, mimeType, fileName } = await this.service.download(id, this.toViewer(user));
    return new StreamableFile(buffer, {
      type: mimeType,
      disposition: `attachment; filename="${fileName.replace(/["\r\n]/g, '_')}"`,
    });
  }

  @Get(':id')
  @Permissions('DOCUMENT:READ')
  @ApiOperation({ summary: 'Get document metadata (encrypted docs: no presigned URL, use /download)' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findOne(id, this.toViewer(user));
  }

  @Post(':id/acknowledge')
  @ApiOperation({ summary: 'Acknowledge a document (e.g. policy read) for the caller\u2019s employee profile' })
  acknowledge(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.acknowledge(id, this.toViewer(user));
  }

  @Get(':id/acknowledgements')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'List acknowledgements for a document (HR/admin)' })
  getAcknowledgements(@Param('id') id: string) {
    return this.service.getAcknowledgements(id);
  }

  @Post('upload')
  @Permissions('DOCUMENT:CREATE')
  @ApiOperation({
    summary: 'Upload a document (multipart) — content-sniffed, scanned, encrypted, server-keyed',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        title: { type: 'string' },
        category: { type: 'string' },
        employeeId: { type: 'string' },
        expiresAt: { type: 'string', example: '2027-01-15' },
      },
      required: ['file', 'title'],
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        // Go-live hardening (§5 performance): buffer to a temp file, not
        // memory — the service streams from disk to MinIO and removes the
        // temp file after upload (success or failure).
        destination: tmpdir(),
        filename: (_req, _file, cb) => cb(null, `ems-upload-${randomUUID()}`),
      }),
      // The service enforces the real cap; this is a coarse transport guard.
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!file) {
      throw new BadRequestException('A file must be attached as multipart field "file"');
    }
    return this.service.uploadDocument(
      {
        title: dto.title,
        category: dto.category,
        employeeId: dto.employeeId,
        expiresAt: dto.expiresAt,
        file,
      },
      this.toViewer(user),
    );
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER, SystemRole.EMPLOYEE)
  @Permissions('DOCUMENT:DELETE')
  @ApiOperation({ summary: 'Soft-delete a document (owner, uploader, or HR/admin)' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.remove(id, this.toViewer(user));
  }
}
