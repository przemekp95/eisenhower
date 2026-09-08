import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("Node coverage gate stays high while excluding only generated and subprocess entrypoints", () => {
  const config = require("../../backend-node/jest.config.js");

  assert.deepEqual(config.collectCoverageFrom, [
    "src/**/*.ts",
    "!src/server.ts",
    "!src/generated/**",
    "!src/taskMigrationCli.ts",
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
