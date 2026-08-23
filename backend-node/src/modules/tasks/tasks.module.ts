import { DynamicModule, Module } from '@nestjs/common';
import type { CreateAppOptions } from '../../app-options';
import { TaskQueryService } from '../../application/tasks/task-query.service';
import { MongooseTaskRepository } from '../../repositories/mongooseTaskRepository';
import { TASK_REPOSITORY } from '../../platform/tokens';
import { TaskQueryController } from './task-query.controller';
import { TaskCommandController } from './task-command.controller';
import { TaskCommandService } from '../../application/tasks/task-command.service';
import { TaskIdPipe, TaskValidationPipe } from './task-validation.pipe';

@Module({})
export class TasksModule {
  static register(options: CreateAppOptions): DynamicModule {
    return {
      module: TasksModule,
      controllers: [TaskQueryController, TaskCommandController],
      providers: [
        {
          provide: TASK_REPOSITORY,
          useValue: options.taskRepository ?? new MongooseTaskRepository(),
        },
        {
          provide: TaskQueryService,
          useFactory: (repository) => new TaskQueryService(repository),
          inject: [TASK_REPOSITORY],
        },
        {
          provide: TaskCommandService,
          useFactory: (repository) => new TaskCommandService(repository),
          inject: [TASK_REPOSITORY],
        },
        TaskValidationPipe,
        TaskIdPipe,
      ],
      exports: [TaskQueryService],
    };
  }
}
