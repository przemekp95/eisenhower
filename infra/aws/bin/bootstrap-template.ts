#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import {
  applyBootstrapBoundaryToAllRoles,
  BootstrapTemplate,
} from '../lib/bootstrap-template';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('usage: bootstrap-template <input> <output>');
  process.exitCode = 1;
} else {
  const source = YAML.parse(fs.readFileSync(inputPath, 'utf8')) as BootstrapTemplate;
  const result = applyBootstrapBoundaryToAllRoles(source);
  if (result.roleCount !== 5) {
    throw new Error(`expected 5 bootstrap IAM roles, found ${result.roleCount}`);
  }
  const rendered = YAML.stringify(result.template);
  fs.writeFileSync(outputPath, rendered);
  const digest = createHash('sha256').update(rendered).digest('hex');
  console.info(`hardened ${result.roleCount} bootstrap roles; sha256=${digest}`);
}
