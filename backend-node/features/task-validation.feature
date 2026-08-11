Feature: Reject invalid task requests
  As a task owner
  I want invalid changes to fail predictably
  So that malformed or unsafe data does not enter my matrix

  Scenario: Reject a task without a title
    When I submit a task without a title
    Then the request fails with status 400 and error "Validation failed"

  Scenario: Reject a title longer than the public limit
    When I submit a task with a title longer than 200 characters
    Then the request fails with status 400 and error "Validation failed"

  Scenario: Reject an unexpected task field
    When I submit a task containing the unexpected field "role"
    Then the request fails with status 400 and error "Validation failed"
    And the validation details include "Unexpected task field"
    And no task named "Safe task" exists

  Scenario: Hide a missing task during an update
    When I try to move a missing task to the "Do Now" quadrant
    Then the request fails as not found
