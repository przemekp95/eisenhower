import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import App from './App';
import * as ai from './src/services/ai';
import * as media from './src/services/media';

jest.mock('./src/services/ai', () => ({
  suggestTaskQuadrant: jest.fn(),
}));

jest.mock('./src/services/media', () => ({
  scanTasksFromImage: jest.fn(),
}));

const LANGUAGE_KEY = 'eisenhower-mobile/language';
const TASKS_KEY = 'eisenhower-mobile/tasks';
const ASYNC_TIMEOUT = 10_000;

describe('Mobile App', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    AsyncStorage.getItem.mockImplementation(async (key) => {
      if (key === LANGUAGE_KEY) {
        return 'pl';
      }

      if (key === TASKS_KEY) {
        return JSON.stringify([
      { id: '1', title: 'Seed task', description: 'desc', urgent: true, important: false },
        ]);
      }

      return null;
    });
    AsyncStorage.setItem.mockResolvedValue(undefined);
    AsyncStorage.clear.mockResolvedValue(undefined);

    ai.suggestTaskQuadrant.mockResolvedValue({ urgent: true, important: true });
    media.scanTasksFromImage.mockResolvedValue([]);
  });

  it('loads stored state', async () => {
    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('adds and deletes tasks', async () => {
    const { getByText, getByPlaceholderText, getByTestId, queryByText } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Nowe zadanie');
    fireEvent.press(getByTestId('add-task-button'));

    await waitFor(() => expect(queryByText('Nowe zadanie')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('delete-task-1'));
    await waitFor(() => expect(queryByText('Seed task')).toBeNull(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('requests AI suggestions, toggles task flags and changes language', async () => {
    const { getByPlaceholderText, getByTestId, getByText } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Pilny termin');
    fireEvent.press(getByTestId('suggest-task-button'));
    fireEvent.press(getByTestId('toggle-urgent-1'));
    fireEvent.press(getByText('EN'));

    await waitFor(() => expect(ai.suggestTaskQuadrant).toHaveBeenCalledWith('Pilny termin'), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(LANGUAGE_KEY, 'en'),
      { timeout: ASYNC_TIMEOUT }
    );
    await waitFor(() =>
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        TASKS_KEY,
        JSON.stringify([
          { id: '1', title: 'Seed task', description: 'desc', urgent: false, important: false },
        ])
      ),
      { timeout: ASYNC_TIMEOUT }
    );
  });

  it('scans tasks into an empty list', async () => {
    AsyncStorage.getItem.mockImplementation(async (key) => {
      if (key === LANGUAGE_KEY) {
        return 'pl';
      }

      if (key === TASKS_KEY) {
        return JSON.stringify([]);
      }

      return null;
    });
    media.scanTasksFromImage.mockResolvedValue([
      { id: 'scan-1', title: 'Scanned task', description: '', urgent: false, important: true },
    ]);

    const { getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByText('Brak zadań.')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    fireEvent.press(getByTestId('scan-task-button'));

    await waitFor(() => expect(getByText('Scanned task')).toBeTruthy(), {
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

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(ai.suggestTaskQuadrant).not.toHaveBeenCalled();
  });

  it('falls back to sample data when bootstrap fails', async () => {
    AsyncStorage.getItem.mockRejectedValueOnce(new Error('storage down'));

    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText('Pilny raport dla klienta')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });
});
