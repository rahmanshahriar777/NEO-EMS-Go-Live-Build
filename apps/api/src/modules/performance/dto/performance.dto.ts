import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { GoalStatus, FeedbackType } from '@ems/shared';

export class CreateReviewCycleDto {
  @ApiProperty({ example: 'Annual Performance Appraisal 2026' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiProperty({ example: '2026-07-01' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate: string;

  @ApiProperty({ example: '2026-12-31' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate: string;

  @ApiPropertyOptional({ example: 'Yearly performance assessment' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;
}

export class CreatePerformanceReviewDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  cycleId: string;

  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  employeeId: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  reviewerId?: string;
}

export class SubmitSelfReviewDto {
  @ApiProperty({ example: 4.5, description: 'Rating between 1 and 5' })
  @IsNumber()
  @Min(1)
  @Max(5)
  selfRating: number;

  @ApiProperty({ example: 'Delivered high impact monorepo architecture and performance service.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  selfAchievements: string;

  @ApiProperty({ example: 'Continue to enhance automated Kubernetes CI pipelines.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  selfImprovements: string;
}

export class SubmitManagerReviewDto {
  @ApiProperty({ example: 4.8, description: 'Rating between 1 and 5' })
  @IsNumber()
  @Min(1)
  @Max(5)
  managerRating: number;

  @ApiProperty({ example: 'Consistently surpasses expectations and mentors junior colleagues.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  managerFeedback: string;

  @ApiPropertyOptional({ example: 4.65 })
  @IsNumber()
  @Min(1)
  @Max(5)
  @IsOptional()
  finalScore?: number;
}

export class CreateGoalDto {
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @ApiProperty({ example: 'Improve unit test coverage to 85%' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: '2026-11-30' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  targetDate: string;

  @ApiPropertyOptional({ default: 0 })
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  progress?: number = 0;

  @ApiPropertyOptional({ enum: GoalStatus, default: GoalStatus.NOT_STARTED })
  @IsEnum(GoalStatus)
  @IsOptional()
  status?: GoalStatus;
}

export class UpdateGoalDto {
  @ApiPropertyOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  progress?: number;

  @ApiPropertyOptional({ enum: GoalStatus })
  @IsEnum(GoalStatus)
  @IsOptional()
  status?: GoalStatus;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;
}

export class SubmitFeedbackDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  recipientId: string;

  @ApiProperty({ enum: FeedbackType, default: FeedbackType.PEER })
  @IsEnum(FeedbackType)
  type: FeedbackType;

  @ApiProperty({ example: 'Great collaboration on cross-functional API design sprint!' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  comments: string;

  @ApiPropertyOptional({ example: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  rating?: number;
}

/** Phase 2, item 9 — HR-managed review form template. */
export class CreateReviewFormDto {
  @ApiProperty({ example: 'Engineering Performance Review' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({
    description: 'Form sections: [{ key, title, questions: [{ key, label, type, required }] }]',
    example: [
      {
        key: 'performance',
        title: 'Job Performance',
        questions: [{ key: 'quality', label: 'Quality of work', type: 'rating', required: true }],
      },
    ],
  })
  @IsNotEmpty()
  sections: Record<string, any>[];

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
