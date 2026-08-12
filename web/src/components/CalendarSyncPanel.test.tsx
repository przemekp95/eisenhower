import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CalendarSyncPanel from './CalendarSyncPanel';
import * as api from '../services/api';
import { LanguageProvider } from '../i18n/LanguageContext';

jest.mock('../services/api');
const mockedApi = jest.mocked(api);

describe('CalendarSyncPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockedApi.getCalendarStatus.mockResolvedValue({
      status: 'connected', connection: { id: 'connection-1', provider: 'google', calendarId: 'primary' },
      openConflicts: 1, pendingOutbox: 0,
    });
    mockedApi.getCalendarConflicts.mockResolvedValue([{
      _id: 'conflict-1', taskId: 'task-1', status: 'open', revision: 2,
      providerSnapshot: { title: 'Google title', dueAt: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw' },
    }]);
    mockedApi.requestCalendarSync.mockResolvedValue({ eventId: 'sync-1' });
    mockedApi.resolveCalendarConflict.mockResolvedValue({
      _id: 'conflict-1', taskId: 'task-1', status: 'resolved_local', revision: 3,
      providerSnapshot: { title: 'Google title', dueAt: '2026-08-20T12:00:00.000Z', timeZone: 'Europe/Warsaw' },
    });
  });

  it('shows honest connection state, requests sync and resolves conflicts explicitly', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    render(<LanguageProvider><CalendarSyncPanel /></LanguageProvider>);
    expect(await screen.findByText(/Google Calendar: primary/i)).toBeVisible();
    expect(screen.getByText('Google title')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /synchronizuj teraz/i }));
    await waitFor(() => expect(mockedApi.requestCalendarSync).toHaveBeenCalledWith(expect.any(String)));

    fireEvent.click(screen.getByRole('button', { name: /zachowaj Eisenhower/i }));
    await waitFor(() => expect(mockedApi.resolveCalendarConflict).toHaveBeenCalledWith(
      'conflict-1', 'eisenhower', 2, expect.any(String)
    ));
    expect(screen.queryByText('Google title')).not.toBeInTheDocument();
  });

  it('keeps the panel usable and reports a failed sync request', async () => {
    mockedApi.requestCalendarSync.mockRejectedValueOnce(new Error('sync unavailable'));

    render(<LanguageProvider><CalendarSyncPanel /></LanguageProvider>);
    expect(await screen.findByText(/Google Calendar: primary/i)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /sync now|synchronizuj teraz/i }));

    expect(await screen.findByRole('status')).not.toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: /sync now|synchronizuj teraz/i })).toBeEnabled();
  });

  it('supports the Google conflict strategy and reports a failed resolution', async () => {
    mockedApi.resolveCalendarConflict.mockRejectedValueOnce(new Error('resolution unavailable'));

    render(<LanguageProvider><CalendarSyncPanel /></LanguageProvider>);
    expect(await screen.findByText('Google title')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /use Google|użyj zmiany Google/i }));

    await waitFor(() => expect(mockedApi.resolveCalendarConflict).toHaveBeenCalledWith(
      'conflict-1', 'google', 2, expect.any(String)
    ));
    expect(await screen.findByRole('status')).not.toBeEmptyDOMElement();
    expect(screen.getByText('Google title')).toBeVisible();
  });
});
