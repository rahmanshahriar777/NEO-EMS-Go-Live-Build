import { Module } from '@nestjs/common';
import { StatutoryPayrollController } from './statutory-payroll.controller';
import { StatutoryPayrollService } from './statutory-payroll.service';

/**
 * Statutory payroll integration (Phase 3 item 3).
 *
 * Adapter interface + config + admin endpoints + a clearly-marked SANDBOX
 * provider. NEO EMS never implements tax logic itself.
 */
@Module({
  controllers: [StatutoryPayrollController],
  providers: [StatutoryPayrollService],
  exports: [StatutoryPayrollService],
})
export class PayrollStatutoryModule {}
