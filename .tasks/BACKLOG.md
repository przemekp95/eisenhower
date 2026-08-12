# Backlog

## TASK-028: Add Grounded RAG and camera parity across web and mobile
**Priority:** P2 | **Tags:** product, rag, mobile, web, parity

Define the supported Grounded RAG and camera workflows on both clients, including platform capabilities, privacy, permissions, offline behavior, and acceptance evidence.

### Plan

- Decide which RAG and camera capabilities belong on each platform and define privacy/permission boundaries.
- Implement equivalent user-visible contracts where platform support permits it.
- Verify accessible desktop/mobile UX and physical camera behavior separately from mocked tests.

---

## TASK-006: Revisit the React Native 0.84 migration when Expo supports it
**Priority:** P3 | **Tags:** mobile, dependencies, deferred

Keep the supported Expo 55 dependency baseline. Reassess React Native 0.84 or newer only after a stable Expo release supports it and the full mobile and native Android gates can run.

### Plan

- Check the stable Expo compatibility matrix when a newer supported line exists.
- Upgrade as one deliberate platform migration and run the complete mobile/native Android verification.

---
