import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  BadRequestException,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { ReportsService, REPORT_TYPES, REPORT_FORMATS, ReportType, ReportFormat } from './reports.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SystemRole } from '@ems/shared';
import { AdHocReportDto } from './dto/reports.dto';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR)
@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get(':type')
  @ApiOperation({
    summary: 'Generate a report (headcount, turnover, absence, overtime, payroll-cost)',
    description:
      'Formats: csv, xlsx, pdf. Optional from/to (YYYY-MM-DD) and departmentId filters.',
  })
  async getReport(
    @Param('type') type: string,
    @Query('format') format: string = 'csv',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('departmentId') departmentId?: string,
    @Res() res?: Response,
  ) {
    if (!REPORT_TYPES.includes(type as ReportType)) {
      throw new BadRequestException(`Unknown report type: ${type} (expected one of ${REPORT_TYPES.join(', ')})`);
    }
    if (!REPORT_FORMATS.includes(format as ReportFormat)) {
      throw new BadRequestException(`Unknown format: ${format} (expected one of ${REPORT_FORMATS.join(', ')})`);
    }
    const { buffer, filename, contentType } = await this.service.exportReport(
      type as ReportType,
      format as ReportFormat,
      { from, to, departmentId },
    );
    res!.setHeader('Content-Type', contentType);
    res!.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res!.setHeader('Content-Length', String(buffer.length));
    res!.send(buffer);
  }

  @Post('adhoc')
  @ApiOperation({
    summary: 'Build and execute an ad-hoc query report over core entity datasets',
  })
  async buildAdHoc(@Body() dto: AdHocReportDto) {
    return this.service.buildAdHocReport(dto);
  }

  @Get('warehouse/:entity')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.AUDITOR)
  @ApiOperation({
    summary: 'Export structured dataset for external data warehouse / BI integration',
  })
  async warehouseExport(@Param('entity') entity: string) {
    return this.service.exportWarehouseData(
      entity as 'employees' | 'leaves' | 'attendance' | 'payroll' | 'audit',
    );
  }
}
