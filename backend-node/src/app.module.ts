import { DynamicModule, Module } from '@nestjs/common';
import { CreateAppOptions } from './app-options';
import { HealthModule } from './modules/health/health.module';
import { APP_OPTIONS } from './platform/tokens';

@Module({})
export class AppModule {
  static register(options: CreateAppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [HealthModule.register(options)],
      providers: [{ provide: APP_OPTIONS, useValue: options }],
    };
  }
}
