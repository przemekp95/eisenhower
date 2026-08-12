import type {
  TaskDto,
  TaskDelegationAssignmentDto,
  TaskDelegationStatus as TaskDelegationStatusDto,
  TaskInputDto,
  TaskLifecycleAction as TaskLifecycleActionDto,
  TaskLifecycleFilter as TaskLifecycleFilterDto,
  TaskScheduleDto,
} from '@eisenhower/api-client';

export type Task = TaskDto;
export type TaskDelegationAssignment = TaskDelegationAssignmentDto;
export type TaskDelegationStatus = TaskDelegationStatusDto;
export type TaskInput = TaskInputDto;
export type TaskLifecycleAction = TaskLifecycleActionDto;
export type TaskLifecycleFilter = TaskLifecycleFilterDto;
export type TaskSchedule = TaskScheduleDto;
export type TaskView = 'owned' | 'delegated';
