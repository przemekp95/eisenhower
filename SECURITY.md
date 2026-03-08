# Security Policy

## Supported Branches

Security fixes are maintained on the active repository branches listed below.

| Branch | Status | Notes |
| --- | --- | --- |
| `master` | Supported | Production branch and primary target for coordinated fixes |
| `dev` | Supported | Integration branch used before promotion to `master` |
| `feature/*` | Not supported | Short-lived development branches |
| archived or closed branches | Not supported | No security backports are provided |

## Reporting a Vulnerability

Please do not open public GitHub issues for security problems.

Use GitHub private vulnerability reporting for this repository when available:

1. Open the repository `Security` tab.
2. Choose `Report a vulnerability`.
3. Include affected files, impact, reproduction steps, and any suggested remediation.

If private reporting is not available, contact the maintainer directly through GitHub and clearly mark the message as a security report.

## Response Expectations

- Initial acknowledgement: within 3 business days
- Triage update: within 7 business days when the report is actionable
- Fix target: `dev` first, then promoted to `master` through the protected pull request flow

## Disclosure Policy

- We will validate the report, assess impact, and prepare a fix on a supported branch.
- Public disclosure should wait until a fix is available or an agreed mitigation is documented.
- Reporters will be credited only if they explicitly ask to be named.
