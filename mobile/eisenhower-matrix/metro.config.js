const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const sharedPackagesRoot = path.resolve(workspaceRoot, 'packages');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot, sharedPackagesRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;
config.resolver.extraNodeModules = {
  '@eisenhower/api-client': path.resolve(sharedPackagesRoot, 'api-client'),
};

module.exports = config;
