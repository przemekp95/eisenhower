import { Controller, Get, HttpException } from '@nestjs/common';
import { HealthService } from './health.service';
import { PublicRoute } from '../security/security.decorators';

@Controller('health')
@PublicRoute()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  liveness() {
    return this.health.liveness();
  }

  @Get('ready')
  async readiness() {
    const result = await this.health.readiness();
    if (result.statusCode !== 200) throw new HttpException(result.body, result.statusCode);
    return result.body;
  }
}
