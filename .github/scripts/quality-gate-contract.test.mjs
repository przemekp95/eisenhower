import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("Node coverage gate stays high while declaring every generated, subprocess, and transport exclusion", () => {
  const config = require("../../backend-node/jest.config.js");

  assert.deepEqual(config.collectCoverageFrom, [
    "src/**/*.ts",
    "!src/server.ts",
    "!src/generated/**",
    "!src/taskMigrationCli.ts",
    "!src/app.ts",
    "!src/app.module.ts",
    "!src/modules/**/*.controller.ts",
    "!src/modules/**/*.module.ts",
    "!src/modules/**/*.guard.ts",
    "!src/modules/**/*.decorators.ts",
    "!src/modules/tasks/*dto.ts",
    "!src/modules/tasks/task-validation.pipe.ts",
    "!src/platform/http/**/*.ts",
  ]);
  assert.deepEqual(config.coverageThreshold, {
    global: {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  });
});

test("web and mobile resolve both maintained xmldom lines to patched releases", () => {
  const webManifest = require("../../web/package.json");
  const webLock = require("../../web/package-lock.json");
  const mobileManifest = require("../../mobile/eisenhower-matrix/package.json");
  const mobileLock = require("../../mobile/eisenhower-matrix/package-lock.json");

  assert.equal(webManifest.overrides["@xmldom/xmldom"], "0.8.15");
  assert.equal(webLock.packages["node_modules/@xmldom/xmldom"].version, "0.8.15");
  assert.equal(
    mobileManifest.overrides["@expo/plist"]["@xmldom/xmldom"],
    "0.8.15",
  );
  assert.equal(
    mobileManifest.overrides.plist["@xmldom/xmldom"],
    "0.9.12",
  );
  assert.equal(
    mobileLock.packages["node_modules/@xmldom/xmldom"].version,
    "0.8.15",
  );
  assert.equal(
    mobileLock.packages["node_modules/plist/node_modules/@xmldom/xmldom"].version,
    "0.9.12",
  );
});
