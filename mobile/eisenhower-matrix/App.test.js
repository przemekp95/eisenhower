import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import App from './App';
import * as ai from './src/services/ai';
import * as media from './src/services/media';
import * as storage from './src/services/storage';
import * as tasksApi from './src/services/tasks';
import { getSampleTasks } from './src/utils/taskUtils';

jest.mock('./src/services/ai', () => ({
  suggestTaskQuadrant: jest.fn(),
  analyzeTaskAdvanced: jest.fn(),
  batchAnalyzeTasks: jest.fn(),
  fetchAICapabilities: jest.fn(),
  fetchTrainingStats: jest.fn(),
  setAIProviderEnabled: jest.fn(),
  addTrainingExample: jest.fn(),
  learnFromFeedback: jest.fn(),
  retrainModel: jest.fn(),
  clearTrainingData: jest.fn(),
  getExamplesByQuadrant: jest.fn(),
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

function capabilities(overrides = {}) {
  return {
    providers: { local_model: true, tesseract: true, ocr: true },
    provider_controls: {
      local_model: { enabled: true, available: true, active: true, reason: null },
      tesseract: { enabled: true, available: true, active: true, reason: null },
    },
    model: {
      ready: true,
      examples_seen: 9,
    },
    ...overrides,
  };
}

function trainingStats(overrides = {}) {
  return {
    total_examples: 9,
    model_name: 'local-minilm-mlp',
    model_ready: true,
    model_encoder: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
    ...overrides,
  };
}

describe('Mobile App', () => {
  afterEach(() => {
    cleanup();
  });

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
    ai.fetchTrainingStats.mockResolvedValue(trainingStats());
    ai.setAIProviderEnabled.mockResolvedValue({
      provider: 'local_model',
      enabled: false,
      available: true,
      active: false,
    });
    ai.addTrainingExample.mockResolvedValue({ message: 'ok' });
    ai.learnFromFeedback.mockResolvedValue({ message: 'ok' });
    ai.retrainModel.mockResolvedValue({ status: 'completed' });
    ai.clearTrainingData.mockResolvedValue({ remaining_examples: 4 });
    ai.getExamplesByQuadrant.mockResolvedValue({ examples: [{ text: 'urgent task', quadrant: 0 }] });
    media.scanTasksFromImage.mockResolvedValue([]);
  });

  it('loads cached state, matrix and AI summary from the remote runtimes', async () => {
    const { getAllByText, getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByText('Seed task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zsynchronizowano z API'), {
      timeout: ASYNC_TIMEOUT,
    });

    expect(storage.saveTasks).toHaveBeenCalledWith([remoteTask()]);
    expect(tasksApi.fetchRemoteTasks).toHaveBeenCalledWith('pl');
    expect(ai.fetchAICapabilities).toHaveBeenCalled();
    expect(getByText('Sterowanie centralnym AI')).toBeTruthy();
    expect(getByText('Narzędzia AI')).toBeTruthy();
    expect(getByText('Zrób teraz')).toBeTruthy();
    expect(getByText('Deleguj')).toBeTruthy();
    expect(getByText('Zaplanuj')).toBeTruthy();
    expect(getAllByText('Usuń').length).toBeGreaterThan(0);
  });

  it('adds and deletes remote tasks', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    tasksApi.createRemoteTask.mockResolvedValue(
      remoteTask({ id: '507f1f77bcf86cd799439012', title: 'Nowe zadanie', description: 'desc', important: true })
    );

    const { getAllByText, getByPlaceholderText, getByTestId, queryByText } = render(<App />);

    await waitFor(() => expect(getAllByText('Brak zadań w tym kwadrancie.').length).toBe(4), {
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

  it('requests quick AI suggestions, toggles remote flags and changes language', async () => {
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

    const { getByTestId, getByText } = render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('open-ai-tools-button'));
    fireEvent.changeText(getByTestId('ai-analysis-input'), 'Prepare roadmap');
    fireEvent.press(getByTestId('ai-analysis-run-button'));

    await waitFor(() => expect(ai.analyzeTaskAdvanced).toHaveBeenCalledWith('Prepare roadmap', 'pl'), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('ai-analysis-reasoning').props.children).toBe(
      'Pilne i ważne przez deadline i wpływ biznesowy.'
    ), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(getByTestId('ai-analysis-suggested').props.children).toContain('Zrób teraz');

    fireEvent.press(getByTestId('ai-analysis-add-button'));

    await waitFor(() => expect(tasksApi.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Prepare roadmap',
        urgent: true,
        important: true,
      }),
      'pl'
    ), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('opens and closes the AI tools modal from the dedicated close button', async () => {
    const { getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('open-ai-tools-button'));

    await waitFor(() => expect(getByTestId('ai-analysis-input')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('ai-tools-close-button'));

    await waitFor(() => expect(queryByTestId('ai-analysis-input')).toBeNull(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('opens bulk analysis in AI tools and renders reviewed tasks', async () => {
    const { getAllByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('open-ai-tools-button'));
    fireEvent.press(getByTestId('ai-tab-batch'));
    fireEvent.changeText(getByTestId('ai-batch-input'), 'Task A\nTask B');
    fireEvent.press(getByTestId('ai-batch-run-button'));

    await waitFor(() => expect(ai.batchAnalyzeTasks).toHaveBeenCalledWith(['Task A', 'Task B']), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getAllByText('Task A').length).toBeGreaterThan(0), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(getAllByText('Task B').length).toBeGreaterThan(0);
  });

  it('opens manage tab, toggles provider and performs training actions', async () => {
    ai.fetchAICapabilities
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValueOnce(
        capabilities({
          providers: { local_model: false, tesseract: true, ocr: true },
          provider_controls: {
            local_model: {
              enabled: false,
              available: true,
              active: false,
              reason: 'Disabled in AI management.',
            },
            tesseract: { enabled: true, available: true, active: true, reason: null },
          },
        })
      )
      .mockResolvedValue(capabilities());

    const { getAllByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('open-ai-tools-button'));
    fireEvent.press(getByTestId('ai-tab-manage'));

    await waitFor(() => expect(ai.fetchTrainingStats).toHaveBeenCalled(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent(getByTestId('modal-provider-switch-local_model'), 'valueChange', false);
    await waitFor(() => expect(ai.setAIProviderEnabled).toHaveBeenCalledWith('local_model', false), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.changeText(getByTestId('manage-example-input'), 'Plan roadmap');
    fireEvent.press(getByTestId('manage-add-example-button'));
    await waitFor(() => expect(ai.addTrainingExample).toHaveBeenCalledWith('Plan roadmap', 2), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('ai-tools-message').props.children).toBe('Dodano przykład treningowy'), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.changeText(getByTestId('manage-feedback-input'), 'Plan roadmap');
    fireEvent.press(getByTestId('manage-feedback-button'));
    await waitFor(() => expect(ai.learnFromFeedback).toHaveBeenCalledWith('Plan roadmap', 1, 0), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('ai-tools-message').props.children).toBe('Zapisano feedback'), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('manage-retrain-button'));
    await waitFor(() => expect(ai.retrainModel).toHaveBeenCalledWith(true), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('ai-tools-message').props.children).toBe('Model został przetrenowany ponownie'), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('manage-load-examples-button'));
    await waitFor(() => expect(ai.getExamplesByQuadrant).toHaveBeenCalledWith(0, 5), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('ai-tools-message').props.children).toBe('Załadowano 1 przykładów'), {
      timeout: ASYNC_TIMEOUT,
    });
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
      remoteTask({ id: '507f1f77bcf86cd799439013', title: 'Scanned task', description: '', urgent: false, important: true })
    );

    const { getAllByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getAllByText('Brak zadań w tym kwadrancie.').length).toBe(4), {
      timeout: ASYNC_TIMEOUT,
    });
    fireEvent.press(getByTestId('scan-task-button'));

    await waitFor(() => expect(tasksApi.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Scanned task',
        important: true,
      }),
      'pl'
    ), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('OCR dodał zadania do tablicy'), {
      timeout: ASYNC_TIMEOUT,
    });
    expect(media.scanTasksFromImage).toHaveBeenCalledWith('pl');
  });

  it('uses local fallback for add, toggle, delete and reports unavailable central AI when the network is down', async () => {
    storage.loadTasks.mockResolvedValue([
      { id: 'local-1', title: 'Local task', description: '', urgent: false, important: false, locale: 'pl' },
    ]);
    tasksApi.fetchRemoteTasks.mockRejectedValue(new Error('offline'));
    tasksApi.createRemoteTask.mockRejectedValue(new Error('offline'));
    ai.fetchAICapabilities.mockResolvedValue(capabilities());
    ai.suggestTaskQuadrant.mockRejectedValue(new Error('offline'));

    const { getByPlaceholderText, getByTestId, getByText, getAllByText, queryByText } = render(<App />);

    await waitFor(() => expect(getByText('Local task')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zapisano lokalnie'), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.changeText(getByPlaceholderText('Tytuł zadania'), 'Offline task');
    fireEvent.press(getByTestId('suggest-task-button'));
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Centralna sugestia AI jest niedostępna'), {
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

    media.scanTasksFromImage.mockRejectedValueOnce({ code: 'ocr_request_failed' });
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
    storage.loadTasks.mockRejectedValueOnce(new Error('storage down'));
    tasksApi.fetchRemoteTasks.mockRejectedValueOnce(new Error('offline'));

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

  it('falls back through the bootstrap catch when startup throws synchronously', async () => {
    tasksApi.fetchRemoteTasks.mockImplementationOnce(() => {
      throw new Error('sync bootstrap failure');
    });

    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText(getSampleTasks('pl')[0].title)).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('shows validation and request errors across advanced analysis, OCR and batch AI flows', async () => {
    const { getByTestId } = render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('open-ai-tools-button'));
    fireEvent.changeText(getByTestId('ai-analysis-input'), '');
    fireEvent.press(getByTestId('ai-analysis-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Wpisz zadanie przed uruchomieniem analizy zaawansowanej'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    ai.analyzeTaskAdvanced.mockRejectedValueOnce(new Error('analysis down'));
    fireEvent.changeText(getByTestId('ai-analysis-input'), 'Roadmap');
    fireEvent.press(getByTestId('ai-analysis-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe('analysis down'), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('ai-tab-ocr'));
    media.scanTasksFromImage.mockResolvedValueOnce([]);
    fireEvent.press(getByTestId('ai-ocr-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-message').props.children).toBe(
      'OCR nie wykrył żadnych zadań'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    media.scanTasksFromImage.mockRejectedValueOnce({ code: 'provider_disabled' });
    fireEvent.press(getByTestId('ai-ocr-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Centralny OCR jest wyłączony'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('ai-tab-batch'));
    fireEvent.changeText(getByTestId('ai-batch-input'), '');
    fireEvent.press(getByTestId('ai-batch-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Wpisz przynajmniej jedno zadanie'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    ai.batchAnalyzeTasks.mockRejectedValueOnce(new Error('batch down'));
    fireEvent.changeText(getByTestId('ai-batch-input'), 'Task A');
    fireEvent.press(getByTestId('ai-batch-run-button'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe('batch down'), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('loads manage failures, provider toggle errors, clear action and analysis local fallback', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    ai.fetchTrainingStats.mockRejectedValueOnce(new Error('stats down'));
    ai.setAIProviderEnabled.mockRejectedValueOnce(new Error('toggle down'));
    tasksApi.createRemoteTask.mockRejectedValue(new Error('offline'));
    ai.analyzeTaskAdvanced.mockResolvedValueOnce({
      task: 'Fallback analysis',
      langchain_analysis: {
        quadrant: 0,
        reasoning: 'Fallback reasoning',
        confidence: 0.72,
        method: 'local-analysis',
      },
      rag_classification: {
        quadrant: 0,
        quadrant_name: 'Zrób teraz',
        confidence: 0.72,
      },
      comparison: {
        methods_agree: true,
        confidence_difference: 0,
      },
    });

    const { getAllByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('open-ai-tools-button'));
    fireEvent.press(getByTestId('ai-tab-manage'));
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe(
      'Nie udało się załadować statusu AI'
    ), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent(getByTestId('modal-provider-switch-local_model'), 'valueChange', false);
    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe('toggle down'), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('manage-clear-button'));
    await waitFor(() => expect(ai.clearTrainingData).toHaveBeenCalledWith(true), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('ai-tab-analysis'));
    fireEvent.changeText(getByTestId('ai-analysis-input'), 'Fallback analysis');
    fireEvent.press(getByTestId('ai-analysis-run-button'));
    await waitFor(() => expect(getByTestId('ai-analysis-add-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
    fireEvent.press(getByTestId('ai-analysis-add-button'));

    await waitFor(() => expect(getAllByText('Fallback analysis').length).toBeGreaterThan(0), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('notice-banner').props.children).toBe('Zapisano lokalnie'), {
      timeout: ASYNC_TIMEOUT,
    });
  });

  it('runs OCR from the AI tools modal and handles management action failures', async () => {
    storage.loadTasks.mockResolvedValue([]);
    tasksApi.fetchRemoteTasks.mockResolvedValue([]);
    media.scanTasksFromImage.mockResolvedValueOnce([
      {
        id: 'ocr-modal-1',
        title: 'Modal OCR task',
        description: '',
        urgent: false,
        important: true,
        locale: 'pl',
      },
    ]);
    tasksApi.createRemoteTask.mockResolvedValueOnce(
      remoteTask({
        id: '507f1f77bcf86cd799439099',
        title: 'Modal OCR task',
        description: '',
        urgent: false,
        important: true,
      })
    );
    ai.addTrainingExample.mockRejectedValueOnce(new Error('management failed'));

    const { getAllByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getByTestId('open-ai-tools-button')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('open-ai-tools-button'));
    fireEvent.press(getByTestId('ai-tab-ocr'));
    fireEvent.press(getByTestId('ai-ocr-run-button'));

    await waitFor(() => expect(getAllByText('Modal OCR task').length).toBeGreaterThan(0), {
      timeout: ASYNC_TIMEOUT,
    });
    await waitFor(() => expect(getByTestId('ai-tools-message').props.children).toBe('OCR zaimportował 1 zadań'), {
      timeout: ASYNC_TIMEOUT,
    });

    fireEvent.press(getByTestId('ai-tab-manage'));
    fireEvent.changeText(getByTestId('manage-example-input'), 'Nie zapisuj');
    fireEvent.press(getByTestId('manage-add-example-button'));

    await waitFor(() => expect(getByTestId('ai-tools-error').props.children).toBe('management failed'), {
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

    const { getAllByText, getByText, getByTestId } = render(<App />);

    await waitFor(() => expect(getAllByText('Brak zadań w tym kwadrancie.').length).toBe(4), {
      timeout: ASYNC_TIMEOUT,
    });
    fireEvent.press(getByTestId('scan-task-button'));

    await waitFor(() => expect(getByText('Offline scan')).toBeTruthy(), {
      timeout: ASYNC_TIMEOUT,
    });
  });
});
