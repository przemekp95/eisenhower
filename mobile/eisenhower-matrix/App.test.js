import React from 'react';
import { AppState } from 'react-native';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import App from './App';
import * as ai from './src/services/ai';
import * as media from './src/services/media';
import * as reminders from './src/services/reminders';
import * as storage from './src/services/storage';
import * as tasksApi from './src/services/tasks';
import { getSampleTasks } from './src/utils/taskUtils';
import { clearApiToken, setApiToken } from './src/authSession';

const mockAddNetworkStateListener = jest.fn();
jest.mock('expo-network', () => ({
  addNetworkStateListener: (...args) => mockAddNetworkStateListener(...args),
}), { virtual: true });

jest.mock('./src/services/ai', () => ({
  suggestTaskQuadrant: jest.fn(),
  analyzeTaskAdvanced: jest.fn(),
  batchAnalyzeTasks: jest.fn(),
  fetchAICapabilities: jest.fn(),
}));

jest.mock('./src/services/media', () => ({
  scanTasksFromImage: jest.fn(),
}));

jest.mock('./src/services/reminders', () => ({
  resyncTaskReminders: jest.fn(async (tasks) => tasks),
  syncTaskReminder: jest.fn(async () => ({ status: 'scheduled', notificationId: 'test-notification' })),
}));

jest.mock('./src/services/storage', () => ({
  loadLanguage: jest.fn(),
  loadDelegatedTasks: jest.fn(),
  loadTasks: jest.fn(),
  saveLanguage: jest.fn(),
  saveDelegatedTasks: jest.fn(),
  saveTasks: jest.fn(),
}));

jest.mock('./src/services/tasks', () => ({
  fetchRemoteTasks: jest.fn(),
  fetchRemoteDelegatedTasks: jest.fn(),
  createRemoteTask: jest.fn(),
  updateRemoteTask: jest.fn(),
  updateRemoteTaskSchedule: jest.fn(),
  updateRemoteTaskDelegation: jest.fn(),
  transitionRemoteTaskDelegation: jest.fn(),
  transitionRemoteTaskLifecycle: jest.fn(),
  deleteRemoteTask: jest.fn(),
  isRemoteTaskId: jest.fn(),
}));

const ASYNC_TIMEOUT = 10_000;

jest.setTimeout(20_000);

function remoteTask(overrides = {}) {
  const resolvedId = overrides.id || '507f1f77bcf86cd799439011';
  return {
    id: resolvedId,
    title: 'Seed task',
    description: 'desc',
    urgent: true,
    important: false,
    locale: 'pl',
    remoteId: resolvedId,
    syncState: 'synced',
    revision: 0,
    lifecycleState: 'active',
    ...overrides,
  };
}

function capabilities(overrides = {}) {
  return {
    classification: true,
    reasoned_local_analysis: true,
    knowledge_retrieval: true,
    retrieval_augmented_generation: true,
    local_similar_examples: true,
    ocr: true,
    batch_analysis: true,
    ...overrides,
  };
}

function findHandler(instance, handlerName) {
  let current = instance;
  while (current) {
    if (typeof current.props?.[handlerName] === 'function') {
      return current.props[handlerName];
    }
    let fiber = current.unstable_fiber;
    while (fiber) {
      if (typeof fiber.memoizedProps?.[handlerName] === 'function') {
        return fiber.memoizedProps[handlerName];
      }
      fiber = fiber.return;
    }
    current = current.parent;
  }
  throw new Error(`Missing ${handlerName} handler`);
}

describe('Mobile App', () => {
afterEach(async () => {
  await cleanup();
  clearApiToken();
});

  beforeEach(() => {
    jest.resetAllMocks();

    storage.loadLanguage.mockResolvedValue('pl');
    storage.loadTasks.mockResolvedValue([remoteTask({ id: 'local-1' })]);
    storage.loadDelegatedTasks.mockResolvedValue([]);
    storage.saveLanguage.mockResolvedValue(undefined);
    storage.saveTasks.mockResolvedValue(undefined);
    storage.saveDelegatedTasks.mockResolvedValue(undefined);
    reminders.resyncTaskReminders.mockImplementation(async (items) => items);
    reminders.syncTaskReminder.mockResolvedValue({
      status: 'scheduled',
      notificationId: 'test-notification',
    });

    tasksApi.fetchRemoteTasks.mockResolvedValue([remoteTask()]);
    tasksApi.fetchRemoteDelegatedTasks.mockResolvedValue([]);
    tasksApi.createRemoteTask.mockImplementation(async (task) => remoteTask(task));
    tasksApi.updateRemoteTask.mockImplementation(async (id, patch) => remoteTask({ id, ...patch }));
    tasksApi.updateRemoteTaskSchedule.mockImplementation(async (id, schedule) => remoteTask({ id, schedule }));
    tasksApi.updateRemoteTaskDelegation.mockImplementation(async (id, delegation) => remoteTask({
      id,
      delegation: delegation ? { ...delegation, status: 'offered' } : undefined,
    }));
    tasksApi.transitionRemoteTaskDelegation.mockImplementation(async (id, status) => ({
      ...remoteTask({ id, delegationRole: 'assignee' }),
      delegation: { assigneeUserId: 'local-user', displayLabel: 'Local', handoffNote: '', status },
    }));
    tasksApi.transitionRemoteTaskLifecycle.mockImplementation(async (id, action) => remoteTask({
      id,
      lifecycleState: {
        complete: 'completed',
        reopen: 'active',
        archive: 'archived',
        trash: 'trashed',
        restore: 'active',
      }[action],
      revision: 1,
    }));
    tasksApi.deleteRemoteTask.mockResolvedValue(undefined);
    tasksApi.isRemoteTaskId.mockImplementation((id) => /^[a-f0-9]{24}$/i.test(String(id)));

    ai.suggestTaskQuadrant.mockResolvedValue({ urgent: true, important: true, source: 'central' });
    ai.analyzeTaskAdvanced.mockResolvedValue({
      task: 'Prepare roadmap',
      langchain_analysis: {
        quadrant: 0,
        reasoning: 'Pilne i ważne przez deadline i wpływ biznesowy.',
        confidence: 0.91,
        method: 'local-analysis',
      },
      rag_classification: {
        quadrant: 0,
        quadrant_name: 'Zrób teraz',
        confidence: 0.91,
      },
      comparison: {
        methods_agree: true,
        confidence_difference: 0,
      },
    });
    ai.batchAnalyzeTasks.mockResolvedValue({
      batch_results: [
        { task: 'Task A', analyses: { rag: { quadrant: 0 }, langchain: { quadrant: 0 } } },
        { task: 'Task B', analyses: { rag: { quadrant: 2 }, langchain: { quadrant: 2 } } },
      ],
      summary: { total_tasks: 2 },
    });
    ai.fetchAICapabilities.mockResolvedValue(capabilities());
    media.scanTasksFromImage.mockResolvedValue([]);
    setApiToken('runtime-only-test-token');
  });

  it('keeps remote data locked until a runtime-only token is entered', async () => {
    clearApiToken();

    const { getByTestId, queryByText } = await render(<App />);

    expect(queryByText('Seed task')).toBeNull();
    await fireEvent.changeText(getByTestId('auth-token-input'), 'entered-at-runtime');
    await fireEvent.press(getByTestId('auth-submit-button'));

    await waitFor(() => expect(tasksApi.fetchRemoteTasks).toHaveBeenCalled(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('does not publish bootstrap results after the screen is unmounted', async () => {
    clearApiToken();
    let resolveLanguage;
    storage.loadLanguage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLanguage = resolve;
      })
    );

    const view = await render(<App />);
    await fireEvent.changeText(view.getByTestId('auth-token-input'), 'runtime-token');
    await fireEvent.press(view.getByTestId('auth-submit-button'));
    await view.unmount();
    await act(async () => resolveLanguage('pl'));

    expect(tasksApi.fetchRemoteTasks).not.toHaveBeenCalled();
  });

  it('requires only an access token for CRUD and supports explicit logout', async () => {
    clearApiToken();
    const { getByTestId, queryByTestId } = await render(<App />);

    expect(queryByTestId('admin-token-input')).toBeNull();
    await fireEvent.changeText(getByTestId('auth-token-input'), 'access-only');
    await fireEvent.press(getByTestId('auth-submit-button'));
    await waitFor(() => expect(getByTestId('logout-button')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId('logout-button'));
    await waitFor(() => expect(getByTestId('auth-token-input')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
  });

  it('offers manual retry and preserves pending work when retry still fails', async () => {
    storage.loadTasks.mockResolvedValue([{ id: 'local-retry', title: 'Pending', urgent: true, important: false }]);
    tasksApi.fetchRemoteTasks.mockRejectedValue(new Error('offline'));
    const { getByTestId } = await render(<App />);

    await waitFor(() => expect(getByTestId('retry-sync-button')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId('retry-sync-button'));
    await waitFor(() => expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledTimes(2), { timeout: ASYNC_TIMEOUT });
    expect(getByTestId('sync-pending-local-retry')).toBeTruthy();
  });

  it('retries pending sync when the app returns to the foreground', async () => {
    let onAppStateChange;
    const appStateSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
      onAppStateChange = listener;
      return { remove: jest.fn() };
    });
    storage.loadTasks.mockResolvedValue([{ id: 'local-foreground', title: 'Pending foreground', urgent: true, important: false }]);
    tasksApi.fetchRemoteTasks
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);
    tasksApi.createRemoteTask.mockResolvedValueOnce(remoteTask({ title: 'Pending foreground' }));

    const { getByText } = await render(<App />);
    await waitFor(() => expect(onAppStateChange).toBeDefined(), { timeout: ASYNC_TIMEOUT });
    await waitFor(() => expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledTimes(1), { timeout: ASYNC_TIMEOUT });
    await waitFor(() => expect(getByText('Pending foreground')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await act(async () => {
      onAppStateChange('active');
    });

    await waitFor(() => expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledTimes(2), { timeout: ASYNC_TIMEOUT });
    await waitFor(() => expect(tasksApi.createRemoteTask).toHaveBeenCalled(), { timeout: ASYNC_TIMEOUT });
    appStateSpy.mockRestore();
  });

  it('retries pending sync when internet reachability returns while still foreground', async () => {
    let onNetworkStateChange;
    mockAddNetworkStateListener.mockImplementation((listener) => {
      onNetworkStateChange = listener;
      return { remove: jest.fn() };
    });
    storage.loadTasks.mockResolvedValue([{ id: 'local-network', title: 'Pending network', urgent: true, important: false }]);
    tasksApi.fetchRemoteTasks
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);
    tasksApi.createRemoteTask.mockResolvedValueOnce(remoteTask({ title: 'Pending network' }));

    const { getByText } = await render(<App />);
    await waitFor(() => expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledTimes(1), { timeout: ASYNC_TIMEOUT });
    await waitFor(() => expect(getByText('Pending network')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    expect(onNetworkStateChange).toBeDefined();

    await act(async () => {
      onNetworkStateChange({ isConnected: false, isInternetReachable: false });
      onNetworkStateChange({ isConnected: true, isInternetReachable: true });
    });

    await waitFor(() => expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledTimes(2), { timeout: ASYNC_TIMEOUT });
    await waitFor(() => expect(tasksApi.createRemoteTask).toHaveBeenCalled(), { timeout: ASYNC_TIMEOUT });
  });

  it('coalesces bootstrap, foreground, network, and manual sync triggers', async () => {
    let onAppStateChange;
    let onNetworkStateChange;
    let resolveRemoteTasks;
    const appStateSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      onAppStateChange = listener;
      return { remove: jest.fn() };
    });
    mockAddNetworkStateListener.mockImplementation((listener) => {
      onNetworkStateChange = listener;
      return { remove: jest.fn() };
    });
    storage.loadTasks.mockResolvedValue([{
      id: 'local-single-flight',
      title: 'One operation',
      syncState: 'pending_create',
    }]);
    tasksApi.fetchRemoteTasks.mockReturnValue(new Promise((resolve) => {
      resolveRemoteTasks = resolve;
    }));
    tasksApi.createRemoteTask.mockResolvedValue(remoteTask({ title: 'One operation' }));

    const { getByTestId } = await render(<App />);
    await waitFor(() => expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledTimes(1), { timeout: ASYNC_TIMEOUT });
    await waitFor(() => expect(onAppStateChange).toBeDefined(), { timeout: ASYNC_TIMEOUT });
    await waitFor(() => expect(onNetworkStateChange).toBeDefined(), { timeout: ASYNC_TIMEOUT });

    await act(async () => {
      const retryPromise = findHandler(getByTestId('retry-sync-button'), 'onPress')();
      onAppStateChange('active');
      onNetworkStateChange({ isConnected: false, isInternetReachable: false });
      onNetworkStateChange({ isConnected: true, isInternetReachable: true });
      expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledTimes(1);
      resolveRemoteTasks([]);
      await retryPromise;
    });
    await waitFor(() => expect(tasksApi.createRemoteTask).toHaveBeenCalledTimes(1), { timeout: ASYNC_TIMEOUT });
    appStateSpy.mockRestore();
  });

  it('keeps the fresh server version when the user resolves an update conflict remotely', async () => {
    const id = '507f1f77bcf86cd799439081';
    storage.loadTasks.mockResolvedValue([{
      id,
      remoteId: id,
      title: 'Server value',
      description: 'fresh',
      urgent: false,
      important: true,
      revision: 8,
      syncState: 'conflict',
      syncError: 'conflict',
      pendingIntent: {
        type: 'update',
        baseRevision: 7,
        payload: { title: 'My edit', description: 'local', urgent: true, important: false },
      },
    }]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([remoteTask({
      id,
      title: 'Server value',
      description: 'fresh',
      urgent: false,
      important: true,
      revision: 8,
    })]);

    const { getByTestId, getByText, queryByTestId } = await render(<App />);
    await waitFor(() => expect(getByText('Server value')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId(`conflict-keep-remote-${id}`));

    await waitFor(() => expect(queryByTestId(`conflict-keep-remote-${id}`)).toBeNull(), { timeout: ASYNC_TIMEOUT });
    expect(storage.saveTasks).toHaveBeenLastCalledWith([
      expect.objectContaining({ id, title: 'Server value', revision: 8, syncState: 'synced' }),
    ]);
    expect(tasksApi.updateRemoteTask).not.toHaveBeenCalled();
  });

  it('retries a local update only after explicit conflict resolution using the fresh revision', async () => {
    const id = '507f1f77bcf86cd799439082';
    const conflict = {
      id,
      remoteId: id,
      title: 'Server value',
      description: 'fresh',
      urgent: false,
      important: true,
      revision: 8,
      syncState: 'conflict',
      syncError: 'conflict',
      pendingIntent: {
        type: 'update',
        baseRevision: 7,
        payload: { title: 'My explicit edit', description: 'local', urgent: true, important: false },
      },
    };
    const freshRemote = remoteTask({ ...conflict, syncState: 'synced', pendingIntent: undefined, syncError: undefined });
    storage.loadTasks.mockResolvedValue([conflict]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([freshRemote]);
    tasksApi.updateRemoteTask.mockResolvedValue(remoteTask({
      id,
      title: 'My explicit edit',
      description: 'local',
      urgent: true,
      important: false,
      revision: 9,
    }));

    const { getByTestId, getByText } = await render(<App />);
    await waitFor(() => expect(getByText('Server value')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId(`conflict-retry-local-${id}`));

    await waitFor(() => expect(tasksApi.updateRemoteTask).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ title: 'My explicit edit', urgent: true, important: false }),
      'pl',
      8
    ), { timeout: ASYNC_TIMEOUT });
    await waitFor(() => expect(getByText('My explicit edit')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
  });

  it('removes a conflict locally when the user keeps an already-missing remote version', async () => {
    const id = '507f1f77bcf86cd799439083';
    storage.loadTasks.mockResolvedValue([{
      id,
      remoteId: id,
      title: 'Gone remotely',
      revision: 4,
      syncState: 'conflict',
      syncError: 'conflict',
      remoteMissing: true,
      pendingIntent: { type: 'delete', baseRevision: 3 },
    }]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);

    const { getByTestId, getByText, queryByText } = await render(<App />);
    await waitFor(() => expect(getByText('Gone remotely')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId(`conflict-keep-remote-${id}`));
    await waitFor(() => expect(queryByText('Gone remotely')).toBeNull(), { timeout: ASYNC_TIMEOUT });
    expect(storage.saveTasks).toHaveBeenLastCalledWith([]);
  });

  it('loads cached state, matrix and AI summary from the remote runtimes', async () => {
    const { getAllByText, getByText, getByTestId } = await render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zsynchronizowano z API'), {
      timeout: ASYNC_TIMEOUT,
    });

    expect(storage.saveTasks).toHaveBeenCalledWith([remoteTask()]);
    expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledWith('pl');
    expect(ai.fetchAICapabilities).toHaveBeenCalled();
    expect(getAllByText('Pomoc w porządkowaniu zadań').length).toBeGreaterThan(0);
    expect(getByText('Zrób teraz')).toBeTruthy();
    expect(getByText('Deleguj')).toBeTruthy();
    expect(getByText('Zaplanuj')).toBeTruthy();
    expect(getAllByText('Usuń (kwadrant, nie kasowanie)').length).toBeGreaterThan(0);
  });

  it('reconciles pending local tasks after the API becomes available again', async () => {
    storage.loadTasks.mockResolvedValue([
      {
        id: 'local-1',
        title: 'Offline draft',
        description: 'kept locally',
        urgent: false,
        important: true,
        locale: 'pl',
        remoteId: null,
        syncState: 'pending_create',
      },
    ]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    tasksApi.createRemoteTask.mockResolvedValueOnce(
      remoteTask({
        id: '507f1f77bcf86cd799439055',
        title: 'Offline draft',
        description: 'kept locally',
        urgent: false,
        important: true,
      })
    );

    const { getByText, getByTestId, queryByTestId } = await render(<App />);

    await waitFor(() => expect(tasksApi.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Offline draft',
        description: 'kept locally',
        urgent: false,
        important: true,
      }),
      'pl',
      'mobile-local-1'
    ), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByText('Offline draft')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zsynchronizowano z API'), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(queryByTestId('sync-pending-local-1')).toBeNull();
  });

  it('adds and deletes remote tasks', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    tasksApi.createRemoteTask.mockResolvedValue(
      remoteTask({ id: '507f1f77bcf86cd799439012', title: 'Nowe zadanie', description: 'desc', important: true })
    );

    const { getAllByText, getByPlaceholderText, getByTestId, queryByText } = await render(<App />);

    await waitFor(() => expect(getAllByText('Brak zadań w tym kwadrancie.').length).toBe(4), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Nowe zadanie');
    await fireEvent.changeText(getByPlaceholderText('Opis'), 'desc');
    await fireEvent(getByTestId('new-task-urgent-switch'), 'valueChange', true);
    await fireEvent(getByTestId('new-task-important-switch'), 'valueChange', true);
    await fireEvent.press(getByTestId('add-task-button'));

    await waitFor(() => expect(queryByText('Nowe zadanie')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('lifecycle-trash-507f1f77bcf86cd799439012'));
    await waitFor(() => expect(getByTestId('delete-task-507f1f77bcf86cd799439012')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId('delete-task-507f1f77bcf86cd799439012'));
    await fireEvent.press(getByTestId('confirm-delete-507f1f77bcf86cd799439012'));

    await waitFor(() => expect(queryByText('Nowe zadanie')).toBeNull(), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(tasksApi.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Nowe zadanie',
        description: 'desc',
        urgent: true,
        important: true,
      }),
      'pl',
      expect.stringMatching(/^mobile-/)
    );
    expect(tasksApi.transitionRemoteTaskLifecycle).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439012',
      'trash',
      'pl',
      0,
    );
    expect(tasksApi.deleteRemoteTask).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439012',
      1,
      'trashed',
    );
  });

  it('runs reversible lifecycle actions before final purge', async () => {
    const id = '507f1f77bcf86cd799439077';
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([remoteTask({ id, title: 'Lifecycle task' })]);

    const { getByTestId, queryByText } = await render(<App />);

    await waitFor(() => expect(queryByText('Lifecycle task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`lifecycle-complete-${id}`));
    await waitFor(() => expect(getByTestId(`lifecycle-reopen-${id}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`lifecycle-reopen-${id}`));
    await waitFor(() => expect(getByTestId(`lifecycle-archive-${id}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`lifecycle-archive-${id}`));
    await waitFor(() => expect(getByTestId(`lifecycle-restore-${id}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`lifecycle-restore-${id}`));
    await waitFor(() => expect(getByTestId(`lifecycle-trash-${id}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`lifecycle-trash-${id}`));
    await waitFor(() => expect(getByTestId(`delete-task-${id}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`delete-task-${id}`));
    await fireEvent.press(getByTestId(`confirm-delete-${id}`));

    await waitFor(() => expect(queryByText('Lifecycle task')).toBeNull(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('saves a revision-safe schedule and requests a private local reminder', async () => {
    const id = '507f1f77bcf86cd799439077';
    tasksApi.fetchRemoteTasks.mockResolvedValue([remoteTask({ id, revision: 4 })]);
    const { getByTestId } = await render(<App />);

    await waitFor(() => expect(getByTestId(`schedule-edit-${id}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`schedule-edit-${id}`));
    await fireEvent.changeText(getByTestId(`schedule-due-${id}`), '2026-08-15T12:00:00.000Z');
    await fireEvent.changeText(getByTestId(`schedule-timezone-${id}`), 'Europe/Warsaw');
    await fireEvent.changeText(getByTestId(`schedule-reminder-${id}`), '2026-08-15T10:00:00.000Z');
    await fireEvent.press(getByTestId(`schedule-save-${id}`));

    const schedule = {
      dueAt: '2026-08-15T12:00:00.000Z',
      timeZone: 'Europe/Warsaw',
      remindAt: '2026-08-15T10:00:00.000Z',
    };
    await waitFor(() => expect(tasksApi.updateRemoteTaskSchedule)
      .toHaveBeenCalledWith(id, schedule, 'pl', 4), { timeout: ASYNC_TIMEOUT });
    expect(reminders.syncTaskReminder).toHaveBeenCalledWith(
      expect.objectContaining({ id, schedule, syncState: 'pending_schedule' }),
      { requestPermission: true },
    );
  });

  it('keeps a schedule intent locally when the schedule endpoint is offline', async () => {
    const id = '507f1f77bcf86cd799439076';
    tasksApi.fetchRemoteTasks.mockResolvedValue([remoteTask({ id, revision: 2 })]);
    tasksApi.updateRemoteTaskSchedule.mockRejectedValueOnce(new Error('offline'));
    const { getByTestId } = await render(<App />);

    await waitFor(() => expect(getByTestId(`schedule-edit-${id}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`schedule-edit-${id}`));
    await fireEvent.changeText(getByTestId(`schedule-due-${id}`), '2026-08-15T12:00:00.000Z');
    await fireEvent.changeText(getByTestId(`schedule-timezone-${id}`), 'Europe/Warsaw');
    await fireEvent.press(getByTestId(`schedule-save-${id}`));

    await waitFor(() => expect(storage.saveTasks).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({
        id,
        syncState: 'pending_schedule',
        syncError: 'error',
        pendingIntent: expect.objectContaining({ type: 'schedule', baseRevision: 2 }),
      }),
    ])), { timeout: ASYNC_TIMEOUT });
  });

  it('separates owned and delegated views and executes role-appropriate delegation actions', async () => {
    const ownedId = '507f1f77bcf86cd799439075';
    const delegatedId = '507f1f77bcf86cd799439074';
    tasksApi.fetchRemoteTasks.mockResolvedValue([remoteTask({ id: ownedId, revision: 2 })]);
    tasksApi.fetchRemoteDelegatedTasks.mockResolvedValue([remoteTask({
      id: delegatedId,
      title: 'Handoff for me',
      revision: 1,
      delegationRole: 'assignee',
      delegation: {
        assigneeUserId: 'local-user', displayLabel: 'Local', handoffNote: 'Use runbook', status: 'offered',
      },
    })]);
    const { getByTestId, queryByTestId } = await render(<App />);

    await waitFor(() => expect(getByTestId(`delegation-edit-${ownedId}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`delegation-edit-${ownedId}`));
    await fireEvent.changeText(getByTestId(`delegation-user-${ownedId}`), 'user-b');
    await fireEvent.changeText(getByTestId(`delegation-label-${ownedId}`), 'Pat');
    await fireEvent.press(getByTestId(`delegation-save-${ownedId}`));
    await waitFor(() => expect(tasksApi.updateRemoteTaskDelegation).toHaveBeenCalledWith(
      ownedId,
      { assigneeUserId: 'user-b', displayLabel: 'Pat', handoffNote: '' },
      'pl',
      2,
    ), { timeout: ASYNC_TIMEOUT });

    await fireEvent.press(getByTestId('task-view-delegated'));
    await waitFor(() => expect(getByTestId(`delegation-status-accepted-${delegatedId}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(queryByTestId(`toggle-urgent-${delegatedId}`)).toBeNull();
    expect(queryByTestId(`schedule-edit-${delegatedId}`)).toBeNull();
    await fireEvent.press(getByTestId(`delegation-status-accepted-${delegatedId}`));
    await waitFor(() => expect(tasksApi.transitionRemoteTaskDelegation)
      .toHaveBeenCalledWith(delegatedId, 'accepted', 'pl', 1), { timeout: ASYNC_TIMEOUT });
  });

  it('keeps owner delegation offline and retries revision conflicts without losing intent', async () => {
    const id = '507f1f77bcf86cd799439073';
    tasksApi.fetchRemoteTasks.mockResolvedValue([remoteTask({ id, revision: 3 })]);
    tasksApi.updateRemoteTaskDelegation.mockRejectedValueOnce({ status: 412 });
    const { getByTestId } = await render(<App />);
    await waitFor(() => expect(getByTestId(`delegation-edit-${id}`)).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId(`delegation-edit-${id}`));
    await fireEvent.changeText(getByTestId(`delegation-user-${id}`), 'user-c');
    await fireEvent.changeText(getByTestId(`delegation-label-${id}`), 'Casey');
    await fireEvent.press(getByTestId(`delegation-save-${id}`));

    await waitFor(() => expect(tasksApi.updateRemoteTaskDelegation).toHaveBeenCalledTimes(2), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(storage.saveTasks).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        pendingIntent: expect.objectContaining({ type: 'delegation' }),
      }),
    ]));
  });

  it('keeps an assignee status transition offline and exposes conflict resolution', async () => {
    const id = '507f1f77bcf86cd799439072';
    const delegated = remoteTask({
      id,
      title: 'Conflict handoff',
      revision: 2,
      delegationRole: 'assignee',
      delegation: {
        assigneeUserId: 'local-user', displayLabel: 'Local', handoffNote: '', status: 'offered',
      },
    });
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteDelegatedTasks.mockResolvedValue([delegated]);
    tasksApi.transitionRemoteTaskDelegation.mockRejectedValueOnce(new Error('offline'));
    const view = await render(<App />);
    await waitFor(() => expect(view.getByTestId('task-view-delegated')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(view.getByTestId('task-view-delegated'));
    await waitFor(() => expect(view.getByTestId(`delegation-status-accepted-${id}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(view.getByTestId(`delegation-status-accepted-${id}`));
    await waitFor(() => expect(storage.saveDelegatedTasks).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({
        syncState: 'pending_delegation_status',
        syncError: 'error',
        pendingIntent: expect.objectContaining({ type: 'delegation_status', status: 'accepted' }),
      }),
    ])), { timeout: ASYNC_TIMEOUT });
  });

  it('resolves a delegated status conflict using the fresh remote revision', async () => {
    const id = '507f1f77bcf86cd799439072';
    const delegated = remoteTask({
      id,
      title: 'Conflict handoff',
      revision: 2,
      delegationRole: 'assignee',
      delegation: {
        assigneeUserId: 'local-user', displayLabel: 'Local', handoffNote: '', status: 'offered',
      },
    });
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    storage.loadDelegatedTasks.mockResolvedValueOnce([{
      ...delegated,
      syncState: 'conflict',
      syncError: 'conflict',
      pendingIntent: { type: 'delegation_status', status: 'accepted', baseRevision: 2 },
    }]);
    tasksApi.fetchRemoteDelegatedTasks.mockResolvedValueOnce([{ ...delegated, revision: 3 }]);
    const conflictView = await render(<App />);
    await waitFor(() => expect(conflictView.getByTestId('task-view-delegated')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(conflictView.getByTestId('task-view-delegated'));
    await waitFor(() => expect(conflictView.getByTestId(`conflict-keep-remote-${id}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(conflictView.getByTestId(`conflict-keep-remote-${id}`));
    await waitFor(() => expect(storage.saveDelegatedTasks).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ id, revision: 3, syncState: 'synced' }),
    ])), { timeout: ASYNC_TIMEOUT });
  });

  it('falls back to an empty delegated cache when its local snapshot cannot be loaded', async () => {
    storage.loadDelegatedTasks.mockRejectedValueOnce(new Error('storage unavailable'));
    const { getByTestId } = await render(<App />);
    await waitFor(() => expect(getByTestId('task-view-delegated')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId('task-view-delegated'));
    expect(getByTestId('quadrant-0')).toBeTruthy();
  });

  it('keeps lifecycle revision conflicts visible for resolution', async () => {
    const lifecycleId = '507f1f77bcf86cd799439078';
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([
      remoteTask({ id: lifecycleId, title: 'Lifecycle conflict', revision: 2 }),
    ]);
    tasksApi.transitionRemoteTaskLifecycle.mockRejectedValue({ status: 412 });

    const { getByTestId, getByText } = await render(<App />);

    await waitFor(() => expect(getByText('Lifecycle conflict')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId(`lifecycle-complete-${lifecycleId}`));
    await waitFor(() => expect(getByTestId(`conflict-keep-remote-${lifecycleId}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('keeps purge revision conflicts visible for resolution', async () => {
    const purgeId = '507f1f77bcf86cd799439079';
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([
      remoteTask({ id: purgeId, title: 'Purge conflict', revision: 3, lifecycleState: 'trashed' }),
    ]);
    tasksApi.deleteRemoteTask.mockRejectedValue({ response: { status: 412 } });
    const purgeView = await render(<App />);

    await waitFor(() => expect(purgeView.getByTestId(`delete-task-${purgeId}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(purgeView.getByTestId(`delete-task-${purgeId}`));
    await fireEvent.press(purgeView.getByTestId(`confirm-delete-${purgeId}`));
    await waitFor(() => expect(purgeView.getByTestId(`conflict-keep-remote-${purgeId}`)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('requests quick AI suggestions, toggles remote flags and changes language', async () => {
    const { getByPlaceholderText, getByTestId, getByText } = await render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Pilny termin');
    await fireEvent.press(getByTestId('suggest-task-button'));
    await fireEvent.press(getByTestId('toggle-urgent-507f1f77bcf86cd799439011'));
    await fireEvent.press(getByText('EN'));

    await waitFor(() => expect(ai.suggestTaskQuadrant).toHaveBeenCalledWith('Pilny termin'), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() =>
      expect(tasksApi.updateRemoteTask).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439011',
        { urgent: false },
        'pl',
        0
      ),
      { timeout: ASYNC_TIMEOUT }
    );
    await waitFor(() =>
      expect(storage.saveLanguage).toHaveBeenCalledWith('en'),
      { timeout: ASYNC_TIMEOUT }
    );
  });

  it('gates business assistance from public capability flags and opens the first available tool', async () => {
    ai.fetchAICapabilities.mockResolvedValue(
      capabilities({
        classification: false,
        reasoned_local_analysis: false,
        knowledge_retrieval: false,
        retrieval_augmented_generation: false,
        local_similar_examples: false,
        ocr: true,
        batch_analysis: false,
      })
    );

    const { getByTestId, queryByTestId } = await render(<App />);
    await waitFor(() => expect(getByTestId('scan-task-button').props.accessibilityState.disabled).toBe(false), {
      timeout: ASYNC_TIMEOUT,
    });

    expect(getByTestId('suggest-task-button').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(getByTestId('open-ai-tools-button'));
    expect(getByTestId('ai-ocr-run-button')).toBeTruthy();
    expect(queryByTestId('ai-analysis-run-button')).toBeNull();
    expect(queryByTestId('ai-batch-run-button')).toBeNull();
  });

  it('disables the assistance entry point when no business tool is available', async () => {
    ai.fetchAICapabilities.mockResolvedValue(
      capabilities({
        classification: false,
        reasoned_local_analysis: false,
        knowledge_retrieval: false,
        retrieval_augmented_generation: false,
        local_similar_examples: false,
        ocr: false,
        batch_analysis: false,
      })
    );

    const { getByTestId, queryByTestId } = await render(<App />);
    await waitFor(() => expect(getByTestId('open-ai-tools-button').props.accessibilityState.disabled).toBe(true), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId('open-ai-tools-button'));
    expect(queryByTestId('ai-tools-close-button')).toBeNull();
  });

  it('opens AI tools, runs advanced analysis and adds the analyzed task to the matrix', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    tasksApi.createRemoteTask
      .mockResolvedValueOnce(
        remoteTask({
          id: '507f1f77bcf86cd799439020',
          title: 'Prepare roadmap',
          description: 'Pilne i ważne przez deadline i wpływ biznesowy.',
          urgent: true,
          important: true,
        })
      );

    const { getByTestId, getByText } = await render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('open-ai-tools-button'));
    await fireEvent.changeText(getByTestId('ai-analysis-input'), 'Prepare roadmap');
    await fireEvent.press(getByTestId('ai-analysis-run-button'));

    await waitFor(() => expect(ai.analyzeTaskAdvanced).toHaveBeenCalledWith(
      'Prepare roadmap',
      'pl',
      expect.objectContaining({ signal: expect.any(Object) })
    ), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('ai-analysis-reasoning').props.children).toBe(
      'Pilne i ważne przez deadline i wpływ biznesowy.'
    ), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(getByTestId('ai-analysis-suggested').props.children).toContain('Zrób teraz');

    await fireEvent.press(getByTestId('ai-analysis-add-button'));

    await waitFor(() => expect(tasksApi.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Prepare roadmap',
        urgent: true,
        important: true,
      }),
      'pl',
      expect.stringMatching(/^mobile-/)
    ), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('surfaces add-to-matrix errors when the local persistence fallback also fails', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);

    const { getByTestId } = await render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('open-ai-tools-button'));
    await fireEvent.changeText(getByTestId('ai-analysis-input'), 'Prepare roadmap');
    await fireEvent.press(getByTestId('ai-analysis-run-button'));

    await waitFor(() => expect(getByTestId('ai-analysis-add-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    tasksApi.createRemoteTask.mockRejectedValueOnce(new Error('offline'));
    storage.saveTasks.mockRejectedValueOnce(new Error('disk full'));
    await fireEvent.press(getByTestId('ai-analysis-add-button'));

    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Nie udało się dodać wyniku analizy do macierzy'
    ), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('opens and closes the AI tools modal from the dedicated close button', async () => {
    const { getByTestId, queryByTestId } = await render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('open-ai-tools-button'));

    await waitFor(() => expect(getByTestId('ai-analysis-input')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('ai-tools-close-button'));

    await waitFor(() => expect(queryByTestId('ai-analysis-input')).toBeNull(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('cancels an in-flight analysis when the AI tools modal closes', async () => {
    ai.analyzeTaskAdvanced.mockImplementation((_task, _language, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject({ code: 'request_cancelled' }));
    }));
    const { getByTestId, queryByTestId } = await render(<App />);
    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId('open-ai-tools-button'));
    await fireEvent.changeText(getByTestId('ai-analysis-input'), 'Cancel analysis');
    let signal;
    await act(async () => {
      const analysisPromise = findHandler(getByTestId('ai-analysis-run-button'), 'onPress')();
      await Promise.resolve();
      expect(ai.analyzeTaskAdvanced).toHaveBeenCalledTimes(1);
      signal = ai.analyzeTaskAdvanced.mock.calls[0][2].signal;
      const closePromise = findHandler(getByTestId('ai-tools-close-button'), 'onPress')();
      await Promise.all([analysisPromise, closePromise]);
    });

    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(queryByTestId('ai-analysis-input')).toBeNull());
  });

  it('ignores stale analysis results after editing or closing the modal', async () => {
    let resolveStale;
    let resolveCurrent;
    ai.analyzeTaskAdvanced
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCurrent = resolve; }));
    const { getByTestId, queryByText } = await render(<App />);
    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId('open-ai-tools-button'));
    await fireEvent.changeText(getByTestId('ai-analysis-input'), 'Old input');
    let staleSignal;
    await act(async () => {
      const staleAnalysisPromise = findHandler(getByTestId('ai-analysis-run-button'), 'onPress')();
      await Promise.resolve();
      expect(ai.analyzeTaskAdvanced).toHaveBeenCalledTimes(1);
      staleSignal = ai.analyzeTaskAdvanced.mock.calls[0][2].signal;

      findHandler(getByTestId('ai-analysis-input'), 'onChangeText')('Current input');
      await Promise.resolve();
      expect(staleSignal.aborted).toBe(true);
      resolveStale({
        task: 'Old input',
        langchain_analysis: { quadrant: 3, reasoning: 'STALE RESULT' },
      });
      await staleAnalysisPromise;
    });
    expect(queryByText('STALE RESULT')).toBeNull();

    await act(async () => {
      const currentAnalysisPromise = findHandler(getByTestId('ai-analysis-run-button'), 'onPress')();
      await Promise.resolve();
      expect(ai.analyzeTaskAdvanced).toHaveBeenCalledTimes(2);
      resolveCurrent({
        task: 'Current input',
        langchain_analysis: { quadrant: 2, reasoning: 'CURRENT RESULT' },
      });
      await currentAnalysisPromise;
    });
    await waitFor(() => expect(getByTestId('ai-analysis-reasoning').props.children).toBe('CURRENT RESULT'));
  });

  it('opens bulk analysis in AI tools and renders reviewed tasks', async () => {
    const { getAllByText, getByTestId } = await render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('open-ai-tools-button'));
    await fireEvent.press(getByTestId('ai-tab-batch'));
    await fireEvent.changeText(getByTestId('ai-batch-input'), 'Task A\nTask B');
    await fireEvent.press(getByTestId('ai-batch-run-button'));

    await waitFor(() => expect(ai.batchAnalyzeTasks).toHaveBeenCalledWith(
      ['Task A', 'Task B'],
      expect.objectContaining({ signal: expect.any(Object) })
    ), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getAllByText('Task A').length).toBeGreaterThan(0), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(getAllByText('Task B').length).toBeGreaterThan(0);
  });

  it('scans tasks through OCR and creates them remotely', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    media.scanTasksFromImage.mockResolvedValue([
      {
        title: 'Scanned task',
        description: '',
        urgent: false,
        important: true,
        locale: 'pl',
      },
    ]);
    tasksApi.createRemoteTask.mockResolvedValue(
      remoteTask({ id: '507f1f77bcf86cd799439013', title: 'Scanned task', description: '', urgent: false, important: true })
    );

    const { getAllByText, getByTestId } = await render(<App />);

    await waitFor(() => expect(getAllByText('Brak zadań w tym kwadrancie.').length).toBe(4), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId('scan-task-button'));
    await waitFor(() => expect(getByTestId('ocr-title-ocr-review-0')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId('ocr-import-button'));

    await waitFor(() => expect(tasksApi.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Scanned task',
        important: true,
      }),
      'pl',
      expect.stringMatching(/^mobile-/)
    ), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zsynchronizowano z API'), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(media.scanTasksFromImage).toHaveBeenCalledWith(
      'pl',
      null,
      expect.objectContaining({ signal: expect.any(Object) })
    );
  });

  it('uses local fallback for add, toggle, delete and reports unavailable task assistance', async () => {
    storage.loadTasks.mockResolvedValue([
      { id: 'local-1', title: 'Local task', description: '', urgent: false, important: false, locale: 'pl' },
    ]);
    tasksApi.fetchRemoteTasks.mockRejectedValue(new Error('offline'));
    tasksApi.createRemoteTask.mockRejectedValue(new Error('offline'));
    ai.fetchAICapabilities.mockResolvedValue(capabilities());
    ai.suggestTaskQuadrant.mockRejectedValue(new Error('offline'));

    const { getByPlaceholderText, getByTestId, getByText, getAllByText, queryByText } = await render(<App />);

    await waitFor(() => expect(getByText('Local task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zapisano lokalnie'), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Offline task');
    await fireEvent.press(getByTestId('suggest-task-button'));
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe(
      'Pomoc jest chwilowo niedostępna. Nadal możesz ręcznie wybrać kwadrant i dodać zadanie.'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('add-task-button'));
    await waitFor(() => expect(getByText('Offline task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('toggle-important-local-1'));
    await waitFor(() => expect(getAllByText('Ważne: wł.').length).toBeGreaterThan(0), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('lifecycle-trash-local-1'));
    await fireEvent.press(getByTestId('delete-task-local-1'));
    await fireEvent.press(getByTestId('confirm-delete-local-1'));
    await waitFor(() => expect(queryByText('Local task')).toBeNull(), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(tasksApi.updateRemoteTask).not.toHaveBeenCalled();
    expect(tasksApi.deleteRemoteTask).not.toHaveBeenCalled();
  });

  it('shows OCR notices for empty and failed scans', async () => {
    media.scanTasksFromImage.mockResolvedValueOnce([]);
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);

    const { getByTestId } = await render(<App />);

    await waitFor(() => expect(getByTestId('scan-task-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('scan-task-button'));
    await waitFor(() => expect(getByTestId('ai-tools-message').props.children).toBe('Na obrazie nie znaleziono żadnych zadań'), {
      timeout: ASYNC_TIMEOUT,
    });

    media.scanTasksFromImage.mockRejectedValueOnce({ code: 'ocr_request_failed' });
    await fireEvent.press(getByTestId('scan-task-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe('Nie udało się odczytać obrazu, więc nic nie dodano'), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('ignores blank add and suggest actions', async () => {
    const { getByText, getByTestId } = await render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('add-task-button'));
    await fireEvent.press(getByTestId('suggest-task-button'));

    expect(tasksApi.createRemoteTask).not.toHaveBeenCalled();
    expect(ai.suggestTaskQuadrant).not.toHaveBeenCalled();
  });

  it('falls back to localized seed data when storage bootstrap fails', async () => {
    storage.loadLanguage.mockRejectedValueOnce(new Error('storage down'));
    storage.loadTasks.mockRejectedValueOnce(new Error('storage down'));
    tasksApi.fetchRemoteTasks.mockRejectedValueOnce(new Error('offline'));

    const { getByText } = await render(<App />);

    await waitFor(() => expect(getByText(getSampleTasks('pl')[0].title)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('uses localized seeds when loading cached tasks fails', async () => {
    storage.loadLanguage.mockResolvedValue('en');
    storage.loadTasks.mockRejectedValueOnce(new Error('bad cache'));
    tasksApi.fetchRemoteTasks.mockRejectedValueOnce(new Error('offline'));

    const { getByText, getByTestId } = await render(<App />);

    await waitFor(() => expect(getByText(getSampleTasks('en')[0].title)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Saved locally'), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('falls back locally when remote toggle and delete fail', async () => {
    tasksApi.updateRemoteTask.mockRejectedValueOnce(new Error('offline'));
    tasksApi.transitionRemoteTaskLifecycle.mockRejectedValueOnce(new Error('offline'));

    const { getByTestId, getByText, queryByText } = await render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('toggle-urgent-507f1f77bcf86cd799439011'));
    await waitFor(() => expect(getByText('Pilne: wył.')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(getByTestId('sync-pending-507f1f77bcf86cd799439011')).toBeTruthy();

    await fireEvent.press(getByTestId('lifecycle-trash-507f1f77bcf86cd799439011'));
    await waitFor(() => expect(getByTestId('lifecycle-state-507f1f77bcf86cd799439011').props.children)
      .toContain('Kosz'), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Niektore zmiany nadal czekaja na synchronizacje'), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(queryByText('Seed task')).toBeTruthy();
  });

  it('keeps cached state when the initial remote fetch throws synchronously', async () => {
    tasksApi.fetchRemoteTasks.mockImplementationOnce(() => {
      throw new Error('sync bootstrap failure');
    });

    const { getByText } = await render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('shows validation and request errors across advanced analysis, OCR and batch AI flows', async () => {
    const { getByTestId } = await render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('open-ai-tools-button'));
    await fireEvent.changeText(getByTestId('ai-analysis-input'), '');
    await fireEvent.press(getByTestId('ai-analysis-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Wpisz zadanie przed poproszeniem o sugestię'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    ai.analyzeTaskAdvanced.mockRejectedValueOnce({ code: 'unavailable' });
    await fireEvent.changeText(getByTestId('ai-analysis-input'), 'Roadmap');
    await fireEvent.press(getByTestId('ai-analysis-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Pomoc jest chwilowo niedostępna. Nadal możesz ręcznie wybrać kwadrant i dodać zadanie.'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('ai-tab-ocr'));
    media.scanTasksFromImage.mockResolvedValueOnce([]);
    await fireEvent.press(getByTestId('ai-ocr-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-message').props.children).toBe(
      'Na obrazie nie znaleziono żadnych zadań'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    media.scanTasksFromImage.mockRejectedValueOnce({ code: 'provider_disabled' });
    await fireEvent.press(getByTestId('ai-ocr-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Skanowanie notatek jest chwilowo niedostępne'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    await fireEvent.press(getByTestId('ai-tab-batch'));
    await fireEvent.changeText(getByTestId('ai-batch-input'), '');
    await fireEvent.press(getByTestId('ai-batch-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Wpisz przynajmniej jedno zadanie'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    ai.batchAnalyzeTasks.mockRejectedValueOnce(new Error('batch down'));
    await fireEvent.changeText(getByTestId('ai-batch-input'), 'Task A');
    await fireEvent.press(getByTestId('ai-batch-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Pomoc jest chwilowo niedostępna. Nadal możesz ręcznie wybrać kwadrant i dodać zadanie.'
    ), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('keeps OCR tasks locally when remote creation fails', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    media.scanTasksFromImage.mockResolvedValue([
      {
        id: 'ocr-1',
        title: 'Offline scan',
        description: '',
        urgent: true,
        important: false,
        locale: 'pl',
      },
    ]);
    tasksApi.createRemoteTask.mockRejectedValue(new Error('offline'));

    const { getAllByText, getByText, getByTestId } = await render(<App />);

    await waitFor(() => expect(getAllByText('Brak zadań w tym kwadrancie.').length).toBe(4), {
      timeout: ASYNC_TIMEOUT,
    });
    await fireEvent.press(getByTestId('scan-task-button'));
    await waitFor(() => expect(getByTestId('ocr-title-ocr-1')).toBeTruthy(), { timeout: ASYNC_TIMEOUT });
    await fireEvent.press(getByTestId('ocr-import-button'));

    await waitFor(() => expect(getByText('Offline scan')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(storage.saveTasks).toHaveBeenLastCalledWith([
      expect.objectContaining({
        title: 'Offline scan',
        syncState: 'pending_create',
        clientOperationId: expect.stringMatching(/^mobile-/),
      }),
    ]);
  });
});
