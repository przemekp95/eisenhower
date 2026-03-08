# Deferred Migrations

This file tracks framework and dependency migrations that are still intentionally deferred.

Implemented migrations were removed from this backlog. The only remaining deferred item is the React Native runtime jump beyond the stable Expo-supported baseline.

## Deferred Items

| Area | Migration | Original PRs | Why It Remains Deferred | Next Trigger |
| --- | --- | --- | --- | --- |
| Mobile | React Native 0.84.x | [#48](https://github.com/przemekp95/eisenhower/pull/48) | Stable Expo SDK 55 does not support React Native `0.84.x`. `expo install --check` expects `react-native 0.83.2` and `react 19.2.0` for this SDK line. | Re-open when a stable Expo SDK line officially supports React Native `0.84.x` or newer. |

## Current Mobile Baseline

The mobile app is now aligned to the stable Expo 55 stack:

- `expo ^55.0.5`
- `react 19.2.0`
- `react-native 0.83.2`
- `expo-status-bar ^55.0.4`
- `babel-preset-expo ^55.0.10`
- `jest-expo ^55.0.9`
- `react-test-renderer 19.2.0`

This keeps the app on the newest verified Expo-supported platform without forcing an unsupported React Native runtime.

## Scope Rule

Future routine maintenance PRs should keep excluding React Native `0.84.x` until it becomes a planned platform migration backed by a stable Expo release.
