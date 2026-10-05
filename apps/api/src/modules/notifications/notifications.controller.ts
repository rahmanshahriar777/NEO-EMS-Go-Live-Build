import { Controller, Get, Patch, Post, Param, Query, Body, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '@ems/shared';
import { IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class PushKeysDto {
  @IsString()
  @IsNotEmpty()
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  auth!: string;
}

class PushSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  endpoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  @IsOptional()
  expirationTime?: number | null;
}

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List notifications for the logged in user (bell dropdown)' })
  getMyNotifications(
    @CurrentUser() user: JwtPayload,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.service.getUserNotifications(user.sub, {
      unreadOnly: unreadOnly === 'true',
      page,
      limit,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread notification count for the bell badge' })
  getUnreadCount(@CurrentUser() user: JwtPayload) {
    return this.service.getUnreadCount(user.sub);
  }

  @Post('mark-all-read')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.service.markAllRead(user.sub);
  }

  @Get('vapid-public-key')
  @ApiOperation({
    summary: 'VAPID public key for web-push subscription (null when unconfigured)',
  })
  getVapidPublicKey() {
    return this.service.getVapidPublicKey();
  }

  @Post('push-subscriptions')
  @ApiOperation({ summary: 'Register a web-push subscription for the logged in user' })
  savePushSubscription(@Body() dto: PushSubscriptionDto, @CurrentUser() user: JwtPayload) {
    return this.service.savePushSubscription(user.sub, dto);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  markAsRead(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.markAsRead(id, user.sub);
  }
}
