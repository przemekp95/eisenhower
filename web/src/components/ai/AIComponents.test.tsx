import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdvancedAIAnalysis from './AdvancedAIAnalysis';
import BatchAnalysis from './BatchAnalysis';
import ImageUpload from './ImageUpload';
import AIManagement from './AIManagement';
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
    fireEvent.click(screen.getByText(/Run advanced analysis/i));

    await waitFor(() => expect(screen.getByText('Analysis failed')).toBeInTheDocument());
  });

  it('ignores empty advanced-analysis titles and falls back on unknown failures', async () => {
    renderWithLanguage(<AdvancedAIAnalysis taskTitle="   " onAnalysisComplete={jest.fn()} />);

    const disabledButton = screen.getByText(/Run advanced analysis/i) as HTMLButtonElement;
    disabledButton.removeAttribute('disabled');
    disabledButton.disabled = false;
    fireEvent.click(disabledButton);

    expect(mockedApi.analyzeTask).not.toHaveBeenCalled();

    mockedApi.analyzeTask.mockRejectedValueOnce('offline');

    renderWithLanguage(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getAllByText(/Run advanced analysis/i)[1]);

    await waitFor(() => expect(screen.getByText('Analysis failed')).toBeInTheDocument());
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
    fireEvent.click(screen.getByText(/Uruchom analizę zaawansowaną/i));

    await waitFor(() =>
      expect(screen.getByText(/Sugerowany kwadrant: Deleguj/i)).toBeInTheDocument()
    );
    expect(mockedApi.analyzeTask).toHaveBeenCalledWith('task', 'pl');
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
    fireEvent.click(screen.getByText(/Run advanced analysis/i));

    await waitFor(() =>
      expect(screen.getByText(/Suggested quadrant: Quadrant 9/i)).toBeInTheDocument()
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
    fireEvent.click(screen.getByText(/Run advanced analysis/i));

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

    fireEvent.click(screen.getByText(/Run advanced analysis/i));
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

    fireEvent.click(screen.getByText(/Run advanced analysis/i));
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

    fireEvent.click(screen.getByText(/Run advanced analysis/i));
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

    await waitFor(() => expect(screen.getByText(/odd task: Quadrant 9/i)).toBeInTheDocument());
  });

  it('handles OCR upload failures', async () => {
    mockedApi.extractTasksFromImage.mockRejectedValueOnce(new Error('OCR unavailable'));

    renderWithLanguage(<ImageUpload onTasksExtracted={jest.fn()} />);
    const file = new File(['task'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('OCR failed')).toBeInTheDocument());
  });

  it('requires OCR review and explicit import before persisting selected edited tasks', async () => {
    const onTasksExtracted = jest
      .fn()
      .mockResolvedValue({ imported: 1, failed: 0, learned: false });
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
        }),
        false
      )
    );
  });

  it('reports empty review, import failures, feedback failures, and explicit learning state', async () => {
    const onTasksExtracted = jest
      .fn()
      .mockRejectedValueOnce('offline')
      .mockRejectedValueOnce(new Error('Import unavailable'))
      .mockResolvedValueOnce({
        imported: 1,
        failed: 0,
        learned: false,
        feedbackError: 'Feedback unavailable',
      });
    mockedApi.extractTasksFromImage.mockResolvedValueOnce({
      filename: 'tasks.txt',
      image_info: { size_bytes: 12, shape: 'unknown' },
      ocr: { extracted_text: 'draft', raw_tasks_detected: 1, method: 'lazy-ocr' },
      classified_tasks: [{ text: 'draft', quadrant: 0, quadrant_name: 'Do Now', confidence: 0.8 }],
      summary: {
        total_tasks: 1,
        quadrant_distribution: {
          counts: { 0: 1, 1: 0, 2: 0, 3: 0 },
          percentages: { 0: 100, 1: 0, 2: 0, 3: 0 },
          quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
        },
      },
    });

    renderWithLanguage(<ImageUpload onTasksExtracted={onTasksExtracted} />);
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['draft'], 'tasks.txt', { type: 'text/plain' })] },
    });
    const include = await screen.findByLabelText(/Include task: draft/i);
    fireEvent.click(include);
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(screen.getByText('Select at least one non-empty task.')).toBeInTheDocument();

    fireEvent.click(include);
    fireEvent.click(screen.getByText(/Help improve suggestions using the accepted tasks/i));
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() => expect(screen.getByText('OCR failed')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() => expect(screen.getByText('OCR failed')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    await waitFor(() => expect(screen.getByText('OCR failed')).toBeInTheDocument());
    expect(onTasksExtracted).toHaveBeenLastCalledWith(expect.any(Object), true);
  });

  it.each([
    ['en', 'Improve suggestions: yes.'],
    ['pl', 'Ulepszanie podpowiedzi: tak.'],
  ] as const)('reports explicit learned feedback in %s', async (language, expected) => {
    localStorage.setItem('eisenhower-language', language);
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(reviewedOcrPayload());
    const onTasksExtracted = jest.fn().mockResolvedValue({ imported: 1, failed: 1, learned: true });

    renderWithLanguage(<ImageUpload onTasksExtracted={onTasksExtracted} />);
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [new File(['tasks'], 'tasks.txt', { type: 'text/plain' })] },
    });
    const second = await screen.findByLabelText(
      language === 'pl' ? /Uwzględnij zadanie: second/i : /Include task: second/i
    );
    fireEvent.click(second);
    fireEvent.click(
      screen.getByText(
        language === 'pl'
          ? /Pomóż ulepszać podpowiedzi na podstawie zaakceptowanych zadań/i
          : /Help improve suggestions using the accepted tasks/i
      )
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: language === 'pl' ? 'Importuj wybrane' : 'Import selected',
      })
    );

    await waitFor(() => expect(screen.getByText(new RegExp(expected))).toBeInTheDocument());
  });

  it('ignores empty OCR selections, opens the file picker, and falls back on unknown OCR failures', async () => {
    const inputClickSpy = jest
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    mockedApi.extractTasksFromImage.mockRejectedValueOnce('offline');

    renderWithLanguage(<ImageUpload onTasksExtracted={jest.fn()} />);

    fireEvent.click(screen.getByText(/Upload image/i));
    expect(inputClickSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [] },
    });
    expect(mockedApi.extractTasksFromImage).not.toHaveBeenCalled();

    const file = new File(['task'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('OCR failed')).toBeInTheDocument());

    inputClickSpy.mockRestore();
  });

  it('shows stats loading failures in management', async () => {
    mockedApi.getTrainingStats.mockRejectedValueOnce(new Error('Stats unavailable'));

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(/administration status could not be loaded/i)).toBeInTheDocument()
    );
  });

  it('falls back to the default load error for non-Error status failures', async () => {
    mockedApi.getTrainingStats.mockImplementationOnce(() => {
      throw 'offline';
    });

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(/administration status could not be loaded/i)).toBeInTheDocument()
    );
  });

  it('runs the management success flow against real form state', async () => {
    const onModelUpdated = jest.fn();
    const stats = {
      total_examples: 8,
      quadrant_distribution: { '0': 2, '1': 2, '2': 2, '3': 2 },
      data_sources: { default: 8 },
      data_file: 'data.json',
      model_file: 'memory',
      model_name: 'local-minilm-mlp',
      model_ready: true,
      model_encoder: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
      last_updated: new Date().toISOString(),
    };
    const capabilities = {
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
      provider_controls: {
        local_model: { enabled: true, available: true, active: true, reason: null },
        tesseract: { enabled: true, available: true, active: true, reason: null },
      },
    };

    mockedApi.getTrainingStats.mockImplementation(async () => stats);
    mockedApi.getCapabilities.mockImplementation(async () => capabilities);
    mockedApi.addTrainingExample.mockResolvedValue(undefined);
    mockedApi.learnFromFeedback.mockResolvedValue(undefined);
    mockedApi.retrainModel.mockResolvedValue({ preserve_experience: false });
    mockedApi.clearTrainingData.mockResolvedValue({
      message: 'Training data cleared.',
      remaining_examples: 4,
    });
    mockedApi.getExamplesByQuadrant.mockResolvedValue({
      examples: [{ text: 'Inbox cleanup', quadrant: 3 }],
    });

    renderWithLanguage(<AIManagement onModelUpdated={onModelUpdated} />);

    await waitFor(() =>
      expect(
        screen.getByText(/Examples currently used to improve suggestions/i)
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/local-minilm-mlp/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Task text/i), {
      target: { value: 'Escalate outage' },
    });
    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByText(/Add example/i));
    await waitFor(() =>
      expect(mockedApi.addTrainingExample).toHaveBeenCalledWith('Escalate outage', 0)
    );

    fireEvent.change(screen.getByPlaceholderText(/Task corrected by the user/i), {
      target: { value: 'Prepare QBR' },
    });
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: '3' },
    });
    fireEvent.change(screen.getAllByRole('combobox')[2], {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByText(/Save correction/i));
    await waitFor(() =>
      expect(mockedApi.learnFromFeedback).toHaveBeenCalledWith('Prepare QBR', 3, 2)
    );

    fireEvent.click(screen.getByLabelText(/Keep existing learning examples/i));
    fireEvent.click(screen.getByLabelText(/Keep the built-in starting examples/i));
    fireEvent.click(screen.getByText(/Refresh task suggestions/i));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(mockedApi.retrainModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Refresh task suggestions/i));
    fireEvent.click(screen.getByText(/Confirm refresh/i));
    await waitFor(() => expect(mockedApi.retrainModel).toHaveBeenCalledWith(false));

    fireEvent.click(screen.getByText(/Clear learned examples/i));
    fireEvent.click(screen.getByText(/^Cancel$/i));
    expect(mockedApi.clearTrainingData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Clear learned examples/i));
    fireEvent.click(screen.getByText(/Confirm clearing learned examples/i));
    await waitFor(() => expect(mockedApi.clearTrainingData).toHaveBeenCalledWith(false));

    fireEvent.change(screen.getAllByRole('combobox')[3], {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Load examples$/i }));
    await waitFor(() => expect(screen.getByText('Inbox cleanup')).toBeInTheDocument());
    expect(
      within(screen.getByText('Inbox cleanup').closest('li') as HTMLElement).getByText('Delete')
    ).toBeInTheDocument();
    expect(onModelUpdated).toHaveBeenCalledTimes(4);
  });

  it('keeps a completed action successful when the following status refresh fails', async () => {
    mockedApi.getTrainingStats
      .mockResolvedValueOnce({
        total_examples: 2,
        quadrant_distribution: { '0': 1, '1': 1, '2': 0, '3': 0 },
        data_sources: { default: 2 },
        data_file: 'data.json',
        model_file: 'memory',
        last_updated: new Date().toISOString(),
      })
      .mockRejectedValueOnce(new Error('refresh unavailable'));
    mockedApi.getCapabilities.mockResolvedValue({
      classification: true,
      langchain_analysis: true,
      ocr: true,
      batch_analysis: true,
      training_management: true,
      providers: { local_model: true, tesseract: true, ocr: true },
    });
    mockedApi.addTrainingExample.mockResolvedValue(undefined);

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);
    await screen.findByText(/Examples currently used to improve suggestions/i);
    fireEvent.change(screen.getByLabelText('Example task text'), {
      target: { value: 'Keep the success result' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add example' }));

    await waitFor(() => expect(mockedApi.addTrainingExample).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/Example saved/i);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
  });

  it('is read-only when management mutations are unavailable', async () => {
    mockedApi.getTrainingStats.mockResolvedValue({
      total_examples: 2,
      quadrant_distribution: { '0': 1, '1': 1, '2': 0, '3': 0 },
      data_sources: { default: 2 },
      data_file: 'data.json',
      model_file: 'memory',
      last_updated: new Date().toISOString(),
    });
    mockedApi.getCapabilities.mockResolvedValue({
      classification: true,
      langchain_analysis: true,
      ocr: true,
      batch_analysis: true,
      training_management: false,
      providers: { local_model: true, tesseract: true, ocr: true },
    });

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    expect(await screen.findByRole('status')).toHaveTextContent(/changes are disabled/i);
    expect(
      screen.getByLabelText(/Change availability of Automatic task suggestions/i)
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: /Refresh task suggestions/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Clear learned examples/i })).toBeDisabled();
  });

  it('renders local model metadata and errors in the training state card', async () => {
    mockedApi.getTrainingStats.mockResolvedValueOnce({
      total_examples: 4,
      quadrant_distribution: { '0': 1, '1': 1, '2': 1, '3': 1 },
      data_sources: { default: 4 },
      data_file: 'data.json',
      model_file: 'runtime/local_minilm_head.pt',
      model_name: 'local-minilm-mlp',
      model_ready: false,
      model_encoder: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
      model_trained_at: new Date().toISOString(),
      model_validation_skipped: true,
      model_error: 'Model bootstrap failed.',
      last_updated: new Date().toISOString(),
    });
    mockedApi.getCapabilities.mockResolvedValueOnce({
      classification: true,
      langchain_analysis: true,
      ocr: true,
      batch_analysis: true,
      training_management: true,
      providers: {
        local_model: false,
        tesseract: true,
        ocr: true,
      },
      provider_controls: {
        local_model: {
          enabled: true,
          available: false,
          active: false,
          reason: 'Model bootstrap failed.',
        },
        tesseract: { enabled: true, available: true, active: true, reason: null },
      },
    });

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() =>
      expect(
        screen.getByText(/Examples currently used to improve suggestions/i)
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/local-minilm-mlp/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/sentence-transformers\/paraphrase-multilingual-MiniLM-L12-v2/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Model bootstrap failed.')).not.toBeInTheDocument();
  });

  it('shows partial status failures when capabilities cannot load', async () => {
    mockedApi.getTrainingStats.mockResolvedValueOnce({
      total_examples: 2,
      quadrant_distribution: { '0': 1, '1': 1, '2': 0, '3': 0 },
      data_sources: { default: 2 },
      data_file: 'data.json',
      model_file: 'memory',
      last_updated: new Date().toISOString(),
    });
    mockedApi.getCapabilities.mockRejectedValueOnce(new Error('Capabilities unavailable'));

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(/administration status could not be loaded/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/Examples currently used to improve suggestions/i)).toBeInTheDocument();
    expect(screen.getByText(/Checking available features/i)).toBeInTheDocument();
  });

  it('surfaces management action and example-loading failures', async () => {
    mockedApi.getTrainingStats.mockResolvedValueOnce({
      total_examples: 3,
      quadrant_distribution: { '0': 1, '1': 1, '2': 1, '3': 0 },
      data_sources: { feedback: 3 },
      data_file: 'data.json',
      model_file: 'memory',
      last_updated: new Date().toISOString(),
    });
    mockedApi.getCapabilities.mockResolvedValueOnce({
      classification: true,
      langchain_analysis: true,
      ocr: true,
      batch_analysis: true,
      training_management: true,
      providers: {
        local_model: false,
        tesseract: true,
        ocr: true,
      },
      provider_controls: {
        local_model: {
          enabled: false,
          available: true,
          active: false,
          reason: 'Disabled in AI management.',
        },
        tesseract: { enabled: true, available: true, active: true, reason: null },
      },
    });
    mockedApi.addTrainingExample.mockRejectedValueOnce('offline');
    mockedApi.getExamplesByQuadrant.mockRejectedValueOnce('offline');

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() =>
      expect(
        screen.getByText(/Examples currently used to improve suggestions/i)
      ).toBeInTheDocument()
    );

    fireEvent.change(screen.getByPlaceholderText(/Task text/i), {
      target: { value: 'Review docs' },
    });
    fireEvent.click(screen.getByText(/Add example/i));
    await waitFor(() => expect(screen.getByText('Action failed')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Load examples$/i }));
    await waitFor(() => expect(screen.getByText('Failed to load examples')).toBeInTheDocument());
  });

  it('uses explicit Error messages for management failures and unknown quadrant labels', async () => {
    mockedApi.getTrainingStats.mockResolvedValue({
      total_examples: 5,
      quadrant_distribution: { '0': 1, '1': 1, '2': 1, '3': 2 },
      data_sources: { user: 5 },
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
      provider_controls: {
        local_model: { enabled: true, available: true, active: true, reason: null },
        tesseract: { enabled: true, available: true, active: true, reason: null },
      },
    });
    mockedApi.retrainModel.mockRejectedValueOnce(new Error('Retrain exploded'));
    mockedApi.getExamplesByQuadrant
      .mockRejectedValueOnce(new Error('Example loader down'))
      .mockResolvedValueOnce({ examples: [{ text: 'Unknown bucket task', quadrant: 9 }] });

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getAllByText(/Saved learning examples/i).length).toBeGreaterThan(0)
    );

    fireEvent.click(screen.getByRole('button', { name: /Refresh task suggestions/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm refresh/i }));
    await waitFor(() => expect(screen.getByText('Action failed')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Load examples$/i }));
    await waitFor(() => expect(screen.getByText('Failed to load examples')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Load examples$/i }));
    await waitFor(() => expect(screen.getByText('Unknown bucket task')).toBeInTheDocument());
    expect(screen.getByText('Quadrant 9')).toBeInTheDocument();
  });

  it('toggles providers and refreshes their runtime state', async () => {
    mockedApi.getTrainingStats.mockResolvedValue({
      total_examples: 5,
      quadrant_distribution: { '0': 1, '1': 1, '2': 1, '3': 2 },
      data_sources: { user: 5 },
      data_file: 'data.json',
      model_file: 'memory',
      last_updated: new Date().toISOString(),
    });
    mockedApi.getCapabilities
      .mockResolvedValueOnce({
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
        provider_controls: {
          local_model: { enabled: true, available: true, active: true, reason: null },
          tesseract: { enabled: true, available: true, active: true, reason: null },
        },
      })
      .mockResolvedValueOnce({
        classification: false,
        langchain_analysis: false,
        ocr: true,
        batch_analysis: false,
        training_management: true,
        providers: {
          local_model: false,
          tesseract: true,
          ocr: true,
        },
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
      .mockResolvedValueOnce({
        classification: false,
        langchain_analysis: false,
        ocr: false,
        batch_analysis: false,
        training_management: true,
        providers: {
          local_model: false,
          tesseract: false,
          ocr: false,
        },
        provider_controls: {
          local_model: {
            enabled: false,
            available: true,
            active: false,
            reason: 'Disabled in AI management.',
          },
          tesseract: {
            enabled: false,
            available: true,
            active: false,
            reason: 'Disabled in AI management.',
          },
        },
      });
    mockedApi.setProviderEnabled
      .mockResolvedValueOnce({
        provider: 'local_model',
        enabled: false,
        available: true,
        active: false,
        reason: 'Disabled in AI management.',
      })
      .mockResolvedValueOnce({
        provider: 'tesseract',
        enabled: false,
        available: true,
        active: false,
        reason: 'Disabled in AI management.',
      });

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getAllByText(/Automatic task suggestions/i).length).toBeGreaterThan(0)
    );

    fireEvent.click(screen.getByLabelText(/Change availability of Automatic task suggestions/i));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(mockedApi.setProviderEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Change availability of Automatic task suggestions/i));
    fireEvent.click(
      screen.getByRole('button', { name: /Confirm turning off Automatic task suggestions/i })
    );
    await waitFor(() =>
      expect(mockedApi.setProviderEnabled).toHaveBeenCalledWith('local_model', false)
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Automatic task suggestions has been turned off\./i)
      ).toBeInTheDocument()
    );
    expect(screen.getAllByText(/Turned off by an administrator/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText(/Change availability of Reading text from images/i));
    fireEvent.click(
      screen.getByRole('button', { name: /Confirm turning off Reading text from images/i })
    );
    await waitFor(() =>
      expect(mockedApi.setProviderEnabled).toHaveBeenCalledWith('tesseract', false)
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Reading text from images has been turned off\./i)
      ).toBeInTheDocument()
    );
  });

  it('enables a disabled provider and reports the success state', async () => {
    mockedApi.getTrainingStats.mockResolvedValue({
      total_examples: 2,
      quadrant_distribution: { '0': 1, '1': 1, '2': 0, '3': 0 },
      data_sources: { default: 2 },
      data_file: 'data.json',
      model_file: 'memory',
      last_updated: new Date().toISOString(),
    });
    mockedApi.getCapabilities
      .mockResolvedValueOnce({
        classification: false,
        langchain_analysis: false,
        ocr: true,
        batch_analysis: false,
        training_management: true,
        providers: {
          local_model: false,
          tesseract: true,
          ocr: true,
        },
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
      .mockResolvedValueOnce({
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
        provider_controls: {
          local_model: { enabled: true, available: true, active: true, reason: null },
          tesseract: { enabled: true, available: true, active: true, reason: null },
        },
      });
    mockedApi.setProviderEnabled.mockResolvedValueOnce({
      provider: 'local_model',
      enabled: true,
      available: true,
      active: true,
      reason: null,
    });

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getAllByText(/Turned off by an administrator/i).length).toBeGreaterThan(0)
    );

    fireEvent.click(screen.getByLabelText(/Change availability of Automatic task suggestions/i));
    await waitFor(() =>
      expect(mockedApi.setProviderEnabled).toHaveBeenCalledWith('local_model', true)
    );
    await waitFor(() =>
      expect(screen.getByText(/Automatic task suggestions is now available\./i)).toBeInTheDocument()
    );
  });

  it('surfaces provider toggle failures and unavailable states', async () => {
    mockedApi.getTrainingStats.mockResolvedValue({
      total_examples: 2,
      quadrant_distribution: { '0': 1, '1': 1, '2': 0, '3': 0 },
      data_sources: { default: 2 },
      data_file: 'data.json',
      model_file: 'memory',
      last_updated: new Date().toISOString(),
    });
    mockedApi.getCapabilities.mockResolvedValue({
      classification: false,
      langchain_analysis: false,
      ocr: false,
      batch_analysis: false,
      training_management: true,
      providers: {
        local_model: false,
        tesseract: false,
        ocr: false,
      },
      provider_controls: {
        local_model: {
          enabled: true,
          available: false,
          active: false,
          reason: 'Model bootstrap failed.',
        },
        tesseract: {
          enabled: true,
          available: false,
          active: false,
          reason: 'Tesseract binary is not available.',
        },
      },
    });
    mockedApi.setProviderEnabled.mockRejectedValueOnce(new Error('Provider switch failed'));

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() => expect(screen.getAllByText(/Currently unavailable/i)).toHaveLength(2));
    expect(screen.queryByText('Model bootstrap failed.')).not.toBeInTheDocument();
    expect(screen.queryByText('Tesseract binary is not available.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Change availability of Automatic task suggestions/i));
    fireEvent.click(
      screen.getByRole('button', { name: /Confirm turning off Automatic task suggestions/i })
    );
    await waitFor(() => expect(screen.getByText('Action failed')).toBeInTheDocument());
  });

  it('refreshes administration status locally and reports a failed manual refresh', async () => {
    mockedApi.getTrainingStats
      .mockResolvedValueOnce({
        total_examples: 2,
        quadrant_distribution: { '0': 1, '1': 1, '2': 0, '3': 0 },
        data_sources: { default: 2 },
        data_file: 'data.json',
        model_file: 'memory',
        last_updated: new Date().toISOString(),
      })
      .mockRejectedValueOnce(new Error('offline'));
    mockedApi.getCapabilities.mockResolvedValue({
      classification: true,
      langchain_analysis: true,
      ocr: true,
      batch_analysis: true,
      training_management: true,
      providers: { local_model: true, tesseract: true, ocr: true },
    });

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);
    await screen.findByText(/Examples currently used to improve suggestions/i);
    fireEvent.click(screen.getByRole('button', { name: /^Refresh status$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /administration status could not be loaded/i
    );
  });
});
