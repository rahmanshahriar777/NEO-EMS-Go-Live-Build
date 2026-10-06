import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Param,
  Body,
  Query,
  Res,
  UseGuards,
  ForbiddenException,
  ParseIntPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PayrollService } from './payroll.service';
import {
  CreateSalaryStructureDto,
  AssignSalaryDto,
  CreatePayrollRunDto,
  CreatePayslipCorrectionDto,
} from './dto/payroll.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

@ApiTags('Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payroll')
export class PayrollController {
  constructor(private readonly service: PayrollService) {}

  @Get('salary-structures')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'List all salary structures' })
  getSalaryStructures(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.service.getSalaryStructures(page ?? 1, Math.min(limit ?? 20, 100));
  }

  @Post('salary-structures')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create a new salary structure with component breakdown' })
  createSalaryStructure(@Body() dto: CreateSalaryStructureDto, @CurrentUser() user: JwtPayload) {
    return this.service.createSalaryStructure(dto, user.sub, user.email);
  }

  @Get('employees/:employeeId/salary')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Get active salary structure assignment for an employee' })
  getEmployeeSalary(@Param('employeeId') employeeId: string) {
    return this.service.getEmployeeSalary(employeeId);
  }

  @Put('employees/:employeeId/salary')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Assign or update employee salary structure' })
  assignSalary(
    @Param('employeeId') employeeId: string,
    @Body() dto: Omit<AssignSalaryDto, 'employeeId'>,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.assignSalary(
      { ...dto, employeeId },
      user.sub,
      user.email,
    );
  }

  @Post('runs')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Generate a new monthly payroll run' })
  createPayrollRun(@Body() dto: CreatePayrollRunDto, @CurrentUser() user: JwtPayload) {
    return this.service.createPayrollRun(dto, user.sub, user.email);
  }

  @Get('runs')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'List past and current payroll runs' })
  getPayrollRuns(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.service.getPayrollRuns(page ?? 1, Math.min(limit ?? 20, 100));
  }

  @Get('runs/:id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'Get detailed payroll run including summary and line items' })
  getPayrollRunById(@Param('id') id: string) {
    return this.service.getPayrollRunById(id);
  }

  @Patch('runs/:id/approve')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({
    summary: 'Approve payroll run (maker/checker: approver must differ from creator)',
  })
  approvePayrollRun(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.approvePayrollRun(id, user.sub, user.email);
  }

  @Post('runs/:id/disburse')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({
    summary: 'Disburse an approved payroll run (APPROVED → PAID; idempotent)',
    description:
      'Moves the run APPROVED → PAID in a transaction and stamps disbursementDate ' +
      'on every payslip. Re-disbursing a PAID run is a no-op; any other status returns 409.',
  })
  disbursePayrollRun(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.disbursePayrollRun(id, user.sub, user.email);
  }

  @Post('runs/:id/cancel')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({
    summary: 'Cancel a DRAFT payroll run',
    description:
      'Only DRAFT runs can be cancelled. Draft payslips are retained as an ' +
      'audit trail; no money has moved at this stage.',
  })
  cancelPayrollRun(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.cancelPayrollRun(id, user.sub, user.email);
  }

  @Post('runs/:id/recalculate')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({
    summary: 'Recalculate a DRAFT payroll run',
    description:
      'Drops the stored draft payslips and re-enqueues computation in the ' +
      'worker (single-compute rule). Only DRAFT runs; not while PROCESSING.',
  })
  recalculatePayrollRun(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.recalculatePayrollRun(id, user.sub, user.email);
  }

  @Get('runs/:id/bank-csv')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Export bank payment file (CSV) for a payroll run' })
  async getBankPaymentCsv(@Param('id') id: string, @Res() res: Response) {
    const { csv, filename } = await this.service.getBankPaymentCsv(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  @Get('payslips')
  @ApiOperation({ summary: 'List payslips (personal for employees, all for HR/Finance)' })
  getPayslips(
    @CurrentUser() user: JwtPayload,
    @Query('employeeId') employeeId?: string,
    @Query('payrollRunId') payrollRunId?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    const isHrOrAdmin = user.roles.includes(SystemRole.SUPER_ADMIN) || user.roles.includes(SystemRole.HR_ADMIN);

    // If regular employee, strictly enforce self access
    const targetEmployeeId = isHrOrAdmin ? employeeId : user.employeeId;

    if (!isHrOrAdmin && !targetEmployeeId) {
      throw new ForbiddenException('User is not associated with an employee profile');
    }

    return this.service.getPayslips(
      targetEmployeeId,
      payrollRunId,
      page ?? 1,
      Math.min(limit ?? 20, 100),
    );
  }

  @Get('payslips/:id')
  @ApiOperation({ summary: 'Get itemized payslip breakdown' })
  async getPayslipById(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    const payslip = await this.service.getPayslipById(id);
    const isHrOrAdmin = user.roles.includes(SystemRole.SUPER_ADMIN) || user.roles.includes(SystemRole.HR_ADMIN);

    if (!isHrOrAdmin && payslip.employeeId !== user.employeeId) {
      throw new ForbiddenException('Access denied to other employee payslips');
    }

    return payslip;
  }

  @Post('payslips/:id/corrections')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({
    summary: 'Add a manual correction line to a DRAFT payslip',
    description:
      'Appends an HR-entered adjustment to the stored breakdown and re-derives ' +
      'totals. DRAFT payslips in DRAFT runs only; approved/paid figures are immutable.',
  })
  addPayslipCorrection(
    @Param('id') id: string,
    @Body() dto: CreatePayslipCorrectionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.addPayslipCorrection(id, dto, user.sub, user.email);
  }

  @Get('payslips/:id/pdf')
  @ApiOperation({
    summary: 'Download payslip as PDF (rendered from stored payroll data)',
  })
  async getPayslipPdf(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    // Same access rule as the JSON payslip: HR/admin see all, employees see self.
    const payslip = await this.service.getPayslipById(id);
    const isHrOrAdmin = user.roles.includes(SystemRole.SUPER_ADMIN) || user.roles.includes(SystemRole.HR_ADMIN);

    if (!isHrOrAdmin && payslip.employeeId !== user.employeeId) {
      throw new ForbiddenException('Access denied to other employee payslips');
    }

    const { buffer, filename } = await this.service.getPayslipPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  }
}
