/**
 * ReportsController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService, REPORT_TYPES, REPORT_FORMATS } from './reports.service';

describe('ReportsController', () => {
  let controller: ReportsController;
  let service: any;

  const res: any = () => ({
    setHeader: jest.fn(),
    send: jest.fn(),
  });

  beforeEach(async () => {
    service = { exportReport: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [{ provide: ReportsService, useValue: service }],
    }).compile();

    controller = module.get<ReportsController>(ReportsController);
  });

  it('rejects unknown report types', async () => {
    await expect(
      controller.getReport('nonsense', 'csv', undefined, undefined, undefined, res()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.exportReport).not.toHaveBeenCalled();
  });

  it('rejects unknown formats', async () => {
    await expect(
      controller.getReport(REPORT_TYPES[0], 'yaml', undefined, undefined, undefined, res()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.exportReport).not.toHaveBeenCalled();
  });

  it('streams the exported report with download headers', async () => {
    const buffer = Buffer.from('a,b\n1,2\n');
    service.exportReport.mockResolvedValue({
      buffer,
      filename: 'headcount.csv',
      contentType: 'text/csv',
    });
    const r = res();

    await controller.getReport(REPORT_TYPES[0], 'csv', '2026-01-01', '2026-12-31', 'dep-1', r);

    expect(service.exportReport).toHaveBeenCalledWith(REPORT_TYPES[0], 'csv', {
      from: '2026-01-01',
      to: '2026-12-31',
      departmentId: 'dep-1',
    });
    expect(r.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
    expect(r.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="headcount.csv"',
    );
    expect(r.setHeader).toHaveBeenCalledWith('Content-Length', String(buffer.length));
    expect(r.send).toHaveBeenCalledWith(buffer);
  });

  it('defaults the format to csv', async () => {
    service.exportReport.mockResolvedValue({ buffer: Buffer.from('x'), filename: 'f.csv', contentType: 'text/csv' });
    const r = res();
    await controller.getReport(REPORT_TYPES[0], undefined as any, undefined, undefined, undefined, r);
    expect(service.exportReport).toHaveBeenCalledWith(
      REPORT_TYPES[0],
      'csv',
      { from: undefined, to: undefined, departmentId: undefined },
    );
  });

  it('exposes the supported report types and formats', () => {
    expect(REPORT_TYPES.length).toBeGreaterThan(0);
    expect(REPORT_FORMATS).toEqual(expect.arrayContaining(['csv', 'xlsx', 'pdf']));
  });
});
