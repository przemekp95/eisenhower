import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdvancedAIAnalysis from './AdvancedAIAnalysis';
import BatchAnalysis from './BatchAnalysis';
import ImageUpload from './ImageUpload';
import * as api from '../../services/api';
import { LanguageProvider } from '../../i18n/LanguageContext';
import { useLanguage } from '../../i18n/LanguageContext';

jest.mock('../../services/api');

const mockedApi = jest.mocked(api);

function renderWithLanguage(ui: React.ReactElement) {
  return render(<LanguageProvider>{ui}</LanguageProvider>);
}

function reviewedOcrPayload() {
  return {
    filename: 'tasks.txt',
    image_info: { size_bytes: 12, shape: 'unknown' },
    ocr: { extracted_text: 'first\nsecond', raw_tasks_detected: 2, method: 'lazy-ocr' },
    classified_tasks: [
      { text: 'first', quadrant: 0 as const, quadrant_name: 'Do Now', confidence: 0.8 },
      { text: 'second', quadrant: 2 as const, quadrant_name: 'Schedule', confidence: 0.7 },
    ],
    summary: {
      total_tasks: 2,
      quadrant_distribution: {
        counts: { 0: 1, 1: 0, 2: 1, 3: 0 },
        percentages: { 0: 50, 1: 0, 2: 50, 3: 0 },
        quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
      },
    },
  };
}

describe('AI component error paths', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    localStorage.setItem('eisenhower-language', 'en');
  });

  it('renders analysis errors', async () => {
    mockedApi.analyzeTask.mockRejectedValueOnce(new Error('Local analysis offline'));

    renderWithLanguage(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getByText(/Get a task suggestion/i));

    await waitFor(() =>
      expect(screen.getByText('This suggestion is currently unavailable.')).toBeInTheDocument()
    );
  });

  it('clears a stale advanced result before retry and keeps it cleared after failure', async () => {
    mockedApi.analyzeTask
      .mockResolvedValueOnce({
        task: 'task',
        langchain_analysis: {
          quadrant: 0,
          reasoning: 'Stale recommendation',
          confidence: 0.9,
          method: 'local-analysis',
        },
        rag_classification: { quadrant: 0, quadrant_name: 'Do Now', confidence: 0.9 },
        comparison: { methods_agree: true, confidence_difference: 0 },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Request timed out'), { code: 'request_timeout' })
      );
    renderWithLanguage(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);

    fireEvent.click(screen.getByText(/Get a task suggestion/i));
    await screen.findByText('Stale recommendation');
    fireEvent.click(screen.getByText(/Get a task suggestion/i));

    await screen.findByText(/took too long/i);
    expect(screen.queryByText('Stale recommendation')).not.toBeInTheDocument();
    expect(screen.getByText(/choose a quadrant manually/i)).toBeInTheDocument();
  });

  it('cancels an in-flight advanced request when the component unmounts', () => {
    let signal: AbortSignal | undefined;
    mockedApi.analyzeTask.mockImplementationOnce((_task, _language, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    });
    const view = renderWithLanguage(
      <AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />
    );

    fireEvent.click(screen.getByText(/Get a task suggestion/i));
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('treats an explicit advanced-request cancellation as silent and ignores its cleanup after the task changes', async () => {
    let rejectAnalysis!: (reason: unknown) => void;
    mockedApi.analyzeTask.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAnalysis = reject;
        })
    );
    const view = renderWithLanguage(
      <AdvancedAIAnalysis taskTitle="old task" onAnalysisComplete={jest.fn()} />
    );

    fireEvent.click(screen.getByText(/Get a task suggestion/i));
    view.rerender(
      <LanguageProvider>
        <AdvancedAIAnalysis taskTitle="new task" onAnalysisComplete={jest.fn()} />
      </LanguageProvider>
    );
    await act(async () => {
      rejectAnalysis(Object.assign(new Error('Request cancelled'), { code: 'request_cancelled' }));
    });

    expect(screen.queryByText(/currently unavailable|took too long/i)).not.toBeInTheDocument();
  });

  it('ignores empty advanced-analysis titles and falls back on unknown failures', async () => {
    renderWithLanguage(<AdvancedAIAnalysis taskTitle="   " onAnalysisComplete={jest.fn()} />);

    const disabledButton = screen.getByText(/Get a task suggestion/i) as HTMLButtonElement;
    disabledButton.removeAttribute('disabled');
    disabledButton.disabled = false;
    fireEvent.click(disabledButton);

    expect(mockedApi.analyzeTask).not.toHaveBeenCalled();

    mockedApi.analyzeTask.mockRejectedValueOnce('offline');

    renderWithLanguage(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getAllByText(/Get a task suggestion/i)[1]);

    await waitFor(() =>
      expect(screen.getByText('This suggestion is currently unavailable.')).toBeInTheDocument()
    );
  });

  it('renders the fallback suggested quadrant when langchain does not return one', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    mockedApi.analyzeTask.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: null,
        reasoning: 'Wymaga zaplanowania.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Delegate',
        confidence: 0.7,
      },
      comparison: {
        methods_agree: false,
        confidence_difference: 0.1,
      },
      timestamp: new Date().toISOString(),
    });

    renderWithLanguage(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getByText(/Uzyskaj podpowiedź dla zadania/i));

    await waitFor(() =>
      expect(screen.getByText(/Sugerowany kwadrant: Deleguj/i)).toBeInTheDocument()
    );
    expect(mockedApi.analyzeTask).toHaveBeenCalledWith(
      'task',
      'pl',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('falls back to an unknown quadrant label in advanced analysis', async () => {
    mockedApi.analyzeTask.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 9 as unknown as 0,
        reasoning: 'Unexpected quadrant.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Delegate',
        confidence: 0.7,
      },
      comparison: {
        methods_agree: false,
        confidence_difference: 0.1,
      },
      timestamp: new Date().toISOString(),
    });

    renderWithLanguage(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getByText(/Get a task suggestion/i));

    await waitFor(() =>
      expect(screen.getByText(/Suggested quadrant: Unknown decision \(9\)/i)).toBeInTheDocument()
    );
  });

  it('clears stale advanced analysis when the language changes', async () => {
    mockedApi.analyzeTask.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 1,
        reasoning: 'Needs delegation.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Delegate',
        confidence: 0.7,
      },
      comparison: {
        methods_agree: true,
        confidence_difference: 0.1,
      },
      timestamp: new Date().toISOString(),
    });

    function Harness() {
      const { setLanguage } = useLanguage();

      return (
        <>
          <button type="button" onClick={() => setLanguage('pl')}>
            switch
          </button>
          <AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />
        </>
      );
    }

    renderWithLanguage(<Harness />);
    fireEvent.click(screen.getByText(/Get a task suggestion/i));

    await waitFor(() =>
      expect(screen.getByText(/Suggested quadrant: Delegate/i)).toBeInTheDocument()
    );

    await act(async () => {
      fireEvent.click(screen.getByText('switch'));
    });

    await waitFor(() => expect(screen.queryByText(/Suggested quadrant:/i)).not.toBeInTheDocument());
  });

  it('adds the advanced-analysis result to the matrix when requested', async () => {
    const onAddToMatrix = jest.fn().mockResolvedValue(undefined);

    mockedApi.analyzeTask.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 1,
        reasoning: 'Needs delegation.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Delegate',
        confidence: 0.7,
      },
      comparison: {
        methods_agree: true,
        confidence_difference: 0.1,
      },
      timestamp: new Date().toISOString(),
    });

    renderWithLanguage(
      <AdvancedAIAnalysis
        taskTitle="task"
        onAnalysisComplete={jest.fn()}
        onAddToMatrix={onAddToMatrix}
      />
    );

    fireEvent.click(screen.getByText(/Get a task suggestion/i));
    await waitFor(() => expect(screen.getByText(/Add to matrix/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Add to matrix/i));

    await waitFor(() => expect(onAddToMatrix).toHaveBeenCalledTimes(1));
  });

  it('surfaces failures when adding the advanced-analysis result to the matrix', async () => {
    const onAddToMatrix = jest.fn().mockRejectedValue('offline');

    mockedApi.analyzeTask.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 1,
        reasoning: 'Needs delegation.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Delegate',
        confidence: 0.7,
      },
      comparison: {
        methods_agree: true,
        confidence_difference: 0.1,
      },
      timestamp: new Date().toISOString(),
    });

    renderWithLanguage(
      <AdvancedAIAnalysis
        taskTitle="task"
        onAnalysisComplete={jest.fn()}
        onAddToMatrix={onAddToMatrix}
      />
    );

    fireEvent.click(screen.getByText(/Get a task suggestion/i));
    await waitFor(() => expect(screen.getByText(/Add to matrix/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Add to matrix/i));

    await waitFor(() => expect(screen.getByText('Adding to matrix failed')).toBeInTheDocument());
  });

  it('surfaces Error instances when adding the advanced-analysis result to the matrix', async () => {
    const onAddToMatrix = jest.fn().mockRejectedValue(new Error('Matrix unavailable'));

    mockedApi.analyzeTask.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 1,
        reasoning: 'Needs delegation.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Delegate',
        confidence: 0.7,
      },
      comparison: {
        methods_agree: true,
        confidence_difference: 0.1,
      },
      timestamp: new Date().toISOString(),
    });

    renderWithLanguage(
      <AdvancedAIAnalysis
        taskTitle="task"
        onAnalysisComplete={jest.fn()}
        onAddToMatrix={onAddToMatrix}
      />
    );

    fireEvent.click(screen.getByText(/Get a task suggestion/i));
    await waitFor(() => expect(screen.getByText(/Add to matrix/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Add to matrix/i));

    await waitFor(() => expect(screen.getByText('Adding to matrix failed')).toBeInTheDocument());
  });

  it('validates and handles batch failures', async () => {
    mockedApi.batchAnalyzeTasks.mockRejectedValueOnce(new Error('Batch failed'));

    renderWithLanguage(<BatchAnalysis onBatchComplete={jest.fn()} />);
    fireEvent.click(screen.getByText(/Review task list/i));
    expect(screen.getByText(/Add at least one task/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/One task per line/i), {
      target: { value: 'task one' },
    });
    fireEvent.click(screen.getByText(/Review task list/i));

    await waitFor(() => expect(screen.getByText('Bulk review failed')).toBeInTheDocument());
  });

  it('falls back on unknown batch failures', async () => {
    mockedApi.batchAnalyzeTasks.mockRejectedValueOnce('offline');

    renderWithLanguage(<BatchAnalysis onBatchComplete={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/One task per line/i), {
      target: { value: 'task one' },
    });
    fireEvent.click(screen.getByText(/Review task list/i));

    await waitFor(() => expect(screen.getByText('Bulk review failed')).toBeInTheDocument());
  });

  it('treats an explicit batch cancellation as silent', async () => {
    mockedApi.batchAnalyzeTasks.mockRejectedValueOnce(
      Object.assign(new Error('Request cancelled'), { code: 'request_cancelled' })
    );

    renderWithLanguage(<BatchAnalysis onBatchComplete={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/One task per line/i), {
      target: { value: 'task one' },
    });
    fireEvent.click(screen.getByText(/Review task list/i));

    await waitFor(() => expect(screen.getByText(/Review task list/i)).toBeInTheDocument());
    expect(screen.queryByText('Bulk review failed')).not.toBeInTheDocument();
  });

  it('cancels an in-flight batch review and ignores its late result when the list changes', async () => {
    let resolveBatch!: (result: api.BatchAnalysisResult) => void;
    let signal: AbortSignal | undefined;
    mockedApi.batchAnalyzeTasks.mockImplementationOnce((_tasks, options) => {
      signal = options?.signal;
      return new Promise((resolve) => {
        resolveBatch = resolve;
      });
    });
    const onBatchComplete = jest.fn();
    renderWithLanguage(<BatchAnalysis onBatchComplete={onBatchComplete} />);
    const textarea = screen.getByPlaceholderText(/One task per line/i);

    fireEvent.change(textarea, { target: { value: 'old task' } });
    fireEvent.click(screen.getByText(/Review task list/i));
    expect(signal?.aborted).toBe(false);
    expect(screen.getByText(/Reviewing task list/i)).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'new task' } });
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText(/Review task list/i)).toBeInTheDocument();
    expect(screen.queryByText(/Bulk review failed/i)).not.toBeInTheDocument();

    await act(async () => {
      resolveBatch({
        batch_results: [
          {
            task: 'old task',
            analyses: {
              rag: { quadrant: 0, confidence: 0.9, quadrant_name: 'Do Now' },
              langchain: { quadrant: 0, confidence: 0.9, reasoning: 'Old response' },
            },
          },
        ],
        summary: { methods: { rag: { quadrant_distribution: { '0': 1 } } }, total_tasks: 1 },
        timestamp: new Date().toISOString(),
      });
    });

    expect(screen.queryByText(/old task: Do Now/i)).not.toBeInTheDocument();
    expect(onBatchComplete).not.toHaveBeenCalled();
  });

  it('silently ignores an aborted batch rejection after the task list changes', async () => {
    let rejectBatch!: (reason: unknown) => void;
    mockedApi.batchAnalyzeTasks.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectBatch = reject;
        })
    );
    renderWithLanguage(<BatchAnalysis onBatchComplete={jest.fn()} />);
    const textarea = screen.getByPlaceholderText(/One task per line/i);

    fireEvent.change(textarea, { target: { value: 'old task' } });
    fireEvent.click(screen.getByText(/Review task list/i));
    fireEvent.change(textarea, { target: { value: 'new task' } });
    await act(async () => {
      rejectBatch(Object.assign(new Error('Request cancelled'), { code: 'request_cancelled' }));
    });

    expect(screen.queryByText(/Bulk review failed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Review task list/i)).toBeInTheDocument();
  });

  it('falls back to an unknown quadrant label in batch review', async () => {
    mockedApi.batchAnalyzeTasks.mockResolvedValueOnce({
      batch_results: [
        {
          task: 'odd task',
          analyses: {
            rag: { quadrant: 9, confidence: 0.4, quadrant_name: 'Unknown' },
            langchain: { quadrant: 9, confidence: 0.4, reasoning: 'Unexpected' },
          },
        },
      ],
      summary: { methods: { rag: { quadrant_distribution: { '9': 1 } } }, total_tasks: 1 },
      timestamp: new Date().toISOString(),
    });

    renderWithLanguage(<BatchAnalysis onBatchComplete={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/One task per line/i), {
      target: { value: 'odd task' },
    });
    fireEvent.click(screen.getByText(/Review task list/i));

    await waitFor(() =>
      expect(screen.getByText(/odd task: Unknown decision \(9\)/i)).toBeInTheDocument()
    );
  });

  it('handles OCR upload failures', async () => {
    mockedApi.extractTasksFromImage.mockRejectedValueOnce(new Error('OCR unavailable'));

    renderWithLanguage(<ImageUpload onTasksExtracted={jest.fn()} />);
    const file = new File(['task'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(screen.getByText('The image could not be read')).toBeInTheDocument()
    );
  });

  it('offers separate gallery and rear-camera inputs with review-first privacy guidance', () => {
    const inputClickSpy = jest
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderWithLanguage(<ImageUpload onTasksExtracted={jest.fn()} />);

    expect(screen.getByTestId('image-upload-input')).not.toHaveAttribute('capture');
    expect(screen.getByTestId('image-camera-input')).toHaveAttribute('accept', 'image/*');
    expect(screen.getByTestId('image-camera-input')).toHaveAttribute('capture', 'environment');
    expect(screen.getByRole('button', { name: 'Choose from gallery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Review extracted tasks before import. The selected image is used only for this scan.'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take photo' }));
    expect(inputClickSpy).toHaveBeenCalledTimes(1);
    inputClickSpy.mockRestore();
  });

  it('silently ignores an OCR cancellation that settles after unmount', async () => {
    let rejectOcr!: (reason: unknown) => void;
    mockedApi.extractTasksFromImage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOcr = reject;
        })
    );
    const view = renderWithLanguage(<ImageUpload onTasksExtracted={jest.fn()} />);
    const file = new File(['task'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    view.unmount();
    await act(async () => {
      rejectOcr(Object.assign(new Error('Request cancelled'), { code: 'request_cancelled' }));
    });
  });

  it('requires OCR review and explicit import before persisting selected edited tasks', async () => {
    const onTasksExtracted = jest.fn().mockResolvedValue({ imported: 1, failed: 0 });
    mockedApi.extractTasksFromImage.mockResolvedValueOnce({
      filename: 'tasks.txt',
      image_info: { size_bytes: 12, shape: 'unknown' },
      ocr: { extracted_text: 'draft', raw_tasks_detected: 1, method: 'lazy-ocr' },
      classified_tasks: [{ text: 'draft', quadrant: 3, quadrant_name: 'Delete', confidence: 0.8 }],
      summary: {
        total_tasks: 1,
        quadrant_distribution: {
          counts: { 0: 0, 1: 0, 2: 0, 3: 1 },
          percentages: { 0: 0, 1: 0, 2: 0, 3: 100 },
          quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
        },
      },
      timestamp: new Date().toISOString(),
    });

    render(
      <LanguageProvider>
        <ImageUpload onTasksExtracted={onTasksExtracted} />
      </LanguageProvider>
    );
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['draft'], 'tasks.txt', { type: 'text/plain' })] },
    });

    await screen.findByDisplayValue('draft');
    expect(onTasksExtracted).not.toHaveBeenCalled();
    fireEvent.change(screen.getByDisplayValue('draft'), { target: { value: 'edited task' } });
    fireEvent.change(screen.getByLabelText(/Quadrant for edited task/i), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Import selected/i }));

    await waitFor(() =>
      expect(onTasksExtracted).toHaveBeenCalledWith(
        expect.objectContaining({
          classified_tasks: [expect.objectContaining({ text: 'edited task', quadrant: 2 })],
        })
      )
    );
  });

  it('requires at least one selected non-empty reviewed task', async () => {
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(reviewedOcrPayload());
    renderWithLanguage(<ImageUpload onTasksExtracted={jest.fn()} />);
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['tasks'], 'tasks.txt', { type: 'text/plain' })] },
    });

    const first = await screen.findByLabelText(/Include task: first/i);
    const second = screen.getByLabelText(/Include task: second/i);
    fireEvent.click(first);
    fireEvent.click(second);
    fireEvent.click(screen.getByRole('button', { name: /Import selected/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Select at least one non-empty task.'
    );
  });

  it('reports a failed reviewed-task import', async () => {
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(reviewedOcrPayload());
    const onTasksExtracted = jest.fn().mockRejectedValue(new Error('offline'));
    renderWithLanguage(<ImageUpload onTasksExtracted={onTasksExtracted} />);
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['tasks'], 'tasks.txt', { type: 'text/plain' })] },
    });

    await screen.findByDisplayValue('first');
    fireEvent.click(screen.getByRole('button', { name: /Import selected/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The image could not be read');
  });

  it.each([
    [1, 'Added: 1. Not added: 1.'],
    [undefined, 'Added: 0. Not added: 2.'],
  ])(
    'normalizes the reviewed import response %p into a business summary',
    async (response, summary) => {
      mockedApi.extractTasksFromImage.mockResolvedValueOnce(reviewedOcrPayload());
      const onTasksExtracted = jest.fn().mockResolvedValue(response);
      renderWithLanguage(<ImageUpload onTasksExtracted={onTasksExtracted} />);
      fireEvent.change(screen.getByTestId('image-upload-input'), {
        target: { files: [new File(['tasks'], 'tasks.txt', { type: 'text/plain' })] },
      });

      await screen.findByDisplayValue('first');
      fireEvent.click(screen.getByRole('button', { name: /Import selected/i }));

      expect(await screen.findByRole('status')).toHaveTextContent(summary as string);
    }
  );

  it('renders the reviewed import summary in Polish', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(reviewedOcrPayload());
    const onTasksExtracted = jest.fn().mockResolvedValue({ imported: 2, failed: 0 });
    renderWithLanguage(<ImageUpload onTasksExtracted={onTasksExtracted} />);
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['tasks'], 'tasks.txt', { type: 'text/plain' })] },
    });

    await screen.findByDisplayValue('first');
    fireEvent.click(screen.getByRole('button', { name: 'Importuj wybrane' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Dodano: 2. Nie dodano: 0.');
  });

  it('ignores empty OCR selections, opens the file picker, and falls back on unknown OCR failures', async () => {
    const inputClickSpy = jest
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    mockedApi.extractTasksFromImage.mockRejectedValueOnce('offline');

    renderWithLanguage(<ImageUpload onTasksExtracted={jest.fn()} />);

    fireEvent.click(screen.getByText(/Choose from gallery/i));
    expect(inputClickSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [] },
    });
    expect(mockedApi.extractTasksFromImage).not.toHaveBeenCalled();

    const file = new File(['task'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(screen.getByText('The image could not be read')).toBeInTheDocument()
    );

    inputClickSpy.mockRestore();
  });
});
