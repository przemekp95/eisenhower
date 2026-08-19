# TASK-065 OIDC Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make configured OIDC start automatically exactly once while retaining PKCE callbacks and showing a localized retry surface only after an OIDC error; preserve manual bearer-token entry only when OIDC is not configured.

**Architecture:** Keep PKCE and authorization-attempt state in `oidcSession.ts`; let `AppRouter` own the UI state machine and let `CredentialGate` render one of two explicit modes. A session-scoped synchronous attempt marker prevents Strict Mode and rerender races before the asynchronous PKCE digest completes.

**Tech Stack:** React 19, TypeScript, Web Crypto, sessionStorage, Jest 30, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-19-task-065-private-rag-oidc-design.md`

## Global Constraints

- OIDC uses Authorization Code with S256 PKCE and keeps bearer tokens in memory.
- OIDC entry with no callback, token, or error calls `beginOidcLogin` exactly once per attempt.
- OIDC recovery contains retry and `LanguageSwitcher`, but no access-code, card-memory, or manual-token copy.
- Manual token entry remains available only when the complete OIDC configuration is absent.
- Browser API calls retain Bearer auth and `credentials: 'omit'`.

---

### Task 1: Atomic OIDC authorization-attempt guard

**Files:**
- Modify: `web/src/oidcSession.ts`
- Test: `web/src/oidcSession.test.ts`

**Interfaces:**
- Produces: `beginOidcLogin(config, navigate?, force?) -> Promise<'started' | 'already-started'>`.
- Produces: `resetOidcLoginAttempt() -> void`.
- Preserves: `completeOidcLogin(url, config) -> Promise<boolean>` and S256 state/verifier validation.

- [ ] **Step 1: Write failing guard tests**

```ts
it('sets the attempt guard before async PKCE work and starts only once', async () => {
  const navigate = jest.fn();
  const first = beginOidcLogin(config, navigate);
  const second = beginOidcLogin(config, navigate);
  await expect(second).resolves.toBe('already-started');
  await expect(first).resolves.toBe('started');
  expect(navigate).toHaveBeenCalledTimes(1);
});

it('allows an explicit retry after reset', async () => {
  await beginOidcLogin(config, jest.fn());
  resetOidcLoginAttempt();
  const navigate = jest.fn();
  await expect(beginOidcLogin(config, navigate)).resolves.toBe('started');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd web && npm test -- --runTestsByPath src/oidcSession.test.ts`

Expected: FAIL because duplicate attempts are not guarded and `resetOidcLoginAttempt` does not exist.

- [ ] **Step 3: Implement the synchronous session guard**

```ts
const ATTEMPT_KEY = 'eisenhower.oidc.attempt';

export function resetOidcLoginAttempt() {
  sessionStorage.removeItem(ATTEMPT_KEY);
}

const defaultNavigate = (target: string) => window.location.assign(target);

export async function beginOidcLogin(
  config: OidcRuntimeConfig,
  navigate: (target: string) => void = defaultNavigate,
  force = false
) {
  if (force) resetOidcLoginAttempt();
  if (sessionStorage.getItem(ATTEMPT_KEY)) return 'already-started' as const;
  sessionStorage.setItem(ATTEMPT_KEY, 'starting');
  try {
    // existing verifier, challenge, state and navigation logic
    navigate(authorizationUrl.toString());
    return 'started' as const;
  } catch (issue) {
    resetOidcLoginAttempt();
    throw issue;
  }
}
```

Clear the attempt marker when `completeOidcLogin` consumes either a valid callback or a callback that fails state/exchange validation. Do not clear it on a normal rerender.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cd web && npm test -- --runTestsByPath src/oidcSession.test.ts`

Expected: PASS with one navigation, preserved S256/state tests, and retry reset coverage.

- [ ] **Step 5: Commit the isolated session change**

```bash
git add web/src/oidcSession.ts web/src/oidcSession.test.ts
git commit -m "fix(web): guard OIDC authorization attempts"
```

### Task 2: Automatic AppRouter OIDC state machine

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: guarded `beginOidcLogin`, `completeOidcLogin`, and `resetOidcLoginAttempt`.
- Produces: `checking | redirecting | ready | oidc-error` route state with no redirect loop.
- Produces: `CredentialGate({ mode: 'manual' | 'oidc-retry', onOidcRetry? })`.

- [ ] **Step 1: Write failing automatic-entry tests**

```tsx
it('automatically starts complete OIDC configuration exactly once', async () => {
  configureOidc();
  render(<React.StrictMode><App /></React.StrictMode>);
  await waitFor(() => expect(mockedOidcSession.beginOidcLogin).toHaveBeenCalledTimes(1));
  expect(screen.queryByLabelText('Kod dostępu')).not.toBeInTheDocument();
});

it('does not restart OIDC while completing a PKCE callback', async () => {
  configureOidc();
  window.history.replaceState({}, '', '/?code=valid&state=bound');
  render(<App />);
  await waitFor(() => expect(mockedOidcSession.completeOidcLogin).toHaveBeenCalledTimes(1));
  expect(mockedOidcSession.beginOidcLogin).not.toHaveBeenCalled();
});
```

Add cases for `?error=access_denied`, invalid state, exchange rejection, synchronous redirect-start failure, rerender, and an existing in-memory token.

- [ ] **Step 2: Run App tests and verify RED**

Run: `cd web && npm test -- --runTestsByPath src/App.test.tsx`

Expected: FAIL because OIDC currently waits for a visible login button.

- [ ] **Step 3: Implement the minimal route state machine**

```tsx
type AuthRouteState = 'checking' | 'redirecting' | 'ready' | 'oidc-error';

useEffect(() => {
  const oidc = oidcConfig();
  if (!oidc || apiToken) return void setAuthState('ready');
  const callback = new URL(window.location.href);
  if (callback.searchParams.has('error')) return void setAuthState('oidc-error');
  if (callback.searchParams.has('code')) {
    void completeOidcLogin(callback, oidc)
      .then(() => setAuthState('ready'))
      .catch(() => setAuthState('oidc-error'));
    return;
  }
  setAuthState('redirecting');
  void beginOidcLogin(oidc).catch(() => setAuthState('oidc-error'));
}, [apiToken]);
```

Render an inert `aria-busy` view for `checking` and `redirecting`; render the retry gate only for `oidc-error`; render the manual gate only when `oidcConfig()` is null.

- [ ] **Step 4: Run App and session tests and verify GREEN**

Run: `cd web && npm test -- --runTestsByPath src/App.test.tsx src/oidcSession.test.ts`

Expected: PASS with exactly one automatic start and unchanged callback behavior.

- [ ] **Step 5: Commit the router state machine**

```bash
git add web/src/App.tsx web/src/App.test.tsx
git commit -m "feat(web): enter configured OIDC automatically"
```

### Task 3: Localized OIDC retry surface

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/i18n/translations.ts`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `CredentialGate` mode from Task 2.
- Produces translation keys: `auth.oidcRetryTitle`, `auth.oidcRetryHelp`, `auth.oidcRetryAction`.

- [ ] **Step 1: Write failing PL/EN recovery tests**

```tsx
expect(await screen.findByRole('button', { name: 'Spróbuj zalogować ponownie' }))
  .toBeInTheDocument();
expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument();
expect(screen.queryByLabelText('Kod dostępu')).not.toBeInTheDocument();
expect(screen.queryByText(/kod dostępu|pamięci karty/i)).not.toBeInTheDocument();
```

Switch to English and assert `Try signing in again`, then click retry and assert `resetOidcLoginAttempt` precedes one forced authorization attempt.

- [ ] **Step 2: Run App tests and verify RED**

Run: `cd web && npm test -- --runTestsByPath src/App.test.tsx`

Expected: FAIL on old access-code wording and missing retry copy.

- [ ] **Step 3: Split manual and OIDC recovery markup**

Keep the access-code label, help and memory-only copy inside the `manual` branch. In the `oidc-retry` branch render only localized error/retry content and `LanguageSwitcher`. Retry resets the guard, sets state to `redirecting`, and calls guarded OIDC start once.

- [ ] **Step 4: Format and verify the complete web slice**

Run: `cd web && npm run format && npm test -- --runTestsByPath src/App.test.tsx src/oidcSession.test.ts && npm run build && npm run format:check`

Expected: all commands exit 0.

- [ ] **Step 5: Commit the recovery UX**

```bash
git add web/src/App.tsx web/src/App.test.tsx web/src/i18n/translations.ts
git commit -m "fix(web): localize OIDC retry recovery"
```

### Task 4: OIDC regression and evidence checkpoint

**Files:**
- Verify: `web/src/App.integration.test.tsx`
- Verify: `web/e2e/`

**Interfaces:**
- Produces: fresh focused and integration evidence for the OIDC slice.

- [ ] Run `cd web && npm test -- --runTestsByPath src/App.test.tsx src/oidcSession.test.ts`.
- [ ] Run `cd web && npm run test:integration`.
- [ ] Run `cd web && npm run build && npm run format:check`.
- [ ] Inspect `git diff --check` and `git status --short`; fix only failures caused by this slice.
- [ ] Record exact commands and counts in the TASK-065 progress section without claiming browser/provider acceptance from mocked tests.
