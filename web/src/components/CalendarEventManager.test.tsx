import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../i18n/LanguageContext';
import * as api from '../services/api';
import CalendarEventManager from './CalendarEventManager';

jest.mock('../services/api');
const mockedApi = jest.mocked(api);

it('imports only selected events and confirms a previewed manual link direction', async () => {
  localStorage.setItem('eisenhower-language', 'pl');
  mockedApi.getTasks.mockResolvedValue([
    {
      _id: 'task-1',
      title: 'Local task',
      description: '',
      urgent: false,
      important: true,
      lifecycleState: 'active',
      revision: 2,
    },
  ]);
  mockedApi.getCalendarEvents.mockResolvedValue({
    events: [
      {
        id: 'event-1',
        etag: 'etag-1',
        title: 'Google event',
        start: '2026-08-20T12:00:00.000Z',
        end: '2026-08-20T12:30:00.000Z',
        timeZone: 'Europe/Warsaw',
      },
      {
        id: 'event-2',
        etag: 'etag-2',
        title: 'Do not import',
        start: '2026-08-21T12:00:00.000Z',
        end: '2026-08-21T12:30:00.000Z',
        timeZone: 'Europe/Warsaw',
      },
    ],
  });
  mockedApi.importCalendarEvents.mockResolvedValue({
    results: [{ providerEventId: 'event-1', status: 'imported', taskId: 'task-new' }],
  });
  mockedApi.previewCalendarLink.mockResolvedValue({
    task: { id: 'task-1', title: 'Local task', revision: 2, schedule: null },
    event: {
      id: 'event-2',
      etag: 'etag-2',
      title: 'Do not import',
      start: '2026-08-21T12:00:00.000Z',
      end: '2026-08-21T12:30:00.000Z',
      timeZone: 'Europe/Warsaw',
    },
    googleToEisenhower: {
      title: 'Do not import',
      schedule: {
        dueAt: '2026-08-21T12:00:00.000Z',
        timeZone: 'Europe/Warsaw',
        durationMinutes: 30,
      },
    },
    eisenhowerToGoogle: { title: 'Local task', schedule: null },
  });
  mockedApi.createCalendarLink.mockResolvedValue({
    outcome: 'linked',
    taskId: 'task-1',
    taskRevision: 3,
  });

  render(
    <LanguageProvider>
      <CalendarEventManager />
    </LanguageProvider>
  );
  expect(await screen.findByRole('checkbox', { name: /Google event/ })).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: /Google event/ }));
  fireEvent.click(screen.getByRole('button', { name: /importuj wybrane/i }));
  await waitFor(() =>
    expect(mockedApi.importCalendarEvents).toHaveBeenCalledWith(['event-1'], expect.any(String))
  );

  fireEvent.change(screen.getByLabelText(/zadanie Eisenhower/i), { target: { value: 'task-1' } });
  fireEvent.change(screen.getByLabelText(/wydarzenie Google/i), { target: { value: 'event-2' } });
  fireEvent.click(screen.getByRole('button', { name: /pokaż różnice/i }));
  fireEvent.click(await screen.findByRole('button', { name: /użyj.*Google/i }));
  await waitFor(() =>
    expect(mockedApi.createCalendarLink).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        providerEventId: 'event-2',
        providerEtag: 'etag-2',
        direction: 'google_to_eisenhower',
        taskRevision: 2,
        idempotencyKey: expect.any(String),
      })
    )
  );
});
