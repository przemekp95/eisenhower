import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CalendarSyncPanel from './CalendarSyncPanel';
import * as api from '../services/api';
import { LanguageProvider } from '../i18n/LanguageContext';

jest.mock('../services/api');
const mockedApi = jest.mocked(api);

describe('CalendarSyncPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
