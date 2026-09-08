<!-- TASKPLANNER:START -->
# TaskPlanner workflow

- Read `.tasks/config.json` and use its state-file mapping.
- Select work from `Next`, then `Backlog`, in priority order unless the user chooses a task.
- Move the complete task section to `In Progress` before implementation.
- Keep a concise `### Plan`, implement and verify, then move completed work to `Done`.
- Add a short newest-first entry to `.tasks/WORK_LOG.md`; preserve unrelated tasks and all content outside this managed block.
<!-- TASKPLANNER:END -->

## Policy gate

- `.codex/verify` is the canonical repository verification command. Keep local development, the Codex `Stop` hook, and CI on this same entry point.
- Before claiming completion, run `.codex/verify` after the final material change and report its fresh result.
- Do not bypass, weaken, or remove the gate to make a change pass. A documented exception requires explicit user or repository-owner approval.
