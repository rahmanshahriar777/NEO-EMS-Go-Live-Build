import {
  Controller,
  Get,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SystemRole } from '@ems/shared';

/**
 * NOTE on PBAC: @Permissions() metadata is deliberately NOT attached (see the
 * note in documents.controller.ts): the seed currently grants zero
 * permissions to any role, so attaching metadata would lock out every
 * non-SUPER_ADMIN user. Attach e.g. @Permissions('AUDIT:VERIFY') once
 * role -> permission grants are seeded.
 */
@ApiTags('Audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'List audit log entries (paginated, newest first)' })
  getLogs(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.audit.getLogs(entityType, entityId, page ?? 1, Math.min(limit ?? 50, 200));
  }

  @Get('verify')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({
    summary: 'Verify the tamper-evident hash chain of the audit log',
    description:
      'Replays every audit row oldest → newest, recomputing hash = ' +
      'sha256(prevHash + canonical(payload)). Batches are cursor-paginated ' +
      '(sequence), not OFFSET. Reports the first broken link, if any.',
  })
  verifyChain(
    @Query('batchSize', new ParseIntPipe({ optional: true })) batchSize?: number,
    @Query('allowTruncation') allowTruncation?: string,
  ) {
    return this.audit.verifyChain(batchSize ?? 500, {
      allowTruncation: allowTruncation === 'true' || allowTruncation === '1',
    });
  }
}
