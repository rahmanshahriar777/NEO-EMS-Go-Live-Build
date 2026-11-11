import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtPayload, SystemRole, createSuccessResponse } from '@ems/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CreateDelegationDto,
  CreateDownloadGrantDto,
  CreateFieldReportCommentDto,
  CreateFieldReportDto,
  CreateUploadSessionDto,
  CreateZipDownloadGrantDto,
  DownloadGrantResponseDto,
  FieldReportQueryDto,
  ReviewFieldReportDto,
  UpdateFieldReportDto,
  UpdateFieldReportPolicyDto,
} from './dto/field-report.dto';
import { DownloadGrantGuard } from './guards/download-grant.guard';
import { FieldReportFeatureGuard } from './guards/field-report-feature.guard';
import { DownloadGrantService } from './services/download-grant.service';
import { FieldReportViewer } from './services/field-report-access.service';
import { FieldReportsService } from './services/field-reports.service';
import { UploadSessionService } from './services/upload-session.service';

@ApiTags('Field Reports')
@ApiBearerAuth()
@UseGuards(FieldReportFeatureGuard)
@Controller('field-reports')
export class FieldReportsController {
  constructor(
    private readonly service: FieldReportsService,
    private readonly uploadSessionService: UploadSessionService,
    private readonly downloadGrantService: DownloadGrantService,
    private readonly configService: ConfigService,
  ) {}

  private toViewer(user: JwtPayload): FieldReportViewer {
    return {
      userId: user.sub,
      email: user.email,
      employeeId: user.employeeId,
      roles: user.roles ?? [],
      permissions: user.permissions ?? [],
    };
  }

  private getIp(req: Request): string | undefined {
    return req.ip || req.socket?.remoteAddress;
  }

  @Post()
  @Permissions('FIELD_REPORT:CREATE')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a new draft field report and revision v1' })
  @ApiResponse({ status: 201, description: 'Draft report created' })
  async create(
    @Body() dto: CreateFieldReportDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.create(dto, this.toViewer(user), this.getIp(req)),
    );
  }

  @Get(['mine', 'my'])
  @Permissions('FIELD_REPORT:READ')
  @ApiOperation({ summary: 'List caller’s own field reports' })
  findMine(@Query() query: FieldReportQueryDto, @CurrentUser() user: JwtPayload) {
    return this.service.findMine(query, this.toViewer(user));
  }

  @Get('team')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER)
  @Permissions('FIELD_REPORT:READ', 'FIELD_REPORT:REVIEW')
  @ApiOperation({
    summary: 'List field reports in reviewer queue (direct reports, delegations, or HR)',
  })
  findTeam(@Query() query: FieldReportQueryDto, @CurrentUser() user: JwtPayload) {
    return this.service.findTeam(query, this.toViewer(user));
  }

  @Get('sites')
  @Permissions('FIELD_REPORT:READ')
  @ApiOperation({ summary: 'List available physical sites for field report selection' })
  async listSites() {
    return createSuccessResponse(await this.service.listSites());
  }

  @Get('policies')
  @Permissions('FIELD_REPORT:READ')
  @ApiOperation({ summary: 'Resolve caller download policy (and full org matrix for HR/Admin)' })
  async listPolicies(@CurrentUser() user: JwtPayload) {
    return createSuccessResponse(await this.service.listPolicies(this.toViewer(user)));
  }

  @Put('policies')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @Permissions('FIELD_REPORT:MANAGE')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create or update an org/entity/role field reporting policy' })
  async upsertPolicy(
    @Body() dto: UpdateFieldReportPolicyDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.upsertPolicy(dto, this.toViewer(user), this.getIp(req)),
    );
  }

  @Get('delegations')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER)
  @Permissions('FIELD_REPORT:REVIEW')
  @ApiOperation({ summary: 'List active and historical reviewer delegations' })
  async listDelegations(@CurrentUser() user: JwtPayload) {
    return createSuccessResponse(await this.service.listDelegations(this.toViewer(user)));
  }

  @Post('delegations')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER)
  @Permissions('FIELD_REPORT:REVIEW')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a time-bounded field report review delegation' })
  async createDelegation(
    @Body() dto: CreateDelegationDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.createDelegation(dto, this.toViewer(user), this.getIp(req)),
    );
  }

  @Delete('delegations/:id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER)
  @Permissions('FIELD_REPORT:REVIEW')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Revoke a reviewer delegation immediately' })
  async revokeDelegation(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.revokeDelegation(id, this.toViewer(user), this.getIp(req)),
    );
  }

  @Get('downloads/zip')
  @Public()
  @UseGuards(DownloadGrantGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Stream decrypted bulk ZIP archive via short-lived signed grant' })
  async downloadZip(@Req() req: Request, @Res() res: Response) {
    await this.downloadGrantService.redeemZipDownload((req as any).downloadGrant, req, res);
  }

  @Get('downloads')
  @Public()
  @UseGuards(DownloadGrantGuard)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({ summary: 'Stream decrypted single file with Range support via signed grant' })
  async downloadSingle(
    @Headers('range') range: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.downloadGrantService.redeemSingleDownload(
      (req as any).downloadGrant,
      range,
      req,
      res,
    );
  }

  @Put('upload-sessions/:sessionId/chunks/:index')
  @Permissions('FIELD_REPORT:CREATE')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOperation({ summary: 'Upload an encrypted-at-rest binary chunk (up to 5 MiB)' })
  async uploadChunk(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('index', ParseIntPipe) index: number,
    @Headers('x-chunk-sha256') chunkSha256: string | undefined,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
  ) {
    const maxChunkBytes =
      this.configService.get<number>('fieldReports.chunkSizeBytes', 5_242_880) + 4096;
    const chunkBuf = await this.uploadSessionService.readRawChunkBody(req, maxChunkBytes);
    return createSuccessResponse(
      await this.uploadSessionService.uploadChunk(
        sessionId,
        index,
        chunkBuf,
        this.toViewer(user),
        chunkSha256,
      ),
    );
  }

  @Post('upload-sessions/:sessionId/complete')
  @Permissions('FIELD_REPORT:CREATE')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Assemble, magic-sniff, encrypt, and queue malware scan' })
  async completeUploadSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.uploadSessionService.completeSession(
        sessionId,
        this.toViewer(user),
        this.getIp(req),
      ),
    );
  }

  @Delete('upload-sessions/:sessionId')
  @Permissions('FIELD_REPORT:CREATE')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Abort upload session and clean encrypted staging parts' })
  async abortUploadSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return createSuccessResponse(
      await this.uploadSessionService.abortSession(sessionId, this.toViewer(user)),
    );
  }

  @Post(':id/revisions')
  @Permissions('FIELD_REPORT:CREATE')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Fork a new DRAFT revision from a CHANGES_REQUESTED report' })
  async createNewRevision(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.createNewRevision(id, this.toViewer(user), this.getIp(req)),
    );
  }

  @Patch(':id/revisions/:revId')
  @Permissions('FIELD_REPORT:UPDATE')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Update metadata of an unlocked DRAFT revision' })
  async updateRevision(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revId') revId: string,
    @Body() dto: UpdateFieldReportDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.updateRevision(id, revId, dto, this.toViewer(user), this.getIp(req)),
    );
  }

  @Post(':id/revisions/:revId/submit')
  @Permissions('FIELD_REPORT:CREATE')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Lock DRAFT revision, enforce clean scan gate, and submit for review' })
  async submitRevision(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revId') revId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.submitRevision(id, revId, this.toViewer(user), this.getIp(req)),
    );
  }

  @Post(':id/revisions/:revId/review')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER)
  @Permissions('FIELD_REPORT:REVIEW')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Approve, reject, or request changes on a SUBMITTED revision' })
  async reviewRevision(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revId') revId: string,
    @Body() dto: ReviewFieldReportDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.reviewRevision(id, revId, dto, this.toViewer(user), this.getIp(req)),
    );
  }

  @Post(':id/revisions/:revId/upload-sessions')
  @Permissions('FIELD_REPORT:CREATE')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open or resume a chunked upload session for a DRAFT revision' })
  async createUploadSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revId') revId: string,
    @Body() dto: CreateUploadSessionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return createSuccessResponse(
      await this.uploadSessionService.createSession(id, revId, dto, this.toViewer(user)),
    );
  }

  @Delete(':id/revisions/:revId/attachments/:attId')
  @Permissions('FIELD_REPORT:CREATE')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Detach an attachment from an unlocked DRAFT revision' })
  async removeAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revId') revId: string,
    @Param('attId', ParseUUIDPipe) attId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.uploadSessionService.removeAttachmentFromRevision(
        id,
        revId,
        attId,
        this.toViewer(user),
        this.getIp(req),
      ),
    );
  }

  @Post(':id/comments')
  @Permissions('FIELD_REPORT:READ')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Add a review/discussion comment to an accessible field report' })
  async addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFieldReportCommentDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.addComment(id, dto, this.toViewer(user), this.getIp(req)),
    );
  }

  @Post(':id/attachments/:attId/download-grant')
  @Permissions('FIELD_REPORT:READ')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiResponse({ status: 200, type: DownloadGrantResponseDto })
  @ApiOperation({
    summary: 'Mint a 300s signed download grant for ORIGINAL, RESIZED, PREVIEW, or THUMBNAIL',
  })
  async mintDownloadGrant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attId', ParseUUIDPipe) attId: string,
    @Body() dto: CreateDownloadGrantDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return createSuccessResponse(
      await this.downloadGrantService.mintSingleGrant(id, attId, dto, this.toViewer(user)),
    );
  }

  @Post(':id/download-zip-grant')
  @Permissions('FIELD_REPORT:READ')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiResponse({ status: 200, type: DownloadGrantResponseDto })
  @ApiOperation({ summary: 'Mint a 300s signed download grant for streamed bulk ZIP' })
  async mintZipDownloadGrant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateZipDownloadGrantDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return createSuccessResponse(
      await this.downloadGrantService.mintZipGrant(id, dto, this.toViewer(user)),
    );
  }

  @Get(':id')
  @Permissions('FIELD_REPORT:READ')
  @ApiOperation({ summary: 'Get full field report detail including revisions, media, and policy' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return createSuccessResponse(await this.service.findOne(id, this.toViewer(user)));
  }

  @Delete(':id')
  @Permissions('FIELD_REPORT:DELETE')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Soft-delete a draft report (owner) or non-legal-hold report (HR)' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return createSuccessResponse(
      await this.service.softDelete(id, this.toViewer(user), this.getIp(req)),
    );
  }
}

