# Deferred Migrations

This file tracks dependency and framework migrations that were intentionally kept out of the routine maintenance pass merged through PR `#38`.

These items are not blocked forever. They were deferred because they require a dedicated migration window, broader compatibility testing, or coordinated upgrades across multiple packages.

## Deferred Items

| Area | Migration | Original PRs | Why It Was Deferred | Notes |
| --- | --- | --- | --- | --- |
| Mobile | React 19 and React Test Renderer 19 | [#21](https://github.com/przemekp95/eisenhower/pull/21), [#29](https://github.com/przemekp95/eisenhower/pull/29) | This is not a standalone dependency bump. It changes the core React runtime for the mobile app and affects the testing stack. | Treat this as part of a coordinated Expo/mobile platform upgrade. |
| Mobile | React Native 0.84.x | [#48](https://github.com/przemekp95/eisenhower/pull/48) | This is a framework-level mobile runtime upgrade with native compatibility implications for Expo, React Native Testing Library, Metro, and platform tooling. | Take it only as part of a coordinated Expo/mobile platform migration. |
| Mobile | Expo SDK-aligned `expo-status-bar` 55.x | [#27](https://github.com/przemekp95/eisenhower/pull/27) | The app is still pinned to Expo 52, so jumping to the Expo 55 package line is a compatibility migration, not a low-risk patch. | Upgrade the Expo SDK first, then align Expo-managed packages. |
| Mobile | Expo SDK-aligned `babel-preset-expo` 55.x | [#51](https://github.com/przemekp95/eisenhower/pull/51) | This moves the mobile build and transform toolchain onto Expo 55 semantics while the app is still on Expo 52. It is not safe as an isolated package bump. | Upgrade together with the Expo SDK and related Expo-managed packages. |
| Mobile | `jest-expo` 55.x | [#33](https://github.com/przemekp95/eisenhower/pull/33) | The proposed version moves the mobile test runner onto a newer Expo/Jest stack and was already red in CI. | Migrate together with the Expo SDK and React/test-renderer changes. |
| Web | Tailwind CSS 4 | [#25](https://github.com/przemekp95/eisenhower/pull/25) | Tailwind 4 is a tooling and configuration migration, not a routine dependency update. It can require build config, plugin, and stylesheet changes. | Schedule this as a separate frontend migration with visual regression checks. |
| Backend Node | Mongoose 9 | [#23](https://github.com/przemekp95/eisenhower/pull/23) | This is a major runtime and typing upgrade for the backend persistence layer. It should not be mixed into a general maintenance batch. | Review schema hooks, query behavior, middleware, and test fixtures before adoption. |

## Recommended Order

1. Mobile platform migration:
   Upgrade Expo SDK first, then align `babel-preset-expo`, `expo-status-bar`, `jest-expo`, `react`, `react-test-renderer`, and `react-native` in one planned pass.
2. Web styling migration:
   Move `web` to Tailwind CSS 4 with explicit build and UI verification.
3. Backend persistence migration:
   Upgrade `backend-node` to Mongoose 9 after a focused compatibility review.

## Scope Rule

Future routine maintenance PRs should keep excluding these items until they are explicitly taken on as migration work.
