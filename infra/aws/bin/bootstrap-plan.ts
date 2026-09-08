#!/usr/bin/env node
import {
  bootstrapPlanFromEnvironment,
  formatBootstrapCommand,
} from '../lib/bootstrap-plan';

try {
  for (const entry of bootstrapPlanFromEnvironment(process.env)) {
    console.info(formatBootstrapCommand(entry));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'invalid bootstrap security configuration');
  process.exitCode = 1;
}
