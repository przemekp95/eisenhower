Feature: Protect access to task management
  As a task owner
  I want task requests to require trusted credentials and browser origins
  So that another site or unauthenticated caller cannot change my matrix

  Scenario: Require bearer credentials
    When I list tasks without bearer credentials
    Then the request fails with status 401 and error "Authentication required"
    And the response advertises bearer authentication

  Scenario: Reject invalid bearer credentials
    When I list tasks with bearer token "wrong-token"
    Then the request fails with status 401 and error "Invalid bearer token"
    And the response advertises an invalid bearer token

  Scenario: Allow a state change from the configured browser origin
    Given the configured browser origin is "https://tasks.example.com"
    When a browser from "https://tasks.example.com" creates the task "Trusted task"
    Then the request succeeds with status 201

  Scenario: Reject a state change from an untrusted browser origin
    Given the configured browser origin is "https://tasks.example.com"
    When a browser from "https://attacker.example" creates the task "Cross-site task"
    Then the request fails with status 403 and error "Untrusted browser origin"
    And no task named "Cross-site task" exists
