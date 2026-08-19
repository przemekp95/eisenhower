import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import App from './App';
import { clearApiToken, setApiToken } from './authSession';
import { runtimeConfig } from './config';
import * as api from './services/api';
import * as oidcSession from './oidcSession';

jest.mock('./services/api');
jest.mock('./oidcSession');
jest.mock('./components/Matrix', () => ({
  __esModule: true,
  default: ({
    tasks,
    loading,
    onAddTask,
    onUpdateTask,
    onDeleteTask,
    onLifecycleFilterChange,
    onLifecycleTask,
    onUpdateSchedule,
    onUpdateDelegation,
    onDelegationStatus,
  }: any) => (
    <section aria-label="Test board">
      <p>{loading ? 'board-loading' : 'board-ready'}</p>
      {tasks.map((task: any) => (
        <p key={task._id}>{task.title}</p>
      ))}
      <button
        type="button"
        onClick={() =>
          void onAddTask({
            title: 'New task',
            description: '',
            urgent: false,
            important: false,
          }).catch(() => undefined)
        }
      >
        test-add
      </button>
      <button
        type="button"
        onClick={() => void onUpdateTask('1', { title: 'Updated title' }).catch(() => undefined)}
      >
        test-update
      </button>
      <button type="button" onClick={() => void onDeleteTask('1').catch(() => undefined)}>
        test-delete
      </button>
      <button type="button" onClick={() => onLifecycleFilterChange('all')}>
        test-filter-all
      </button>
      <button
        type="button"
        onClick={() => void onLifecycleTask('1', 'complete').catch(() => undefined)}
      >
        test-lifecycle
      </button>
      <button type="button" onClick={() => void onUpdateSchedule('1', null).catch(() => undefined)}>
        test-schedule
      </button>
      <button
        type="button"
        onClick={() =>
          void onUpdateDelegation('1', {
            assigneeUserId: 'user-b',
            displayLabel: 'Pat',
            handoffNote: '',
          }).catch(() => undefined)
        }
      >
        test-delegation
      </button>
      <button
        type="button"
        onClick={() => void onDelegationStatus('1', 'accepted').catch(() => undefined)}
      >
        test-delegation-status
      </button>
    </section>
  ),
}));
const mockedApi = jest.mocked(api);
const mockedOidcSession = jest.mocked(oidcSession);
const initialTask = {
  _id: '1',
  title: 'Existing task',
  description: 'desc',
  urgent: true,
  important: false,
  revision: 7,
};

describe('App', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'pl');
    runtimeConfig.oidcIssuer = undefined;
    runtimeConfig.oidcClientId = undefined;
    runtimeConfig.oidcRedirectUri = undefined;
    mockedOidcSession.beginOidcLogin.mockResolvedValue('started');
    mockedOidcSession.completeOidcLogin.mockResolvedValue(false);
    setApiToken('runtime-only-code');
    mockedApi.getTasks.mockResolvedValue([initialTask]);
    mockedApi.getDelegatedTasks.mockResolvedValue([]);
    mockedApi.getCalendarStatus.mockResolvedValue({
      status: 'disconnected',
      canConnect: true,
      connection: null,
    });
    mockedApi.getCalendarConflicts.mockResolvedValue([]);
    mockedApi.createTask.mockResolvedValue({
      _id: '2',
      title: 'New task',
      description: '',
      urgent: false,
      important: false,
      revision: 1,
    });
    mockedApi.updateTask.mockResolvedValue({ ...initialTask, title: 'Updated title', revision: 8 });
    mockedApi.deleteTask.mockResolvedValue(undefined);
    mockedApi.transitionTaskLifecycle.mockResolvedValue({
      ...initialTask,
      lifecycleState: 'completed',
      revision: 8,
    });
    mockedApi.updateTaskSchedule.mockResolvedValue({
      ...initialTask,
      lifecycleState: 'active',
      revision: 8,
    });
    mockedApi.updateTaskDelegation.mockResolvedValue({
      ...initialTask,
      lifecycleState: 'active',
      revision: 8,
      delegation: {
        assigneeUserId: 'user-b',
        displayLabel: 'Pat',
        handoffNote: '',
        status: 'offered',
        offeredAt: '2026-08-12T12:00:00.000Z',
        statusUpdatedAt: '2026-08-12T12:00:00.000Z',
      },
    });
    mockedApi.transitionTaskDelegation.mockResolvedValue({
      ...initialTask,
      lifecycleState: 'active',
      revision: 8,
      delegation: {
        assigneeUserId: 'user-b',
        displayLabel: 'Pat',
        handoffNote: '',
        status: 'accepted',
        offeredAt: '2026-08-12T12:00:00.000Z',
        statusUpdatedAt: '2026-08-12T12:05:00.000Z',
      },
    });
  });

  afterEach(() => {
    act(() => clearApiToken());
    window.history.replaceState({}, document.title, '/');
  });

  it('guides access in plain language and unlocks with an in-memory code', async () => {
    clearApiToken();
    render(<App />);

    const input = screen.getByLabelText('Kod dostępu');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveFocus();
    expect(screen.getByText(/otrzymasz od administratora/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wejdź do systemu' })).toBeDisabled();

    fireEvent.change(input, { target: { value: ' entered-code ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(mockedApi.getTasks).toHaveBeenCalled());
  });

  it('keeps an empty access form locked', () => {
    clearApiToken();
    render(<App />);
    fireEvent.submit(screen.getByLabelText('Kod dostępu').closest('form')!);
    expect(mockedApi.getTasks).not.toHaveBeenCalled();
  });

  it('shows a rejected-code next step and restores focus', () => {
    clearApiToken('rejected');
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent(/nieprawidłowy lub wygasł/i);
    expect(screen.getByLabelText('Kod dostępu')).toHaveFocus();
  });

  it.each([
    ['issuer only', 'https://identity.example/realms/eisenhower', undefined, undefined],
    [
      'issuer and client only',
      'https://identity.example/realms/eisenhower',
      'eisenhower-web',
      undefined,
    ],
  ])(
    'keeps the manual gate for incomplete OIDC config: %s',
    (_name, issuer, clientId, redirectUri) => {
      clearApiToken();
      runtimeConfig.oidcIssuer = issuer;
      runtimeConfig.oidcClientId = clientId;
      runtimeConfig.oidcRedirectUri = redirectUri;
      const view = render(<App />);
      expect(screen.getByLabelText('Kod dostępu')).toBeInTheDocument();
      view.unmount();
    }
  );

  it('starts configured OIDC automatically exactly once under Strict Mode', async () => {
    clearApiToken();
    runtimeConfig.oidcIssuer = 'https://identity.example/realms/eisenhower';
    runtimeConfig.oidcClientId = 'eisenhower-web';
    runtimeConfig.oidcRedirectUri = 'https://app.example/';
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    expect(screen.queryByLabelText('Kod dostępu')).not.toBeInTheDocument();
    await waitFor(() => expect(mockedOidcSession.beginOidcLogin).toHaveBeenCalledTimes(1));
    expect(mockedOidcSession.beginOidcLogin).toHaveBeenCalledWith({
      issuer: runtimeConfig.oidcIssuer,
      clientId: runtimeConfig.oidcClientId,
      redirectUri: runtimeConfig.oidcRedirectUri,
      scopes: runtimeConfig.oidcScopes,
    });
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows the localized recovery surface when authorization startup rejects', async () => {
    clearApiToken();
    runtimeConfig.oidcIssuer = 'https://identity.example/realms/eisenhower';
    runtimeConfig.oidcClientId = 'eisenhower-web';
    runtimeConfig.oidcRedirectUri = 'https://app.example/';
    mockedOidcSession.beginOidcLogin.mockRejectedValueOnce(new Error('navigation rejected'));

    render(<App />);

    expect(
      await screen.findByRole('button', { name: 'Spróbuj zalogować ponownie' })
    ).toBeInTheDocument();
    expect(mockedOidcSession.beginOidcLogin).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Kod dostępu')).not.toBeInTheDocument();
  });

  it('offers recovery when a prior document already started authorization', async () => {
    clearApiToken();
    runtimeConfig.oidcIssuer = 'https://identity.example/realms/eisenhower';
    runtimeConfig.oidcClientId = 'eisenhower-web';
    runtimeConfig.oidcRedirectUri = 'https://app.example/';
    mockedOidcSession.beginOidcLogin.mockResolvedValueOnce('already-started');

    render(<App />);

    expect(
      await screen.findByRole('button', { name: 'Spróbuj zalogować ponownie' })
    ).toBeInTheDocument();
    expect(mockedOidcSession.beginOidcLogin).toHaveBeenCalledTimes(1);
  });

  it('completes a valid OIDC callback without starting another authorization request', async () => {
    clearApiToken();
    runtimeConfig.oidcIssuer = 'https://identity.example/realms/eisenhower';
    runtimeConfig.oidcClientId = 'eisenhower-web';
    runtimeConfig.oidcRedirectUri = 'https://app.example/';
    window.history.replaceState({}, document.title, '/?code=valid&state=bound');
    mockedOidcSession.completeOidcLogin.mockImplementationOnce(async () => {
      setApiToken('oidc-token');
      return true;
    });
    render(<App />);
    expect(await screen.findByText('Existing task')).toBeInTheDocument();
    expect(mockedOidcSession.beginOidcLogin).not.toHaveBeenCalled();
  });

  it('offers recovery when an OIDC callback cannot be completed', async () => {
    clearApiToken();
    runtimeConfig.oidcIssuer = 'https://identity.example/realms/eisenhower';
    runtimeConfig.oidcClientId = 'eisenhower-web';
    runtimeConfig.oidcRedirectUri = 'https://app.example/';
    window.history.replaceState({}, document.title, '/?code=missing-state');
    mockedOidcSession.completeOidcLogin.mockResolvedValueOnce(false);

    render(<App />);

    expect(
      await screen.findByRole('button', { name: 'Spróbuj zalogować ponownie' })
    ).toBeInTheDocument();
    expect(mockedOidcSession.beginOidcLogin).not.toHaveBeenCalled();
  });

  it('shows localized OIDC recovery after a rejected callback without manual-token copy', async () => {
    clearApiToken();
    runtimeConfig.oidcIssuer = 'https://identity.example/realms/eisenhower';
    runtimeConfig.oidcClientId = 'eisenhower-web';
    runtimeConfig.oidcRedirectUri = 'https://app.example/';
    window.history.replaceState({}, document.title, '/?error=access_denied');

    render(<App />);

    expect(
      await screen.findByRole('button', { name: 'Spróbuj zalogować ponownie' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Kod dostępu')).not.toBeInTheDocument();
    expect(screen.queryByText(/kod dostępu|pamięci karty/i)).not.toBeInTheDocument();
    expect(mockedOidcSession.beginOidcLogin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByRole('button', { name: 'Try signing in again' })).toBeInTheDocument();
  });

  it('resets a failed OIDC attempt before one deliberate retry', async () => {
    clearApiToken();
    runtimeConfig.oidcIssuer = 'https://identity.example/realms/eisenhower';
    runtimeConfig.oidcClientId = 'eisenhower-web';
    runtimeConfig.oidcRedirectUri = 'https://app.example/';
    window.history.replaceState({}, document.title, '/?error=access_denied');

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Spróbuj zalogować ponownie' }));

    await waitFor(() => expect(mockedOidcSession.beginOidcLogin).toHaveBeenCalledTimes(1));
    expect(mockedOidcSession.resetOidcLoginAttempt).toHaveBeenCalledTimes(1);
    expect(mockedOidcSession.resetOidcLoginAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      mockedOidcSession.beginOidcLogin.mock.invocationCallOrder[0]
    );
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
  });

  it('exposes the same recovery surface when PKCE callback validation fails', async () => {
    clearApiToken();
    runtimeConfig.oidcIssuer = 'https://identity.example/realms/eisenhower';
    runtimeConfig.oidcClientId = 'eisenhower-web';
    runtimeConfig.oidcRedirectUri = 'https://app.example/';
    window.history.replaceState({}, document.title, '/?code=rejected&state=wrong');
    mockedOidcSession.completeOidcLogin.mockRejectedValueOnce(new Error('invalid state'));

    render(<App />);
    expect(
      await screen.findByRole('button', { name: 'Spróbuj zalogować ponownie' })
    ).toBeInTheDocument();
    expect(mockedOidcSession.beginOidcLogin).not.toHaveBeenCalled();
  });

  it('loads tasks, reports a confirmed fresh state and keeps technical administration hidden', async () => {
    render(<App />);
    expect(screen.getByText('board-loading')).toBeInTheDocument();
    expect(await screen.findByText('Existing task')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/dane są aktualne/i);
    fireEvent.click(screen.getByRole('button', { name: 'Odśwież tablicę' }));
    await waitFor(() => expect(mockedApi.getTasks).toHaveBeenCalledTimes(2));

    expect(screen.queryByRole('button', { name: 'Administracja' })).not.toBeInTheDocument();
    expect(screen.queryByText(/provider|model|retrain|n8n|outbox/i)).not.toBeInTheDocument();
  });

  it('separates tasks, integrations, and account security into explicit sections', async () => {
    runtimeConfig.oidcIssuer = 'https://identity.example/realms/eisenhower';
    mockedOidcSession.buildAccountManagementUrl.mockReturnValue(
      'https://identity.example/realms/eisenhower/account'
    );
    render(<App />);
    await screen.findByText('Existing task');

    expect(screen.getByRole('button', { name: 'Zadania' })).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.queryByRole('heading', { name: 'Synchronizacja kalendarza' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Integracje' }));
    expect(await screen.findByRole('heading', { name: 'Synchronizacja kalendarza' })).toBeVisible();
    expect(screen.queryByLabelText('Test board')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Konto i bezpieczeństwo' }));
    expect(screen.getByRole('heading', { name: 'Konto i bezpieczeństwo' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Polski' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Zmień lub zresetuj hasło' })).toHaveAttribute(
      'href',
      'https://identity.example/realms/eisenhower/account'
    );
    expect(screen.getByRole('button', { name: 'Wyloguj' })).toBeVisible();
  });

  it('shows offline state, never claims freshness and retries locally', async () => {
    mockedApi.getTasks.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/brak połączenia/i));
    expect(screen.queryByText(/dane są aktualne/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    await screen.findByText('Existing task');
    expect(mockedApi.getTasks).toHaveBeenCalledTimes(2);
  });

  it('maps generic, forbidden and unauthorized load failures to safe local guidance', async () => {
    const cases = [
      [new Error('raw server detail'), /nie udało się pobrać/i],
      [Object.assign(new Error('raw forbidden'), { status: 403 }), /nie masz uprawnień/i],
      [Object.assign(new Error('raw unauthorized'), { status: 401 }), /kod jest nieprawidłowy/i],
    ] as const;

    for (const [failure, message] of cases) {
      mockedApi.getTasks.mockRejectedValueOnce(failure);
      const view = render(<App />);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
      expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('reacts to browser offline and online events and removes listeners on unmount', async () => {
    const view = render(<App />);
    await screen.findByText('Existing task');
    fireEvent(window, new Event('offline'));
    expect(screen.getByRole('alert')).toHaveTextContent(/brak połączenia/i);
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(mockedApi.getTasks).toHaveBeenCalledTimes(2));
    view.unmount();
    fireEvent(window, new Event('online'));
    expect(mockedApi.getTasks).toHaveBeenCalledTimes(2);
  });

  it('creates, edits and deletes using the current revision', async () => {
    render(<App />);
    await screen.findByText('Existing task');
    fireEvent.click(screen.getByText('test-add'));
    expect(await screen.findByText('New task')).toBeInTheDocument();
    fireEvent.click(screen.getByText('test-update'));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith('1', { title: 'Updated title' }, 7)
    );
    expect(await screen.findByText('Updated title')).toBeInTheDocument();
    fireEvent.click(screen.getByText('test-delete'));
    await waitFor(() => expect(mockedApi.deleteTask).toHaveBeenCalledWith('1', 8));
    await waitFor(() => expect(screen.queryByText('Updated title')).not.toBeInTheDocument());
  });

  it('uses revision-less compatibility only when the server omitted a revision', async () => {
    mockedApi.getTasks.mockResolvedValueOnce([{ ...initialTask, revision: undefined }]);
    render(<App />);
    await screen.findByText('Existing task');
    fireEvent.click(screen.getByText('test-update'));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith('1', { title: 'Updated title' }, undefined)
    );
  });

  it('runs lifecycle, schedule and delegation workflows from the compact board', async () => {
    render(<App />);
    await screen.findByText('Existing task');

    fireEvent.click(screen.getByText('test-lifecycle'));
    await waitFor(() => expect(screen.queryByText('Existing task')).not.toBeInTheDocument());
    fireEvent.click(screen.getByText('test-filter-all'));
    await waitFor(() => expect(mockedApi.getTasks).toHaveBeenLastCalledWith('all'));
    fireEvent.click(screen.getByText('test-lifecycle'));
    await waitFor(() =>
      expect(mockedApi.transitionTaskLifecycle).toHaveBeenCalledWith('1', 'complete', 7)
    );
    fireEvent.click(screen.getByText('test-schedule'));
    await waitFor(() => expect(mockedApi.updateTaskSchedule).toHaveBeenCalledWith('1', null, 8));
    fireEvent.click(screen.getByText('test-delegation'));
    await waitFor(() => expect(mockedApi.updateTaskDelegation).toHaveBeenCalled());
    fireEvent.click(screen.getByText('test-delegation-status'));
    await waitFor(() => expect(mockedApi.transitionTaskDelegation).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Delegowane do mnie' }));
    await waitFor(() => expect(mockedApi.getDelegatedTasks).toHaveBeenCalled());
  });

  it('maps workflow failures to safe local errors', async () => {
    mockedApi.transitionTaskLifecycle.mockRejectedValueOnce('offline');
    mockedApi.updateTaskSchedule.mockRejectedValueOnce('offline');
    mockedApi.updateTaskDelegation.mockRejectedValueOnce('offline');
    mockedApi.transitionTaskDelegation.mockRejectedValueOnce('offline');
    render(<App />);
    await screen.findByText('Existing task');

    for (const action of [
      'test-lifecycle',
      'test-schedule',
      'test-delegation',
      'test-delegation-status',
    ]) {
      fireEvent.click(screen.getByText(action));
      await act(async () => Promise.resolve());
    }

    expect(mockedApi.transitionTaskLifecycle).toHaveBeenCalled();
    expect(mockedApi.updateTaskSchedule).toHaveBeenCalled();
    expect(mockedApi.updateTaskDelegation).toHaveBeenCalled();
    expect(mockedApi.transitionTaskDelegation).toHaveBeenCalled();
  });

  it('returns understandable mutation failures while preserving server conflict semantics', async () => {
    render(<App />);
    await screen.findByText('Existing task');

    mockedApi.createTask.mockRejectedValueOnce('unknown');
    fireEvent.click(screen.getByText('test-add'));

    mockedApi.updateTask.mockRejectedValueOnce(
      Object.assign(new Error('raw conflict'), { status: 412 })
    );
    fireEvent.click(screen.getByText('test-update'));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalled());

    mockedApi.deleteTask.mockRejectedValueOnce(
      Object.assign(new Error('raw forbidden'), { status: 403 })
    );
    fireEvent.click(screen.getByText('test-delete'));
    await waitFor(() => expect(mockedApi.deleteTask).toHaveBeenCalled());
  });

  it('logs out without persisting the access code', async () => {
    render(<App />);
    await screen.findByText('Existing task');
    fireEvent.click(screen.getByRole('button', { name: 'Konto i bezpieczeństwo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wyloguj' }));
    expect(screen.getByLabelText('Kod dostępu')).toBeInTheDocument();
    expect(localStorage.getItem('api-token')).toBeNull();
  });
});
