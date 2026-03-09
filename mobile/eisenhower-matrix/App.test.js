import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import App from './App';
import { getSampleTasks } from './src/utils/taskUtils';
import * as ai from './src/services/ai';
import * as media from './src/services/media';
import * as storage from './src/services/storage';
import * as tasksApi from './src/services/tasks';

jest.mock('./src/services/ai', () => ({
  suggestTaskQuadrant: jest.fn(),
}));

jest.mock('./src/services/media', () => ({
  scanTasksFromImage: jest.fn(),
}));

jest.mock('./src/services/storage', () => ({
  loadLanguage: jest.fn(),
  loadTasks: jest.fn(),
  saveLanguage: jest.fn(),
  saveTasks: jest.fn(),
}));

jest.mock('./src/services/tasks', () => ({
  fetchRemoteTasks: jest.fn(),
  createRemoteTask: jest.fn(),
  updateRemoteTask: jest.fn(),
  deleteRemoteTask: jest.fn(),
  isRemoteTaskId: jest.fn(),
}));

const ASYNC_TIMEOUT = 10_000;

jest.setTimeout(20_000);

function remoteTask(overrides = {}) {
  return {
    id: '507f1f77bcf86cd799439011',
    title: 'Seed task',
    description: 'desc',
    urgent: true,
    important: false,
    locale: 'pl',
    ...overrides,
  };
}

describe('Mobile App', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    storage.loadLanguage.mockResolvedValue('pl');
    storage.loadTasks.mockResolvedValue([remoteTask({ id: 'local-1' })]);
    storage.saveLanguage.mockResolvedValue(undefined);
    storage.saveTasks.mockResolvedValue(undefined);

    tasksApi.fetchRemoteTasks.mockResolvedValue([remoteTask()]);
    tasksApi.createRemoteTask.mockImplementation(async (task) => remoteTask(task));
    tasksApi.updateRemoteTask.mockImplementation(async (id, patch) => remoteTask({ id, ...patch }));
    tasksApi.deleteRemoteTask.mockResolvedValue(undefined);
    tasksApi.isRemoteTaskId.mockImplementation((id) => /^[a-f0-9]{24}$/i.test(String(id)));

    ai.suggestTaskQuadrant.mockResolvedValue({ urgent: true, important: true, source: 'remote' });
    media.scanTasksFromImage.mockResolvedValue([]);
  });

  it('loads cached state and refreshes from the remote API', async () => {
    const { getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zsynchronizowano z API'), {
      timeout: ASYNC_TIMEOUT,
    });

    expect(storage.saveTasks).toHaveBeenCalledWith([remoteTask()]);
    expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledWith('pl');
  });

  it('adds and deletes remote tasks', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    tasksApi.createRemoteTask.mockResolvedValue(
      remoteTask({ id: '507f1f77bcf86cd799439012', title: 'Nowe zadanie', description: 'desc' })
    );

    const { getByPlaceholderText, getByTestId, getByText, queryByText } = render(<App />);

    await waitFor(() => expect(getByText('Brak zadań.')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Nowe zadanie');
    fireEvent.changeText(getByPlaceholderText('Opis'), 'desc');
    fireEvent(getByTestId('new-task-urgent-switch'), 'valueChange', true);
    fireEvent(getByTestId('new-task-important-switch'), 'valueChange', true);
    fireEvent.press(getByTestId('add-task-button'));

    await waitFor(() => expect(queryByText('Nowe zadanie')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('delete-task-507f1f77bcf86cd799439012'));

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
      'pl'
    );
    expect(tasksApi.deleteRemoteTask).toHaveBeenCalledWith('507f1f77bcf86cd799439012');
  });

  it('requests AI suggestions, toggles remote flags and changes language', async () => {
    const { getByPlaceholderText, getByTestId, getByText } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Pilny termin');
    fireEvent.press(getByTestId('suggest-task-button'));
    fireEvent.press(getByTestId('toggle-urgent-507f1f77bcf86cd799439011'));
    fireEvent.press(getByText('EN'));

    await waitFor(() => expect(ai.suggestTaskQuadrant).toHaveBeenCalledWith('Pilny termin'), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() =>
      expect(tasksApi.updateRemoteTask).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439011',
        { urgent: false },
        'pl'
      ),
      { timeout: ASYNC_TIMEOUT }
    );
    await waitFor(() =>
      expect(storage.saveLanguage).toHaveBeenCalledWith('en'),
      { timeout: ASYNC_TIMEOUT }
    );
  });

  it('scans tasks through OCR and creates them remotely', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    media.scanTasksFromImage.mockResolvedValue([
      {
        id: 'ocr-1',
        title: 'Scanned task',
        description: '',
        urgent: false,
        important: true,
        locale: 'pl',
      },
    ]);
    tasksApi.createRemoteTask.mockResolvedValue(
      remoteTask({ id: '507f1f77bcf86cd799439013', title: 'Scanned task', description: '' })
    );

    const { getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByText('Brak zadań.')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    fireEvent.press(getByTestId('scan-task-button'));

    await waitFor(() => expect(getByText('Scanned task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('OCR dodał zadania do tablicy'), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(media.scanTasksFromImage).toHaveBeenCalledWith('pl');
  });

  it('uses local fallback for add, toggle, delete and AI suggestion when the network is unavailable', async () => {
    storage.loadTasks.mockResolvedValue([
      { id: 'local-1', title: 'Local task', description: '', urgent: false, important: false, locale: 'pl' },
    ]);
    tasksApi.fetchRemoteTasks.mockRejectedValue(new Error('offline'));
    tasksApi.createRemoteTask.mockRejectedValue(new Error('offline'));
    ai.suggestTaskQuadrant.mockResolvedValue({ urgent: true, important: true, source: 'fallback' });

    const { getByPlaceholderText, getByTestId, getByText, getAllByText, queryByText } = render(<App />);

    await waitFor(() => expect(getByText('Local task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zapisano lokalnie'), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Offline task');
    fireEvent.press(getByTestId('suggest-task-button'));
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Sugestia AI nie powiodła się, użyto reguł awaryjnych'), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('add-task-button'));
    await waitFor(() => expect(getByText('Offline task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('toggle-important-local-1'));
    await waitFor(() => expect(getAllByText('Ważne: wł.').length).toBeGreaterThan(0), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('delete-task-local-1'));
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

    const { getByTestId } = render(<App />);

    await waitFor(() => expect(getByTestId('scan-task-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('scan-task-button'));
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('OCR nie wykrył żadnych zadań'), {
      timeout: ASYNC_TIMEOUT,
    });

    media.scanTasksFromImage.mockRejectedValueOnce(new Error('ocr failed'));
    fireEvent.press(getByTestId('scan-task-button'));
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Wysyłka do OCR nie powiodła się, nic nie dodano'), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('ignores blank add and suggest actions', async () => {
    const { getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('add-task-button'));
    fireEvent.press(getByTestId('suggest-task-button'));

    expect(tasksApi.createRemoteTask).not.toHaveBeenCalled();
    expect(ai.suggestTaskQuadrant).not.toHaveBeenCalled();
  });

  it('falls back to localized seed data when storage bootstrap fails', async () => {
    storage.loadLanguage.mockRejectedValueOnce(new Error('storage down'));

    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText(getSampleTasks('pl')[0].title)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('uses localized seeds when loading cached tasks fails', async () => {
    storage.loadLanguage.mockResolvedValue('en');
    storage.loadTasks.mockRejectedValueOnce(new Error('bad cache'));
    tasksApi.fetchRemoteTasks.mockRejectedValueOnce(new Error('offline'));

    const { getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByText(getSampleTasks('en')[0].title)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Saved locally'), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('falls back locally when remote toggle and delete fail', async () => {
    tasksApi.updateRemoteTask.mockRejectedValueOnce(new Error('offline'));
    tasksApi.deleteRemoteTask.mockRejectedValueOnce(new Error('offline'));

    const { getByTestId, getByText, queryByText } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('toggle-urgent-507f1f77bcf86cd799439011'));
    await waitFor(() => expect(getByText('Pilne: wył.')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('delete-task-507f1f77bcf86cd799439011'));
    await waitFor(() => expect(queryByText('Seed task')).toBeNull(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zapisano lokalnie'), {
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

    const { getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByText('Brak zadań.')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    fireEvent.press(getByTestId('scan-task-button'));

    await waitFor(() => expect(getByText('Offline scan')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });
});
