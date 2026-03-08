import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import App from './App';
import * as storage from './src/services/storage';
import * as ai from './src/services/ai';
import * as media from './src/services/media';

jest.mock('./src/services/storage', () => ({
  loadLanguage: jest.fn(),
  loadTasks: jest.fn(),
  saveLanguage: jest.fn(),
  saveTasks: jest.fn(),
}));

jest.mock('./src/services/ai', () => ({
  suggestTaskQuadrant: jest.fn(),
}));

jest.mock('./src/services/media', () => ({
  scanTasksFromImage: jest.fn(),
}));

describe('Mobile App', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.loadLanguage.mockResolvedValue('pl');
    storage.loadTasks.mockResolvedValue([
      { id: '1', title: 'Seed task', description: 'desc', urgent: true, important: false },
    ]);
    storage.saveTasks.mockResolvedValue(undefined);
    storage.saveLanguage.mockResolvedValue(undefined);
    ai.suggestTaskQuadrant.mockResolvedValue({ urgent: true, important: true });
    media.scanTasksFromImage.mockResolvedValue([]);
  });

  it('loads stored state', async () => {
    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy());
  });

  it('adds and deletes tasks', async () => {
    const { getByText, getByPlaceholderText, getByTestId, queryByText } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy());

    fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Nowe zadanie');
    fireEvent.press(getByTestId('add-task-button'));

    await waitFor(() => expect(queryByText('Nowe zadanie')).toBeTruthy());

    fireEvent.press(getByTestId('delete-task-1'));
    await waitFor(() => expect(queryByText('Seed task')).toBeNull());
  });

  it('requests AI suggestions, toggles task flags and changes language', async () => {
    const { getByPlaceholderText, getByTestId, getByText } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy());
    fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Pilny termin');
    fireEvent.press(getByTestId('suggest-task-button'));
    fireEvent.press(getByTestId('toggle-urgent-1'));
    fireEvent.press(getByText('EN'));

    await waitFor(() => expect(storage.saveLanguage).toHaveBeenCalledWith('en'));
    await waitFor(() => expect(ai.suggestTaskQuadrant).toHaveBeenCalledWith('Pilny termin'));
    await waitFor(() =>
      expect(storage.saveTasks).toHaveBeenCalledWith([
        { id: '1', title: 'Seed task', description: 'desc', urgent: false, important: false },
      ])
    );
  });

  it('scans tasks into an empty list', async () => {
    storage.loadTasks.mockResolvedValue([]);
    media.scanTasksFromImage.mockResolvedValue([
      { id: 'scan-1', title: 'Scanned task', description: '', urgent: false, important: true },
    ]);

    const { getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByText('Brak zadań.')).toBeTruthy());
    fireEvent.press(getByTestId('scan-task-button'));

    await waitFor(() => expect(getByText('Scanned task')).toBeTruthy());
  });

  it('ignores blank add and suggest actions', async () => {
    const { getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy());
    fireEvent.press(getByTestId('add-task-button'));
    fireEvent.press(getByTestId('suggest-task-button'));

    expect(storage.saveTasks).not.toHaveBeenCalled();
    expect(ai.suggestTaskQuadrant).not.toHaveBeenCalled();
  });

  it('falls back to sample data when bootstrap fails', async () => {
    storage.loadLanguage.mockRejectedValue(new Error('storage down'));

    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText('Pilny raport dla klienta')).toBeTruthy());
  });
});
