import { DynamicModule, Module } from '@nestjs/common';
import type { CreateAppOptions } from '../../app-options';
import { TaskQueryService } from '../../application/tasks/task-query.service';
import { MongooseTaskRepository } from '../../repositories/mongooseTaskRepository';
import { TASK_REPOSITORY } from '../../platform/tokens';
import { TaskQueryController } from './task-query.controller';

@Module({})
export class TasksModule {
  static register(options: CreateAppOptions): DynamicModule {
    return {
      module: TasksModule,
      controllers: [TaskQueryController],
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
      ],
      exports: [TaskQueryService],
    };
  }
}
