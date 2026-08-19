import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../i18n/LanguageContext';
import * as api from '../services/api';
import CalendarEventManager from './CalendarEventManager';

jest.mock('../services/api');
const mockedApi = jest.mocked(api);

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

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

it('keeps failed selections for an idempotent partial-import retry', async () => {
  localStorage.setItem('eisenhower-language', 'en');
  mockedApi.getTasks.mockResolvedValue([]);
  mockedApi.getCalendarEvents.mockResolvedValue({
    events: [
      {
        id: 'event-1',
        etag: 'e1',
        title: 'First',
        start: '2026-08-20T12:00:00.000Z',
        end: '2026-08-20T12:30:00.000Z',
        timeZone: 'UTC',
      },
      {
        id: 'event-2',
        etag: 'e2',
        title: 'Second',
        start: '2026-08-21T12:00:00.000Z',
        end: '2026-08-21T12:30:00.000Z',
        timeZone: 'UTC',
      },
    ],
  });
  mockedApi.importCalendarEvents
    .mockResolvedValueOnce({
      results: [
        { providerEventId: 'event-1', status: 'failed', error: 'offline' },
        { providerEventId: 'event-2', status: 'duplicate' },
      ],
    })
    .mockResolvedValueOnce({
      results: [{ providerEventId: 'event-1', status: 'imported', taskId: 'task-new' }],
    });
  render(
    <LanguageProvider>
      <CalendarEventManager />
    </LanguageProvider>
  );

  const first = await screen.findByRole('checkbox', { name: /First/ });
  const second = screen.getByRole('checkbox', { name: /Second/ });
  fireEvent.click(first);
  fireEvent.click(first);
  fireEvent.click(first);
  fireEvent.click(second);
  fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
  await waitFor(() =>
    expect(screen.queryByRole('checkbox', { name: /Second/ })).not.toBeInTheDocument()
  );
  const firstKey = mockedApi.importCalendarEvents.mock.calls[0][1];
  expect(screen.getByRole('checkbox', { name: /First/ })).toBeChecked();

  fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
  await waitFor(() => expect(mockedApi.importCalendarEvents).toHaveBeenCalledTimes(2));
  expect(mockedApi.importCalendarEvents.mock.calls[1][1]).toBe(firstKey);
});

it('reports loading, import, preview and link failures and reuses the link key for retry', async () => {
  localStorage.setItem('eisenhower-language', 'en');
  mockedApi.getTasks.mockResolvedValueOnce([
    {
      _id: 'task-1',
      title: 'Local',
      description: '',
      urgent: false,
      important: true,
      lifecycleState: 'active',
      revision: 1,
    },
  ]);
  mockedApi.getCalendarEvents.mockResolvedValueOnce({
    events: [
      {
        id: 'event-1',
        etag: 'e1',
        title: 'Remote',
        start: '2026-08-20T12:00:00.000Z',
        end: '2026-08-20T12:30:00.000Z',
        timeZone: 'UTC',
      },
    ],
  });
  mockedApi.importCalendarEvents.mockRejectedValueOnce(new Error('offline'));
  mockedApi.previewCalendarLink
    .mockRejectedValueOnce(new Error('preview offline'))
    .mockResolvedValueOnce({
      task: {
        id: 'task-1',
        title: 'Local',
        revision: 1,
        schedule: { dueAt: '2026-08-20T10:00:00.000Z', timeZone: 'UTC', durationMinutes: 30 },
      },
      event: {
        id: 'event-1',
        etag: 'e1',
        title: 'Remote',
        start: '2026-08-20T12:00:00.000Z',
        end: '2026-08-20T12:30:00.000Z',
        timeZone: 'UTC',
      },
      googleToEisenhower: {
        title: 'Remote',
        schedule: { dueAt: '2026-08-20T12:00:00.000Z', timeZone: 'UTC', durationMinutes: 30 },
      },
      eisenhowerToGoogle: {
        title: 'Local',
        schedule: { dueAt: '2026-08-20T10:00:00.000Z', timeZone: 'UTC', durationMinutes: 30 },
      },
    });
  mockedApi.createCalendarLink
    .mockRejectedValueOnce(new Error('link offline'))
    .mockResolvedValueOnce({ outcome: 'linked', taskId: 'task-1', taskRevision: 1 });
  render(
    <LanguageProvider>
      <CalendarEventManager />
    </LanguageProvider>
  );

  const checkbox = await screen.findByRole('checkbox', { name: /Remote/ });
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
  expect(await screen.findByRole('status')).toBeVisible();

  fireEvent.change(screen.getByLabelText('Eisenhower task'), { target: { value: 'task-1' } });
  fireEvent.change(screen.getByLabelText('Google event'), { target: { value: 'event-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview differences' }));
  await waitFor(() => expect(mockedApi.previewCalendarLink).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Preview differences' }));
  const keep = await screen.findByRole('button', { name: 'Keep Eisenhower' });
  fireEvent.click(keep);
  await waitFor(() => expect(mockedApi.createCalendarLink).toHaveBeenCalledTimes(1));
  const linkKey = mockedApi.createCalendarLink.mock.calls[0][0].idempotencyKey;
  fireEvent.click(screen.getByRole('button', { name: 'Keep Eisenhower' }));
  await waitFor(() => expect(mockedApi.createCalendarLink).toHaveBeenCalledTimes(2));
  expect(mockedApi.createCalendarLink.mock.calls[1][0].idempotencyKey).toBe(linkKey);
});

it('handles malformed or unavailable initial event data without an implicit import', async () => {
  localStorage.setItem('eisenhower-language', 'en');
  mockedApi.getTasks.mockResolvedValueOnce({} as never);
  mockedApi.getCalendarEvents.mockResolvedValueOnce({ events: null } as never);
  const { unmount } = render(
    <LanguageProvider>
      <CalendarEventManager />
    </LanguageProvider>
  );
  await waitFor(() => expect(mockedApi.getCalendarEvents).toHaveBeenCalled());
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  unmount();

  mockedApi.getTasks.mockRejectedValueOnce(new Error('offline'));
  mockedApi.getCalendarEvents.mockResolvedValueOnce({ events: [] });
  render(
    <LanguageProvider>
      <CalendarEventManager />
    </LanguageProvider>
  );
  expect(await screen.findByRole('status')).toBeVisible();
  expect(mockedApi.importCalendarEvents).not.toHaveBeenCalled();
});
