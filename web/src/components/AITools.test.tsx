import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AITools from './AITools';
import { LanguageProvider } from '../i18n/LanguageContext';
import * as api from '../services/api';
import { clearAdminToken, setAdminToken } from '../authSession';

jest.mock('../services/api');

const mockedApi = jest.mocked(api);

function renderTools(
  onOCRTasksExtracted = jest.fn(),
  overrides: Partial<React.ComponentProps<typeof AITools>> = {}
) {
  return render(
    <LanguageProvider>
      <AITools
        taskTitle="urgent roadmap"
        onClose={jest.fn()}
        onAnalysisComplete={jest.fn()}
        onOCRTasksExtracted={onOCRTasksExtracted}
        {...overrides}
      />
    </LanguageProvider>
  );
}

function ocrPayload(count: number) {
  return {
    filename: 'tasks.txt',
    image_info: { size_bytes: 12, shape: 'unknown' },
    ocr: { extracted_text: 'urgent outage', raw_tasks_detected: count, method: 'lazy-ocr' },
    classified_tasks: Array.from({ length: count }, (_, index) => ({
      text: `task ${index + 1}`,
      quadrant: 0,
      quadrant_name: 'Do Now',
      confidence: 0.8,
    })),
    summary: {
      total_tasks: count,
      quadrant_distribution: {
        counts: { 0: count, 1: 0, 2: 0, 3: 0 },
        percentages: { 0: 100, 1: 0, 2: 0, 3: 0 },
        quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
      },
    },
    timestamp: new Date().toISOString(),
  };
}

describe('AITools', () => {
  beforeEach(() => {
    localStorage.setItem('eisenhower-language', 'en');
    setAdminToken('test-admin-token');
    mockedApi.analyzeTask.mockResolvedValue({
      task: 'urgent roadmap',
      langchain_analysis: {
        quadrant: 0,
        reasoning: 'Critical path',
        confidence: 0.9,
        method: 'langchain',
      },
      rag_classification: { quadrant: 0, quadrant_name: 'Do Now', confidence: 0.85 },
      comparison: { methods_agree: true, confidence_difference: 0.05 },
      timestamp: new Date().toISOString(),
    });
    mockedApi.batchAnalyzeTasks.mockResolvedValue({
      batch_results: [
        {
          task: 'urgent outage',
          analyses: {
            rag: { quadrant: 0, confidence: 0.9, quadrant_name: 'Do Now' },
            langchain: { quadrant: 0, confidence: 0.92, reasoning: 'Immediate' },
          },
        },
      ],
      summary: { methods: { rag: { quadrant_distribution: { '0': 1 } } }, total_tasks: 1 },
      timestamp: new Date().toISOString(),
    });
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
    mockedApi.getTrainingStats.mockResolvedValue({
      total_examples: 8,
      quadrant_distribution: { '0': 2 },
      data_sources: { default: 8 },
      data_file: 'data.json',
      model_file: 'memory',
      last_updated: new Date().toISOString(),
    });
    mockedApi.getCapabilities.mockResolvedValue({
      classification: true,
      langchain_analysis: true,
      ocr: true,
      batch_analysis: true,
      training_management: true,
      providers: {
        local_model: true,
        tesseract: true,
        ocr: true,
      },
    });
    mockedApi.addTrainingExample.mockResolvedValue(undefined);
    mockedApi.learnFromFeedback.mockResolvedValue(undefined);
    mockedApi.retrainModel.mockResolvedValue({ preserve_experience: false });
    mockedApi.clearTrainingData.mockResolvedValue({
      message: 'Training data cleared.',
      remaining_examples: 8,
    });
    mockedApi.getExamplesByQuadrant.mockResolvedValue({
      examples: [{ text: 'urgent outage', quadrant: 0 }],
    });
    mockedApi.analyzeTaskWithRag.mockResolvedValue({
      mode: 'fallback',
      quadrant: 0,
      quadrant_name: 'Do Now',
      confidence: 0.8,
      explanation: 'Classifier fallback.',
      citations: [],
      retrieval: { hit_count: 0, top_score: null, embedding_version: null },
      fallback_reason: 'rag_response_disabled',
    });
  });

  afterEach(() => clearAdminToken());

  it('requests the admin credential only after entering management and allows recredentialing', () => {
    clearAdminToken();
    renderTools();

    expect(screen.queryByLabelText('AI administrator token')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Manage' }));
    fireEvent.change(screen.getByLabelText('AI administrator token'), {
      target: { value: 'admin-only' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock management' }));
    expect(screen.getByRole('button', { name: 'Change administrator token' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change administrator token' }));
    expect(screen.getByLabelText('AI administrator token')).toBeInTheDocument();
  });

  it('runs advanced analysis', async () => {
    renderTools();

    fireEvent.click(screen.getByText(/Run advanced analysis/i));

    await waitFor(() => expect(screen.getByText(/Critical path/i)).toBeInTheDocument());
  });

  it('exposes the governed RAG panel with tab semantics', async () => {
    renderTools();

    const groundedTab = screen.getByRole('tab', { name: 'Grounded RAG' });
    expect(screen.getByRole('tab', { name: 'Advanced analysis' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    fireEvent.click(groundedTab);

    expect(groundedTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'ai-tab-grounded');
    fireEvent.click(screen.getByRole('button', { name: 'Run grounded analysis' }));
    await waitFor(() => expect(screen.getByText('Fallback')).toBeInTheDocument());
  });

  it('supports arrow-key tab navigation in both directions', () => {
    renderTools();
    const advanced = screen.getByRole('tab', { name: 'Advanced analysis' });
    const grounded = screen.getByRole('tab', { name: 'Grounded RAG' });

    fireEvent.keyDown(advanced, { key: 'Enter' });
    expect(advanced).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(advanced, { key: 'ArrowRight' });
    expect(grounded).toHaveAttribute('aria-selected', 'true');
    expect(grounded).toHaveFocus();
    fireEvent.keyDown(grounded, { key: 'ArrowLeft' });
    expect(advanced).toHaveAttribute('aria-selected', 'true');
    expect(advanced).toHaveFocus();
  });

  it('localizes the deferred administrator credential gate', () => {
    localStorage.setItem('eisenhower-language', 'pl');
    clearAdminToken();
    renderTools();

    fireEvent.click(screen.getByRole('tab', { name: 'Zarządzanie' }));
    expect(screen.getByText('Dostęp administracyjny')).toBeInTheDocument();
    expect(screen.getByLabelText('Token administratora AI')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Odblokuj zarządzanie' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Token administratora AI'), {
      target: { value: 'polski-admin' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Odblokuj zarządzanie' }));
    expect(screen.getByRole('button', { name: 'Zmień token administratora' })).toBeInTheDocument();
  });

  it('focuses the close action, traps focus, and restores the opener', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open tools';
    document.body.appendChild(opener);
    opener.focus();

    const view = renderTools();
    const close = screen.getByRole('button', { name: 'Close' });
    const analysis = screen.getByRole('button', { name: 'Run advanced analysis' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(analysis).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();

    screen.getByRole('tab', { name: 'Grounded RAG' }).focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(screen.getByRole('tab', { name: 'Grounded RAG' })).toHaveFocus();

    opener.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(analysis).toHaveFocus();

    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('keeps focus inside a temporarily empty dialog and tolerates a removed opener', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const view = renderTools();
    const dialog = screen.getByRole('dialog');
    const query = jest.spyOn(dialog, 'querySelectorAll').mockReturnValueOnce([] as never);

    fireEvent.keyDown(window, { key: 'Tab' });
    expect(query).toHaveBeenCalled();

    opener.remove();
    view.unmount();
  });

  it('locks page scroll while the modal is open and restores it on unmount', () => {
    const { unmount } = renderTools();

    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overflow).toBe('hidden');

    unmount();

    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('portals the fixed dialog outside a transformed application container', () => {
    const view = render(
      <div data-app-matrix style={{ transform: 'translate3d(0, 0, 0)' }}>
        <LanguageProvider>
          <AITools taskTitle="urgent roadmap" onClose={jest.fn()} onAnalysisComplete={jest.fn()} />
        </LanguageProvider>
      </div>
    );

    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('adds body padding when the viewport has a scrollbar gap', () => {
    const originalInnerWidth = window.innerWidth;
    const originalClientWidth = document.documentElement.clientWidth;

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1180,
    });

    const { unmount } = renderTools();

    expect(document.body.style.paddingRight).toBe('20px');

    unmount();

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: originalClientWidth,
    });
  });

  it('does not add body padding when the viewport has no scrollbar gap', () => {
    const originalInnerWidth = window.innerWidth;
    const originalClientWidth = document.documentElement.clientWidth;

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1200,
    });

    const { unmount } = renderTools();

    expect(document.body.style.paddingRight).toBe('');

    unmount();

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: originalClientWidth,
    });
  });

  it('closes the modal on Escape', () => {
    const onClose = jest.fn();
    renderTools(jest.fn(), { onClose });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores non-Escape key presses', () => {
    const onClose = jest.fn();
    renderTools(jest.fn(), { onClose });

    fireEvent.keyDown(window, { key: 'Enter' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes the modal when clicking the backdrop', () => {
    const onClose = jest.fn();
    renderTools(jest.fn(), { onClose });
    const backdrop = screen.getByRole('dialog').parentElement?.parentElement;

    fireEvent.mouseDown(backdrop!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close the modal when clicking inside the dialog', () => {
    const onClose = jest.fn();
    renderTools(jest.fn(), { onClose });

    fireEvent.mouseDown(screen.getByRole('dialog'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close the modal when clicking the layout wrapper above the dialog', () => {
    const onClose = jest.fn();
    renderTools(jest.fn(), { onClose });

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as Element);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('switches to batch and OCR tools', async () => {
    const onOCRTasksExtracted = jest.fn().mockResolvedValue(1);
    renderTools(onOCRTasksExtracted);

    fireEvent.click(screen.getByText('Bulk review'));
    fireEvent.change(screen.getByPlaceholderText(/One task per line/i), {
      target: { value: 'urgent outage' },
    });
    fireEvent.click(screen.getByText(/Review task list/i));
    await waitFor(() => expect(screen.getByText(/urgent outage: Do Now/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('OCR'));
    const file = new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });
    await waitFor(() => expect(screen.getByDisplayValue('urgent outage')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() => expect(onOCRTasksExtracted).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/OCR added 1 task to the matrix/i)).toBeInTheDocument();
  });

  it('falls back to the OCR total when no matrix import handler is provided', async () => {
    render(
      <LanguageProvider>
        <AITools taskTitle="urgent roadmap" onClose={jest.fn()} onAnalysisComplete={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByText('OCR'));
    const file = new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });
    await screen.findByDisplayValue('urgent outage');
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() => expect(screen.getByText(/Persisted: 0. Failed: 1/i)).toBeInTheDocument());
  });

  it('uses the plural English OCR import summary', async () => {
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(ocrPayload(3));

    renderTools(jest.fn().mockResolvedValue(3));

    fireEvent.click(screen.getByText('OCR'));
    const file = new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });
    await screen.findByDisplayValue('task 1');
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() =>
      expect(screen.getByText(/OCR added 3 tasks to the matrix/i)).toBeInTheDocument()
    );
  });

  it('uses the singular Polish OCR import summary', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(ocrPayload(1));

    renderTools(jest.fn().mockResolvedValue(1));

    fireEvent.click(screen.getByText('OCR'));
    const file = new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });
    await screen.findByDisplayValue('task 1');
    fireEvent.click(screen.getByRole('button', { name: 'Importuj wybrane' }));
    await waitFor(() =>
      expect(screen.getByText(/OCR dodał 1 zadanie do macierzy/i)).toBeInTheDocument()
    );
  });

  it('uses the few-count Polish OCR import summary', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(ocrPayload(2));

    renderTools(jest.fn().mockResolvedValue(2));

    fireEvent.click(screen.getByText('OCR'));
    const file = new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });
    await screen.findByDisplayValue('task 1');
    fireEvent.click(screen.getByRole('button', { name: 'Importuj wybrane' }));
    await waitFor(() =>
      expect(screen.getByText(/OCR dodał 2 zadania do macierzy/i)).toBeInTheDocument()
    );
  });

  it('uses the many-count Polish OCR import summary', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(ocrPayload(5));

    renderTools(jest.fn().mockResolvedValue(5));

    fireEvent.click(screen.getByText('OCR'));
    const file = new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });
    await screen.findByDisplayValue('task 1');
    fireEvent.click(screen.getByRole('button', { name: 'Importuj wybrane' }));
    await waitFor(() =>
      expect(screen.getByText(/OCR dodał 5 zadań do macierzy/i)).toBeInTheDocument()
    );
  });

  it('uses the many-count Polish OCR import summary for teen values', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(ocrPayload(12));

    renderTools(jest.fn().mockResolvedValue(12));

    fireEvent.click(screen.getByText('OCR'));
    const file = new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });
    await screen.findByDisplayValue('task 1');
    fireEvent.click(screen.getByRole('button', { name: 'Importuj wybrane' }));
    await waitFor(() =>
      expect(screen.getByText(/OCR dodał 12 zadań do macierzy/i)).toBeInTheDocument()
    );
  });

  it('handles AI management actions', async () => {
    renderTools();

    fireEvent.click(screen.getByText('Manage'));

    await waitFor(() =>
      expect(screen.getByText(/Total examples in the experience store/i)).toBeInTheDocument()
    );
    fireEvent.change(screen.getByPlaceholderText(/Task text/i), {
      target: { value: 'Review architecture notes' },
    });
    fireEvent.click(screen.getByText(/Add example/i));
    await waitFor(() =>
      expect(mockedApi.addTrainingExample).toHaveBeenCalledWith('Review architecture notes', 2)
    );

    fireEvent.change(screen.getByPlaceholderText(/Task corrected by the user/i), {
      target: { value: 'Escalate vendor issue' },
    });
    fireEvent.click(screen.getByText(/Learn feedback/i));
    await waitFor(() =>
      expect(mockedApi.learnFromFeedback).toHaveBeenCalledWith('Escalate vendor issue', 1, 0)
    );

    fireEvent.click(screen.getByRole('button', { name: /^Retrain$/i }));
    await waitFor(() => expect(mockedApi.retrainModel).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByText(/Clear training data/i));
    fireEvent.click(screen.getByText(/Confirm clearing training data/i));
    await waitFor(() => expect(mockedApi.clearTrainingData).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByText(/Load examples/i));
    await waitFor(() => expect(screen.getByText(/urgent outage/i)).toBeInTheDocument());
  });
});
