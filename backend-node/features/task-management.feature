Feature: Manage tasks in the Eisenhower matrix
  As an authenticated user
  I want task changes to preserve their Eisenhower quadrant
  So that my task list reflects how I intend to act

  Scenario Outline: Create a task in each Eisenhower quadrant
    When I create the task "<title>" in the "<quadrant>" quadrant
    Then the request succeeds with status 201
    And the returned task is in the "<quadrant>" quadrant
    When I list my tasks
    Then my task list contains "<title>" in the "<quadrant>" quadrant

    Examples:
      | title            | quadrant |
      | Fix outage       | Do Now   |
      | Book contractor  | Delegate |
      | Plan migration   | Schedule |
      | Drop busywork    | Delete   |

  Scenario: Move a task to another quadrant
    Given my task "Review roadmap" is in the "Schedule" quadrant
    When I move the task to the "Do Now" quadrant
    Then the request succeeds with status 200
    And the returned task is in the "Do Now" quadrant

  Scenario: Edit the wording of an existing task
    Given my task "Draft quarterly plan" is in the "Schedule" quadrant
    When I rename the task to "Prepare quarterly plan" and describe it as "Review with the team"
    Then the request succeeds with status 200
    And the returned task is named "Prepare quarterly plan" with description "Review with the team"

  Scenario: Protect a newer change from being overwritten
    Given my task "Shared plan" is in the "Schedule" quadrant
    And someone else renames the task to "Shared plan updated elsewhere"
    When I try to rename my older version to "My stale draft"
    Then the request fails because the task changed
    And the task is still named "Shared plan updated elsewhere"

  Scenario: Retry one mobile creation operation safely
    When I retry creating the task "Retry-safe plan" twice with operation key "mobile-bdd-operation-1"
    Then the request succeeds with status 200
    And exactly one task named "Retry-safe plan" exists

  Scenario: Complete, trash, and restore a task
    Given my task "Finish lifecycle" is in the "Schedule" quadrant
    When I change the task lifecycle with action "complete"
    Then the request succeeds with status 200
    And the returned task lifecycle is "completed"
    When I change the task lifecycle with action "reopen"
    Then the returned task lifecycle is "active"
    When I change the task lifecycle with action "archive"
    Then the returned task lifecycle is "archived"
    When I change the task lifecycle with action "restore"
    Then the returned task lifecycle is "active"
    When I change the task lifecycle with action "complete"
    Then the returned task lifecycle is "completed"
    When I change the task lifecycle with action "trash"
    Then the returned task lifecycle is "trashed"
    When I change the task lifecycle with action "restore"
    Then the returned task lifecycle is "completed"

  Scenario: Schedule and clear a task reminder independently of lifecycle
    Given my task "Prepare release" is in the "Schedule" quadrant
    When I schedule it for "2026-08-15T12:00:00.000Z" in "Europe/Warsaw" with reminder "2026-08-15T10:00:00.000Z"
    Then the request succeeds with status 200
    And the returned schedule is due "2026-08-15T12:00:00.000Z" in "Europe/Warsaw" with reminder "2026-08-15T10:00:00.000Z"
    When I clear the task schedule
    Then the request succeeds with status 200
    And the returned task has no schedule

  Scenario: Owner hands work to a same-tenant assignee without granting core edit access
    Given owner "owner-a" has a task "Prepare delegated release" for delegation
    When the owner offers it to assignee "user-b" labelled "Pat"
    Then the returned delegation status is "offered"
    When assignee "user-b" lists delegated work
    Then the delegated task list contains "Prepare delegated release"
    When the assignee accepts the delegated task
    Then the returned delegation status is "accepted"
    When the assignee tries to rename the owner task
    Then the request fails as not found

  Scenario: Permanently delete a trashed task
    Given my task "Remove obsolete note" is in the "Delete" quadrant
    When I delete the task
    Then the request fails because the task is not trashed
    When I change the task lifecycle with action "trash"
    When I delete the task
    Then the request succeeds with status 204
    When I list my tasks
    Then my task list does not contain "Remove obsolete note"

  Scenario: Keep another tenant's tasks private
    Given another tenant has a task named "Private plan"
    When I list my tasks
    Then my task list does not contain "Private plan"
    When I try to move the other tenant's task to the "Delete" quadrant
    Then the request fails as not found
    When I try to delete the other tenant's task
    Then the request fails as not found
    And the other tenant's task still exists
