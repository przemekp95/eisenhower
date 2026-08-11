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

  Scenario: Delete a task
    Given my task "Remove obsolete note" is in the "Delete" quadrant
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
