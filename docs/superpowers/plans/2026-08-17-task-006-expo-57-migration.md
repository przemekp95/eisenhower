# TASK-006 Expo 57 migration plan

> Scope: migrate only the mobile platform baseline. Do not mix TASK-028 changes, deployment, store publication, signing-key changes, or physical-device acceptance into this branch.

## Compatibility decision

- [x] Confirm Expo SDK 56 satisfies the original React Native 0.84-or-newer trigger.
- [x] Select Expo SDK 57 / React Native 0.86.2 because it fixes the Hermes V1 memory regression inherited by SDK 56.
- [x] Keep this migration isolated from the TASK-028 worktree.

## Implementation

- [x] Move TASK-006 from Backlog to In Progress before implementation.
- [x] Upgrade Expo and Expo-managed dependencies using Expo's compatibility resolver.
- [x] Reconcile direct React, React Native, test-renderer and native dependencies.
- [x] Replace the legacy splash field with the `expo-splash-screen` config plugin.
- [x] Remove the obsolete Metro symlink override and inspect the resulting manifest and lockfile.

## Verification

- [x] Run the complete Jest suite and security tests.
- [x] Run the production dependency audit, Expo compatibility check and Expo Doctor.
- [x] Generate a clean Android project and assemble a release APK.
- [x] Verify the APK signature and hash.
- [x] Record the evidence boundary and move TASK-006 to Done.
