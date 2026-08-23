import {
  IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength,
} from 'class-validator';
import { TASK_DELEGATION_STATUSES, TASK_LIFECYCLE_ACTIONS } from '../../application/taskRepository';

export class CreateTaskDto {
  @IsString() @IsNotEmpty() @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
  @IsOptional() @IsBoolean() important?: boolean;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
  @IsOptional() @IsBoolean() important?: boolean;
}

export class LifecycleTaskDto {
  @IsIn(TASK_LIFECYCLE_ACTIONS) action!: (typeof TASK_LIFECYCLE_ACTIONS)[number];
}

export class ScheduleTaskDto { schedule!: null | Record<string, unknown>; }
export class DelegationTaskDto { delegation!: null | Record<string, unknown>; }

export class DelegationStatusTaskDto {
  @IsIn(TASK_DELEGATION_STATUSES) status!: (typeof TASK_DELEGATION_STATUSES)[number];
}
