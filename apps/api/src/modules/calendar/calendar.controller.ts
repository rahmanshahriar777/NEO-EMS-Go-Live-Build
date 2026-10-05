import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CalendarService } from './calendar.service';
import { CalendarQueryDto, HolidaysQueryDto } from './dto/calendar.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '@ems/shared';

// @Permissions() intentionally not attached — see the note in
// gdpr.controller.ts (role -> permission grants are not seeded yet).
@ApiTags('Calendar')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('calendar')
export class CalendarController {
  constructor(private readonly service: CalendarService) {}

  @Get()
  @ApiOperation({
    summary:
      'Unified calendar events (SRS FR-CAL-001): approved leave ranges, holidays, roster entries. Leave titles are named for HR/managers and "Busy" for peers.',
  })
  getEvents(@Query() query: CalendarQueryDto, @CurrentUser() user: JwtPayload) {
    const to = query.to ? new Date(query.to) : undefined;
    const from = query.from ? new Date(query.from) : new Date();
    const end = to ?? new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
    return this.service.getEvents(from, end, user);
  }

  @Get('holidays')
  @ApiOperation({ summary: 'Holiday list for a calendar year (?year=, defaults to current year)' })
  getHolidays(@Query() query: HolidaysQueryDto) {
    const year = query.year ?? new Date().getUTCFullYear();
    return this.service.getHolidays(year);
  }
}
