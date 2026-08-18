import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CalendarSyncPanel, {
  DEFAULT_CALENDAR_MAX_POLL_ATTEMPTS,
  DEFAULT_CALENDAR_POLL_INTERVAL_MS,
} from './CalendarSyncPanel';
import * as api from '../services/api';
import { LanguageProvider } from '../i18n/LanguageContext';

jest.mock('../services/api');
const mockedApi = jest.mocked(api);

describe('CalendarSyncPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockedApi.getCalendarStatus.mockResolvedValue({
      status: 'connected',
      canConnect: true,
      failedSyncCount: 0,
      syncProblem: false,
      connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
      openConflicts: 1,
      pendingOutbox: 0,
    });
    mockedApi.getCalendarConflicts.mockResolvedValue([
      {
        _id: 'conflict-1',
        taskId: 'task-1',
        status: 'open',
        revision: 2,
        providerSnapshot: {
          title: 'Google title',
          dueAt: '2026-08-20T12:00:00.000Z',
          timeZone: 'Europe/Warsaw',
        },
      },
    ]);
    mockedApi.getCalendarDeletedBindings.mockResolvedValue([]);
    mockedApi.getTasks.mockResolvedValue([]);
    mockedApi.getCalendarEvents.mockResolvedValue({ events: [] });
    mockedApi.requestCalendarSync.mockResolvedValue({ eventId: 'sync-1' });
    mockedApi.startCalendarConnection.mockResolvedValue({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=safe',
    });
    mockedApi.disconnectCalendar.mockResolvedValue(undefined);
    mockedApi.resolveCalendarConflict.mockResolvedValue({
      _id: 'conflict-1',
      taskId: 'task-1',
      status: 'resolved_local',
      revision: 3,
      providerSnapshot: {
        title: 'Google title',
        dueAt: '2026-08-20T12:00:00.000Z',
        timeZone: 'Europe/Warsaw',
      },
    });
  });

  it('shows honest connection state, requests sync and resolves conflicts explicitly', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );
    expect(await screen.findByText(/wymagają Twojej decyzji|need your decision/i)).toBeVisible();
    expect(screen.getByText('Google title')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /synchronizuj teraz/i }));
    await waitFor(() =>
      expect(mockedApi.requestCalendarSync).toHaveBeenCalledWith(expect.any(String))
    );

    fireEvent.click(screen.getByRole('button', { name: /zachowaj Eisenhower/i }));
    await waitFor(() =>
      expect(mockedApi.resolveCalendarConflict).toHaveBeenCalledWith(
        'conflict-1',
        'eisenhower',
        2,
        expect.any(String)
      )
    );
    expect(screen.queryByText('Google title')).not.toBeInTheDocument();
  });

  it('offers three explicit outcomes when Google deleted a linked event', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    mockedApi.getCalendarDeletedBindings.mockResolvedValueOnce([
      {
        _id: 'binding-1',
        taskId: 'task-1',
        taskTitle: 'Prepare release',
        taskRevision: 4,
        providerEventId: 'event-1',
        providerDeletedAt: '2026-08-20T12:00:00.000Z',
      },
    ]);
    mockedApi.resolveCalendarDeletedBinding.mockResolvedValue({
      outcome: 'recreate',
      taskId: 'task-1',
      taskRevision: 4,
    });

    render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );

    expect(await screen.findByText('Prepare release')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Usuń datę zadania' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Odłącz powiązanie' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Odtwórz w Google' }));
    await waitFor(() =>
      expect(mockedApi.resolveCalendarDeletedBinding).toHaveBeenCalledWith(
        'binding-1',
        'recreate',
        4,
        expect.any(String)
      )
    );
    expect(screen.queryByText('Prepare release')).not.toBeInTheDocument();
  });

  it('keeps the panel usable and reports a failed sync request', async () => {
    mockedApi.requestCalendarSync.mockRejectedValueOnce(new Error('sync unavailable'));

    render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );
    expect(
      await screen.findByRole('button', { name: /sync now|synchronizuj teraz/i })
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /sync now|synchronizuj teraz/i }));

    expect(await screen.findByRole('status')).not.toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: /sync now|synchronizuj teraz/i })).toBeEnabled();
  });

  it('supports the Google conflict strategy and reports a failed resolution', async () => {
    mockedApi.resolveCalendarConflict.mockRejectedValueOnce(new Error('resolution unavailable'));

    render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );
    expect(await screen.findByText('Google title')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /use Google|użyj zmiany Google/i }));

    await waitFor(() =>
      expect(mockedApi.resolveCalendarConflict).toHaveBeenCalledWith(
        'conflict-1',
        'google',
        2,
        expect.any(String)
      )
    );
    expect(await screen.findByRole('status')).not.toBeEmptyDOMElement();
    expect(screen.getByText('Google title')).toBeVisible();
  });

  it('offers accessible connect and disconnect actions in business language', async () => {
    mockedApi.getCalendarStatus.mockResolvedValueOnce({
      status: 'disconnected',
      canConnect: true,
      failedSyncCount: 0,
      syncProblem: false,
      connection: null,
    });
    const navigate = jest.fn();

    render(
      <LanguageProvider>
        <CalendarSyncPanel navigate={navigate} />
      </LanguageProvider>
    );

    fireEvent.click(
      await screen.findByRole('button', { name: /connect google calendar|połącz google calendar/i })
    );
    await waitFor(() => expect(mockedApi.startCalendarConnection).toHaveBeenCalledWith('/'));
    expect(navigate).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?state=safe');
    expect(screen.queryByText(/outbox|n8n|token|provider|workflow/i)).not.toBeInTheDocument();
  });

  it('does not offer a connection when Calendar is unavailable', async () => {
    mockedApi.getCalendarStatus.mockResolvedValueOnce({
      status: 'disconnected',
      canConnect: false,
      connection: null,
    });
    render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );
    expect(
      await screen.findByText(
        /connection is not available|połączenie kalendarza jest teraz niedostępne/i
      )
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /connect google|połącz google/i })
    ).not.toBeInTheDocument();
  });

  it('uses default browser navigation and explains an unavailable connection start', async () => {
    mockedApi.getCalendarStatus.mockResolvedValue({
      status: 'disconnected',
      canConnect: true,
      connection: null,
    });
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const view = render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );
    fireEvent.click(await screen.findByRole('button', { name: /connect google|połącz google/i }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/auth?state=safe',
        '_self'
      )
    );
    view.unmount();
    open.mockRestore();

    mockedApi.startCalendarConnection.mockRejectedValueOnce({ status: 404 });
    render(
      <LanguageProvider>
        <CalendarSyncPanel navigate={jest.fn()} />
      </LanguageProvider>
    );
    fireEvent.click(await screen.findByRole('button', { name: /connect google|połącz google/i }));
    expect(
      await screen.findByText(
        /connection is not available|połączenie kalendarza jest teraz niedostępne/i
      )
    ).toBeVisible();
  });

  it('rejects an authorization URL outside the approved Google endpoint', async () => {
    mockedApi.getCalendarStatus.mockResolvedValueOnce({
      status: 'disconnected',
      canConnect: true,
      failedSyncCount: 0,
      syncProblem: false,
      connection: null,
    });
    mockedApi.startCalendarConnection.mockResolvedValueOnce({
      authorizationUrl: 'https://evil.example/phishing',
    });
    const navigate = jest.fn();
    render(
      <LanguageProvider>
        <CalendarSyncPanel navigate={navigate} />
      </LanguageProvider>
    );
    fireEvent.click(await screen.findByRole('button', { name: /connect google|połącz google/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /could not be updated|nie udało się zaktualizować/i
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('disconnects only after confirmation and returns to the disconnected state', async () => {
    mockedApi.getCalendarStatus
      .mockResolvedValueOnce({
        status: 'connected',
        canConnect: true,
        failedSyncCount: 0,
        syncProblem: false,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        openConflicts: 0,
        pendingOutbox: 0,
      })
      .mockResolvedValueOnce({ status: 'disconnected', canConnect: true, connection: null });

    render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );

    fireEvent.click(
      await screen.findByRole('button', { name: /disconnect calendar|odłącz kalendarz/i })
    );
    expect(
      screen.getByText(/keep your tasks and stop calendar updates|zachować zadania/i)
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /yes, disconnect|tak, odłącz/i }));
    await waitFor(() => expect(mockedApi.disconnectCalendar).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/not connected|nie jest jeszcze połączony/i)).toBeVisible();
  });

  it('supports cancelling and reports a failed confirmed disconnection', async () => {
    mockedApi.getCalendarStatus.mockResolvedValueOnce({
      status: 'connected',
      canConnect: true,
      connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
      openConflicts: 0,
      pendingOutbox: 0,
    });
    mockedApi.getCalendarConflicts.mockResolvedValueOnce([]);
    mockedApi.disconnectCalendar.mockRejectedValueOnce(new Error('offline'));
    render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /disconnect calendar|odłącz kalendarz/i })
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel|anuluj/i }));
    expect(mockedApi.disconnectCalendar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /disconnect calendar|odłącz kalendarz/i }));
    fireEvent.click(screen.getByRole('button', { name: /yes, disconnect|tak, odłącz/i }));
    expect(await screen.findByRole('status')).not.toBeEmptyDOMElement();
    expect(mockedApi.disconnectCalendar).toHaveBeenCalledTimes(1);
  });

  it('keeps one operation key across a normal retry and accepts omitted counters', async () => {
    mockedApi.getCalendarStatus
      .mockResolvedValueOnce({
        status: 'connected',
        canConnect: true,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        openConflicts: 0,
        pendingOutbox: 0,
      })
      .mockResolvedValueOnce({
        status: 'connected',
        canConnect: true,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
      });
    mockedApi.getCalendarConflicts.mockResolvedValue([]);
    mockedApi.requestCalendarSync
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ eventId: 'sync-2' });
    render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );
    const syncButton = await screen.findByRole('button', {
      name: /sync now|synchronizuj teraz/i,
    });
    fireEvent.click(syncButton);
    await waitFor(() => expect(syncButton).toBeEnabled());
    const firstKey = mockedApi.requestCalendarSync.mock.calls[0][0];
    fireEvent.click(syncButton);
    await waitFor(() => expect(mockedApi.requestCalendarSync).toHaveBeenCalledTimes(2));
    expect(mockedApi.requestCalendarSync.mock.calls[1][0]).toBe(firstKey);
    expect(
      await screen.findByText(/calendar is up to date|kalendarz jest aktualny/i)
    ).toBeVisible();
  });

  it('treats an omitted conflict counter as no conflicts', async () => {
    mockedApi.getCalendarStatus.mockResolvedValueOnce({
      status: 'connected',
      canConnect: true,
      connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
      pendingOutbox: 0,
    });
    mockedApi.getCalendarConflicts.mockResolvedValueOnce([]);
    render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );
    expect(
      await screen.findByText(/calendar is up to date|kalendarz jest aktualny/i)
    ).toBeVisible();
  });

  it('does not update state when the initial status check completes after unmount', async () => {
    let resolveStatus!: (value: Awaited<ReturnType<typeof api.getCalendarStatus>>) => void;
    mockedApi.getCalendarStatus.mockImplementationOnce(
      () => new Promise((resolve) => (resolveStatus = resolve))
    );
    const view = render(
      <LanguageProvider>
        <CalendarSyncPanel />
      </LanguageProvider>
    );
    view.unmount();
    await act(async () =>
      resolveStatus({ status: 'disconnected', canConnect: true, connection: null })
    );
  });

  it('reports a failed background status check', async () => {
    jest.useFakeTimers();
    mockedApi.getCalendarStatus
      .mockResolvedValueOnce({
        status: 'pending',
        canConnect: true,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        pendingOutbox: 1,
      })
      .mockRejectedValueOnce(new Error('offline'));
    mockedApi.getCalendarConflicts.mockResolvedValue([]);
    render(
      <LanguageProvider>
        <CalendarSyncPanel pollIntervalMs={10} maxPollAttempts={2} />
      </LanguageProvider>
    );
    expect(await screen.findByText(/updates are in progress|trwa aktualizowanie/i)).toBeVisible();
    await act(async () => jest.advanceTimersByTimeAsync(10));
    expect(screen.getByRole('status')).not.toBeEmptyDOMElement();
    jest.useRealTimers();
  });

  it('does not schedule another background check after unmount', async () => {
    jest.useFakeTimers();
    let resolveStatus!: (value: Awaited<ReturnType<typeof api.getCalendarStatus>>) => void;
    mockedApi.getCalendarStatus
      .mockResolvedValueOnce({
        status: 'pending',
        canConnect: true,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        pendingOutbox: 1,
      })
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStatus = resolve)));
    mockedApi.getCalendarConflicts.mockResolvedValue([]);
    const view = render(
      <LanguageProvider>
        <CalendarSyncPanel pollIntervalMs={10} maxPollAttempts={2} />
      </LanguageProvider>
    );
    expect(await screen.findByText(/updates are in progress|trwa aktualizowanie/i)).toBeVisible();
    await act(async () => jest.advanceTimersByTimeAsync(10));
    view.unmount();
    await act(async () =>
      resolveStatus({ status: 'disconnected', canConnect: true, connection: null })
    );
    jest.useRealTimers();
  });

  it('polls a bounded number of times while synchronization is in progress', async () => {
    jest.useFakeTimers();
    mockedApi.getCalendarStatus
      .mockResolvedValueOnce({
        status: 'connected',
        canConnect: true,
        failedSyncCount: 0,
        syncProblem: false,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        openConflicts: 0,
        pendingOutbox: 0,
      })
      .mockResolvedValueOnce({
        status: 'pending',
        canConnect: true,
        failedSyncCount: 0,
        syncProblem: false,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        openConflicts: 0,
        pendingOutbox: 1,
      })
      .mockResolvedValue({
        status: 'connected',
        canConnect: true,
        failedSyncCount: 0,
        syncProblem: false,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        syncState: { lastCompletedAt: '2026-08-16T10:00:00.000Z' },
        openConflicts: 0,
        pendingOutbox: 0,
      });

    render(
      <LanguageProvider>
        <CalendarSyncPanel pollIntervalMs={10} maxPollAttempts={3} />
      </LanguageProvider>
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /synchronize now|synchronizuj teraz/i })
    );
    await waitFor(() => expect(mockedApi.requestCalendarSync).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/updates are in progress|trwa aktualizowanie/i)).toBeVisible();
    await act(async () => jest.advanceTimersByTimeAsync(30));
    expect(
      screen.getAllByText(/calendar is up to date|kalendarz jest aktualny/i).length
    ).toBeGreaterThan(0);
    expect(mockedApi.getCalendarStatus.mock.calls.length).toBeLessThanOrEqual(4);
    jest.useRealTimers();
  });

  it('continues bounded polling when an external update is already in progress on mount', async () => {
    jest.useFakeTimers();
    mockedApi.getCalendarStatus
      .mockResolvedValueOnce({
        status: 'pending',
        canConnect: true,
        failedSyncCount: 0,
        syncProblem: false,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        openConflicts: 0,
        pendingOutbox: 1,
      })
      .mockResolvedValue({
        status: 'connected',
        canConnect: true,
        failedSyncCount: 0,
        syncProblem: false,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        openConflicts: 0,
        pendingOutbox: 0,
      });

    render(
      <LanguageProvider>
        <CalendarSyncPanel pollIntervalMs={10} maxPollAttempts={2} />
      </LanguageProvider>
    );
    expect(await screen.findByText(/updates are in progress|trwa aktualizowanie/i)).toBeVisible();
    await act(async () => jest.advanceTimersByTimeAsync(10));
    expect(
      await screen.findByText(/calendar is up to date|kalendarz jest aktualny/i)
    ).toBeVisible();
    expect(mockedApi.requestCalendarSync).not.toHaveBeenCalled();
    expect(mockedApi.getCalendarStatus).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('keeps the default status-checking window open for at least 45 seconds', () => {
    expect(
      DEFAULT_CALENDAR_POLL_INTERVAL_MS * DEFAULT_CALENDAR_MAX_POLL_ATTEMPTS
    ).toBeGreaterThanOrEqual(45_000);
  });

  it.each([
    ['pl', /sprawdź stan ponownie/i],
    ['en', /check status again/i],
  ] as const)(
    'lets a %s user resume status checks after the bounded window without requesting another sync',
    async (language, buttonName) => {
      jest.useFakeTimers();
      localStorage.setItem('eisenhower-language', language);
      mockedApi.getCalendarStatus.mockResolvedValue({
        status: 'pending',
        canConnect: true,
        failedSyncCount: 0,
        syncProblem: false,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        openConflicts: 0,
        pendingOutbox: 1,
      });
      mockedApi.getCalendarConflicts.mockResolvedValue([]);

      render(
        <LanguageProvider>
          <CalendarSyncPanel pollIntervalMs={10} maxPollAttempts={2} />
        </LanguageProvider>
      );
      expect(await screen.findByText(/updates are in progress|trwa aktualizowanie/i)).toBeVisible();

      await act(async () => jest.advanceTimersByTimeAsync(20));
      const resume = await screen.findByRole('button', { name: buttonName });
      expect(mockedApi.getCalendarStatus).toHaveBeenCalledTimes(3);

      fireEvent.click(resume);
      await act(async () => jest.advanceTimersByTimeAsync(10));
      expect(mockedApi.getCalendarStatus).toHaveBeenCalledTimes(4);
      expect(mockedApi.requestCalendarSync).not.toHaveBeenCalled();
      jest.useRealTimers();
    }
  );

  it.each([
    ['pl', /spróbuj ponownie/i, /nie udało się zapisać części zmian/i],
    ['en', /try again/i, /some calendar changes could not be saved/i],
  ] as const)(
    'shows a business recovery action in %s and creates a fresh operation for every failed-sync retry',
    async (language, buttonName, problemText) => {
      localStorage.setItem('eisenhower-language', language);
      mockedApi.getCalendarStatus.mockResolvedValue({
        status: 'connected',
        canConnect: true,
        failedSyncCount: 1,
        syncProblem: true,
        connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
        openConflicts: 0,
        pendingOutbox: 0,
      });
      mockedApi.getCalendarConflicts.mockResolvedValue([]);

      render(
        <LanguageProvider>
          <CalendarSyncPanel />
        </LanguageProvider>
      );

      expect(await screen.findByText(problemText)).toBeVisible();
      expect(
        screen.queryByText(/calendar is up to date|kalendarz jest aktualny/i)
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: buttonName }));
      await waitFor(() => expect(mockedApi.requestCalendarSync).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole('button', { name: buttonName })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: buttonName }));
      await waitFor(() => expect(mockedApi.requestCalendarSync).toHaveBeenCalledTimes(2));

      const firstKey = mockedApi.requestCalendarSync.mock.calls[0][0];
      const secondKey = mockedApi.requestCalendarSync.mock.calls[1][0];
      expect(firstKey).toMatch(/^web-calendar-sync-retry:/);
      expect(secondKey).toMatch(/^web-calendar-sync-retry:/);
      expect(secondKey).not.toBe(firstKey);
    }
  );
});
