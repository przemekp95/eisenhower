import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AITools from './AITools';
import { LanguageProvider } from '../i18n/LanguageContext';
import * as api from '../services/api';

jest.mock('../services/api');
const mockedApi = jest.mocked(api);

function renderTools(overrides: Partial<React.ComponentProps<typeof AITools>> = {}) {
  return render(
    <LanguageProvider>
      <AITools taskTitle="urgent roadmap" onClose={jest.fn()} {...overrides} />
    </LanguageProvider>
  );
}

async function waitForCapabilityCheck() {
  await waitFor(() =>
    expect(
      screen.queryByRole('status', { name: /checking AI availability|sprawdzam dostępność AI/i })
    ).not.toBeInTheDocument()
  );
}

describe('AITools task assistant', () => {
  beforeEach(() => {
    localStorage.setItem('eisenhower-language', 'en');
    mockedApi.getCapabilities.mockResolvedValue({
      classification: true,
      reasoned_local_analysis: true,
      knowledge_retrieval: true,
      retrieval_augmented_generation: true,
      langchain_analysis: false,
      ocr: true,
      batch_analysis: true,
      training_management: true,
      providers: { local_model: true, tesseract: true, ocr: true },
    } as api.AICapabilities);
    mockedApi.answerKnowledge.mockResolvedValue({
      status: 'answered',
      answer: 'Approved incident guidance.',
      claims: [{ statement: 'Approved incident guidance.', citation_ids: ['chunk-1'] }],
      citations: [
        {
          chunk_id: 'chunk-1',
          document_id: 'document-1',
          source_uri: 'eisenhower://repository/incident-policy',
          title: 'Incident policy',
          excerpt: 'Follow the approved incident process.',
          score: 0.9,
          content_version: 'v1',
        },
      ],
      retrieval: { hit_count: 1, top_score: 0.9, embedding_version: 'minilm-v1' },
      no_answer_reason: null,
    });
    mockedApi.classifyTask.mockResolvedValue({
      task: 'urgent roadmap',
      urgent: true,
      important: true,
      quadrant: 0,
      quadrant_name: 'Do Now',
      confidence: 0.9,
      timestamp: new Date().toISOString(),
      method: 'local',
    } as api.ClassificationResult);
    mockedApi.batchAnalyzeTasks.mockResolvedValue({
      batch_results: [],
      summary: { methods: {}, total_tasks: 1 },
      timestamp: new Date().toISOString(),
    });
  });

  it('combines task context, priority and grounded answers in one tab', async () => {
    renderTools({ taskDescription: 'Current context' });
    await waitForCapabilityCheck();
    expect(screen.getByRole('tab', { name: 'Task assistant' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('heading', { name: 'urgent roadmap' })).toBeInTheDocument();
    expect(screen.getByText('Current context')).toBeInTheDocument();
    expect(screen.getByText('Task priority')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check sources' }));
    await screen.findByText('Approved incident guidance.');
  });

  it('navigates utility tabs with arrow keys', () => {
    renderTools();
    const assistant = screen.getByRole('tab', { name: 'Task assistant' });
    const ocr = screen.getByRole('tab', { name: 'Read an image' });
    fireEvent.keyDown(assistant, { key: 'ArrowRight' });
    expect(ocr).toHaveAttribute('aria-selected', 'true');
    expect(ocr).toHaveFocus();
    fireEvent.keyDown(ocr, { key: 'ArrowLeft' });
    expect(assistant).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(assistant, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Bulk review' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Bulk review' }), { key: 'Enter' });
    assistant.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
  });

  it('applies the default no-op priority callback safely', async () => {
    renderTools();
    await waitForCapabilityCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest quadrant' }));
    await screen.findByText('Suggested quadrant: Do Now');
    fireEvent.click(screen.getByRole('button', { name: 'Review quadrant change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm quadrant change' }));
    await screen.findByText('Task quadrant updated.');
  });

  it('closes on Escape and backdrop, but not inside the dialog', () => {
    const onClose = jest.fn();
    renderTools({ onClose });
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('locks scroll, traps focus and restores the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const view = renderTools();
    await waitForCapabilityCheck();
    const close = screen.getByRole('button', { name: 'Close' });
    const lastAction = screen.getByRole('button', { name: 'Check sources' });
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(lastAction).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();
    opener.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(lastAction).toHaveFocus();
    view.unmount();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    opener.remove();
  });

  it('tolerates an opener removed before cleanup', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const view = renderTools();
    opener.remove();
    view.unmount();
  });

  it('handles an empty temporary focus list and non-navigation keys', () => {
    const onClose = jest.fn();
    renderTools({ onClose });
    const dialog = screen.getByRole('dialog');
    jest.spyOn(dialog, 'querySelectorAll').mockReturnValueOnce([] as never);
    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('compensates for a scrollbar gap and restores the padding', () => {
    const innerWidth = window.innerWidth;
    const clientWidth = document.documentElement.clientWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1180,
    });
    const view = renderTools();
    expect(document.body.style.paddingRight).toBe('20px');
    view.unmount();
    expect(document.body.style.paddingRight).toBe('');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: clientWidth,
    });
  });

  it('does not add body padding when there is no scrollbar gap', () => {
    const innerWidth = window.innerWidth;
    const clientWidth = document.documentElement.clientWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1200,
    });
    const view = renderTools();
    expect(document.body.style.paddingRight).toBe('');
    view.unmount();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: clientWidth,
    });
  });

  it('keeps OCR available as a secondary utility', async () => {
    const onOCRTasksExtracted = jest.fn().mockResolvedValue(1);
    mockedApi.extractTasksFromImage.mockResolvedValue({
      filename: 'tasks.txt',
      image_info: { size_bytes: 12, shape: 'unknown' },
      ocr: { extracted_text: 'urgent outage', raw_tasks_detected: 1, method: 'lazy-ocr' },
      classified_tasks: [
        { text: 'urgent outage', quadrant: 0, quadrant_name: 'Do Now', confidence: 0.8 },
      ],
      summary: {
        total_tasks: 1,
        quadrant_distribution: {
          counts: { 0: 1, 1: 0, 2: 0, 3: 0 },
          percentages: { 0: 100, 1: 0, 2: 0, 3: 0 },
          quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
        },
      },
      timestamp: new Date().toISOString(),
    });
    renderTools({ onOCRTasksExtracted });
    await waitForCapabilityCheck();
    fireEvent.click(screen.getByRole('tab', { name: 'Read an image' }));
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' })] },
    });
    await screen.findByDisplayValue('urgent outage');
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() => expect(onOCRTasksExtracted).toHaveBeenCalledTimes(1));
  });

  it('uses the English plural OCR summary', async () => {
    mockedApi.extractTasksFromImage.mockResolvedValue({
      filename: 'tasks.txt',
      image_info: { size_bytes: 12, shape: 'unknown' },
      ocr: { extracted_text: 'urgent outage', raw_tasks_detected: 1, method: 'lazy-ocr' },
      classified_tasks: [
        { text: 'urgent outage', quadrant: 0, quadrant_name: 'Do Now', confidence: 0.8 },
      ],
      summary: {
        total_tasks: 1,
        quadrant_distribution: {
          counts: { 0: 1, 1: 0, 2: 0, 3: 0 },
          percentages: { 0: 100, 1: 0, 2: 0, 3: 0 },
          quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
        },
      },
      timestamp: new Date().toISOString(),
    });
    renderTools({ onOCRTasksExtracted: jest.fn().mockResolvedValue(2) });
    await waitForCapabilityCheck();
    fireEvent.click(screen.getByRole('tab', { name: 'Read an image' }));
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' })] },
    });
    await screen.findByDisplayValue('urgent outage');
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    await screen.findByText('OCR added 2 tasks to the matrix.');
  });

  it('falls back safely when no OCR import callback is provided', async () => {
    mockedApi.extractTasksFromImage.mockResolvedValue({
      filename: 'tasks.txt',
      image_info: { size_bytes: 12, shape: 'unknown' },
      ocr: { extracted_text: 'urgent outage', raw_tasks_detected: 1, method: 'lazy-ocr' },
      classified_tasks: [
        { text: 'urgent outage', quadrant: 0, quadrant_name: 'Do Now', confidence: 0.8 },
      ],
      summary: {
        total_tasks: 1,
        quadrant_distribution: {
          counts: { 0: 1, 1: 0, 2: 0, 3: 0 },
          percentages: { 0: 100, 1: 0, 2: 0, 3: 0 },
          quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
        },
      },
      timestamp: new Date().toISOString(),
    });
    renderTools();
    await waitForCapabilityCheck();
    fireEvent.click(screen.getByRole('tab', { name: 'Read an image' }));
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' })] },
    });
    await screen.findByDisplayValue('urgent outage');
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    await screen.findByText('Added: 0. Not added: 1. Improve suggestions: no.');
  });

  it('reports completed batch review', async () => {
    renderTools();
    await waitForCapabilityCheck();
    fireEvent.click(screen.getByRole('tab', { name: 'Bulk review' }));
    fireEvent.change(screen.getByPlaceholderText(/One task per line/i), {
      target: { value: 'urgent outage' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review task list' }));
    await screen.findByText(/Bulk review processed 1 tasks/i);
  });

  it.each([
    [1, 'OCR dodał 1 zadanie do macierzy.'],
    [3, 'OCR dodał 3 zadania do macierzy.'],
    [12, 'OCR dodał 12 zadań do macierzy.'],
  ])('uses Polish OCR pluralization for %i imported tasks', async (count, summary) => {
    localStorage.setItem('eisenhower-language', 'pl');
    mockedApi.extractTasksFromImage.mockResolvedValue({
      filename: 'tasks.txt',
      image_info: { size_bytes: 12, shape: 'unknown' },
      ocr: { extracted_text: 'zadanie', raw_tasks_detected: 1, method: 'lazy-ocr' },
      classified_tasks: [
        { text: 'zadanie', quadrant: 0, quadrant_name: 'Zrób teraz', confidence: 0.8 },
      ],
      summary: {
        total_tasks: 1,
        quadrant_distribution: {
          counts: { 0: 1, 1: 0, 2: 0, 3: 0 },
          percentages: { 0: 100, 1: 0, 2: 0, 3: 0 },
          quadrant_names: { 0: 'Zrób teraz', 1: 'Deleguj', 2: 'Zaplanuj', 3: 'Usuń' },
        },
      },
      timestamp: new Date().toISOString(),
    });
    renderTools({ onOCRTasksExtracted: jest.fn().mockResolvedValue(count) });
    await waitForCapabilityCheck();
    fireEvent.click(screen.getByRole('tab', { name: 'Odczytaj obraz' }));
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['zadanie'], 'tasks.txt', { type: 'text/plain' })] },
    });
    await screen.findByDisplayValue('zadanie');
    fireEvent.click(screen.getByRole('button', { name: 'Importuj wybrane' }));
    await screen.findByText(summary);
  });

  it('keeps manual task recovery available when every optional AI capability is offline', async () => {
    mockedApi.getCapabilities.mockResolvedValueOnce({
      classification: false,
      reasoned_local_analysis: false,
      knowledge_retrieval: false,
      retrieval_augmented_generation: false,
      langchain_analysis: false,
      ocr: false,
      batch_analysis: false,
      training_management: false,
      providers: { local_model: false, tesseract: false, ocr: false },
    } as api.AICapabilities);
    const onClose = jest.fn();

    renderTools({ onClose });

    await screen.findByText(/AI help is currently unavailable/i);
    expect(screen.queryByRole('button', { name: 'Suggest quadrant' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check sources' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /choose the quadrant manually/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['classification', true, false],
    ['knowledge', false, true],
  ])(
    'keeps the available %s part of the combined assistant usable',
    async (_name, classification, knowledge) => {
      mockedApi.getCapabilities.mockResolvedValueOnce({
        classification,
        reasoned_local_analysis: classification,
        knowledge_retrieval: knowledge,
        retrieval_augmented_generation: knowledge,
        langchain_analysis: false,
        ocr: false,
        batch_analysis: false,
        training_management: false,
        providers: { local_model: classification, tesseract: false, ocr: false },
      } as api.AICapabilities);

      renderTools();
      await waitForCapabilityCheck();

      expect(screen.queryByRole('button', { name: 'Suggest quadrant' }) !== null).toBe(
        classification
      );
      expect(screen.queryByRole('button', { name: 'Check sources' }) !== null).toBe(knowledge);
    }
  );

  it('shows recovery instead of mounting unavailable OCR and batch tools', async () => {
    mockedApi.getCapabilities.mockResolvedValueOnce({
      classification: true,
      reasoned_local_analysis: true,
      knowledge_retrieval: false,
      retrieval_augmented_generation: false,
      langchain_analysis: false,
      ocr: false,
      batch_analysis: false,
      training_management: false,
      providers: { local_model: true, tesseract: false, ocr: false },
    } as api.AICapabilities);

    renderTools();
    await waitForCapabilityCheck();

    fireEvent.click(screen.getByRole('tab', { name: 'Read an image' }));
    expect(screen.queryByTestId('image-upload-input')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose the quadrant manually/i })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Bulk review' }));
    expect(screen.queryByRole('button', { name: 'Review task list' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose the quadrant manually/i })).toBeVisible();
  });

  it('gates every tool while capability availability is still being checked', async () => {
    let resolveCapabilities!: (capabilities: api.AICapabilities) => void;
    mockedApi.getCapabilities.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCapabilities = resolve;
        })
    );

    renderTools();

    expect(screen.getByRole('status', { name: /checking AI availability/i })).toHaveAttribute(
      'aria-busy',
      'true'
    );
    expect(screen.queryByRole('button', { name: 'Suggest quadrant' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Read an image' }));
    expect(screen.queryByTestId('image-upload-input')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Bulk review' }));
    expect(screen.queryByRole('button', { name: 'Review task list' })).not.toBeInTheDocument();

    await act(async () => resolveCapabilities(await mockedApi.getCapabilities()));
    await waitForCapabilityCheck();
  });

  it('retries an unavailable capability check without exposing provider details', async () => {
    mockedApi.getCapabilities
      .mockRejectedValueOnce(new Error('private provider details'))
      .mockResolvedValueOnce({
        classification: true,
        reasoned_local_analysis: true,
        knowledge_retrieval: true,
        retrieval_augmented_generation: true,
        langchain_analysis: false,
        ocr: true,
        batch_analysis: true,
        training_management: true,
        providers: { local_model: true, tesseract: true, ocr: true },
      } as api.AICapabilities);

    renderTools();

    await screen.findByText(/AI availability could not be checked/i);
    expect(screen.queryByText('private provider details')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /check AI availability again/i })[0]);
    await screen.findByText(/AI help is available/i);
    expect(screen.getByRole('button', { name: 'Suggest quadrant' })).toBeEnabled();
  });

  it('ignores a capability rejection after unmount cancels the request', async () => {
    let rejectCapabilities!: (reason: unknown) => void;
    mockedApi.getCapabilities.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCapabilities = reject;
        })
    );
    const view = renderTools();

    view.unmount();
    await act(async () => {
      rejectCapabilities(
        Object.assign(new Error('Request cancelled'), { code: 'request_cancelled' })
      );
    });
  });
});
