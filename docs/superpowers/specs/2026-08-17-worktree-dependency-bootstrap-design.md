# Automatic worktree dependency bootstrap

## Problem

Git worktrees contain tracked repository files but do not copy ignored `node_modules` directories or Python virtual environments. The repository provides `make setup`, but `make verify` currently assumes that every component has already been prepared. A fresh or partially used worktree therefore fails with a misleading missing-module or missing-interpreter error during promotion.

## Selected design

Add a repository-owned preparation command that runs automatically before `make verify`. It will cover the four lockfile-backed Node package roots and the backend-AI development environment. Each component will have a deterministic input digest and an ignored stamp written only after a successful installation.

For Node packages, the digest binds the component's `package-lock.json`. A missing `node_modules` directory, missing stamp or changed digest runs `npm ci` only for that component. For backend AI, the digest binds the selected Python executable identity plus `requirements-dev.txt` and every repository-local requirements file it references recursively. A missing virtual environment, missing stamp or changed digest creates or refreshes that environment and installs the development requirements.

`make prepare-verify` will provide the incremental behavior and `make verify` will depend on it. `make setup` will remain an explicit force-refresh command so its established meaning does not silently change. Installation failures must leave no valid stamp and identify the failing component.

## Interfaces and boundaries

- A small repository script owns digest calculation, component selection, installation and atomic stamp replacement.
- Make targets only select incremental preparation, explicit force setup and verification sequencing.
- Stamps live inside already ignored dependency directories and never become source artifacts.
- The mechanism remains repository-portable and does not depend on Codex-specific worktree hooks.
- CI may retain its explicit per-job `npm ci`; this change governs local repository verification and does not weaken CI isolation.

## Verification

Automated tests run the preparation script against temporary fixture components and fake installers. They prove that a fresh checkout installs every required component, an unchanged prepared checkout performs no installation, a changed input refreshes only its component, and a failed install does not write a valid stamp. A disposable Git worktree rehearsal then proves the real `make verify` preparation boundary before the complete repository verification suite runs.

## Evidence boundary

This change proves deterministic local dependency preparation and repository verification behavior. It does not publish packages, images or releases and does not deploy the application.
