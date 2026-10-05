import { Controller, Post, Body, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AiAssistantService } from './ai-assistant.service';
import { AssistantAskDto, AssistantActionDto } from './dto/ai-assistant.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '@ems/shared';

// NOTE (B1): guards are global; per-controller @UseGuards duplication removed.
@ApiTags('AI Assistant')
@ApiBearerAuth()
@Controller('ai-assistant')
export class AiAssistantController {
  constructor(private readonly service: AiAssistantService) {}

  @Post('ask')
  @ApiOperation({
    summary: 'Ask the grounded HR assistant (role-scoped retrieval, cited answers)',
  })
  ask(@Body() dto: AssistantAskDto, @CurrentUser() user: JwtPayload) {
    return this.service.ask(
      { userId: user.sub, employeeId: user.employeeId, email: user.email, roles: user.roles },
      dto,
    );
  }

  @Post('actions')
  @ApiOperation({
    summary: 'Run a safe AI action (currently: draft-leave-request)',
  })
  runAction(@Body() dto: AssistantActionDto, @CurrentUser() user: JwtPayload) {
    return this.service.runAction(
      { userId: user.sub, employeeId: user.employeeId, email: user.email, roles: user.roles },
      dto,
    );
  }
}
