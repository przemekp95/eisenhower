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

describe('AI component error paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem('eisenhower-language', 'en');
  });

  it('renders analysis errors', async () => {
    mockedApi.analyzeWithLangChain.mockRejectedValueOnce(new Error('LangChain offline'));

    renderWithLanguage(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getByText(/Run advanced analysis/i));

    await waitFor(() => expect(screen.getByText('LangChain offline')).toBeInTheDocument());
  });

  it('ignores empty advanced-analysis titles and falls back on unknown failures', async () => {
    renderWithLanguage(<AdvancedAIAnalysis taskTitle="   " onAnalysisComplete={jest.fn()} />);

    const disabledButton = screen.getByText(/Run advanced analysis/i) as HTMLButtonElement;
    disabledButton.removeAttribute('disabled');
    disabledButton.disabled = false;
    fireEvent.click(disabledButton);

    expect(mockedApi.analyzeWithLangChain).not.toHaveBeenCalled();

    mockedApi.analyzeWithLangChain.mockRejectedValueOnce('offline');

    renderWithLanguage(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getAllByText(/Run advanced analysis/i)[1]);

    await waitFor(() => expect(screen.getByText('Analysis failed')).toBeInTheDocument());
  });

  it('renders the fallback suggested quadrant when langchain does not return one', async () => {
    localStorage.setItem('eisenhower-language', 'pl');
    mockedApi.analyzeWithLangChain.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: null,
        reasoning: 'Wymaga zaplanowania.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Schedule',
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

    await waitFor(() => expect(screen.getByText(/Sugerowany kwadrant: Zaplanuj/i)).toBeInTheDocument());
    expect(mockedApi.analyzeWithLangChain).toHaveBeenCalledWith('task', 'pl');
  });

  it('falls back to an unknown quadrant label in advanced analysis', async () => {
    mockedApi.analyzeWithLangChain.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 9,
        reasoning: 'Unexpected quadrant.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Schedule',
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

    await waitFor(() => expect(screen.getByText(/Suggested quadrant: Quadrant 9/i)).toBeInTheDocument());
  });

  it('clears stale advanced analysis when the language changes', async () => {
    mockedApi.analyzeWithLangChain.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 1,
        reasoning: 'Needs scheduling.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Schedule',
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

    await waitFor(() => expect(screen.getByText(/Suggested quadrant: Schedule/i)).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByText('switch'));
    });

    await waitFor(() => expect(screen.queryByText(/Suggested quadrant:/i)).not.toBeInTheDocument());
  });

  it('adds the advanced-analysis result to the matrix when requested', async () => {
    const onAddToMatrix = jest.fn().mockResolvedValue(undefined);

    mockedApi.analyzeWithLangChain.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 1,
        reasoning: 'Needs scheduling.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Schedule',
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

    mockedApi.analyzeWithLangChain.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 1,
        reasoning: 'Needs scheduling.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Schedule',
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

    mockedApi.analyzeWithLangChain.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: 1,
        reasoning: 'Needs scheduling.',
        confidence: 0.8,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 1,
        quadrant_name: 'Schedule',
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

    await waitFor(() => expect(screen.getByText('Matrix unavailable')).toBeInTheDocument());
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

    await waitFor(() => expect(screen.getByText('Batch failed')).toBeInTheDocument());
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

    await waitFor(() => expect(screen.getByText('OCR unavailable')).toBeInTheDocument());
  });

  it('ignores empty OCR selections, opens the file picker, and falls back on unknown OCR failures', async () => {
    const inputClickSpy = jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
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

    await waitFor(() => expect(screen.getByText('Failed to load stats')).toBeInTheDocument());
  });

  it('falls back to the default load error for non-Error status failures', async () => {
    mockedApi.getTrainingStats.mockImplementationOnce(() => {
      throw 'offline';
    });

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Failed to load stats')).toBeInTheDocument());
  });

  it('runs the management success flow against real form state', async () => {
    const onModelUpdated = jest.fn();
    const stats = {
      total_examples: 8,
      quadrant_distribution: { '0': 2, '1': 2, '2': 2, '3': 2 },
      data_sources: { default: 8 },
      data_file: 'data.json',
      model_file: 'memory',
      last_updated: new Date().toISOString(),
    };
    const capabilities = {
      classification: true,
      langchain_analysis: true,
      ocr: true,
      batch_analysis: true,
      training_management: true,
      providers: {
        openai: true,
        embeddings: true,
        vector_db: false,
        langchain: false,
        vision: true,
        tesseract: true,
        ocr: true,
      },
    };

    mockedApi.getTrainingStats.mockImplementation(async () => stats);
    mockedApi.getCapabilities.mockImplementation(async () => capabilities);
    mockedApi.addTrainingExample.mockResolvedValue(undefined);
    mockedApi.learnFromFeedback.mockResolvedValue(undefined);
    mockedApi.retrainModel.mockResolvedValue({ preserve_experience: false });
    mockedApi.clearTrainingData.mockResolvedValue({ message: 'Training data cleared.', remaining_examples: 4 });
    mockedApi.getExamplesByQuadrant.mockResolvedValue({ examples: [{ text: 'Inbox cleanup', quadrant: 3 }] });

    renderWithLanguage(<AIManagement onModelUpdated={onModelUpdated} />);

    await waitFor(() => expect(screen.getByText(/OpenAI: on/i)).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Task text/i), {
      target: { value: 'Escalate outage' },
    });
    fireEvent.change(screen.getAllByRole('combobox')[0], {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByText(/Add example/i));
    await waitFor(() => expect(mockedApi.addTrainingExample).toHaveBeenCalledWith('Escalate outage', 0));

    fireEvent.change(screen.getByPlaceholderText(/Task corrected by the user/i), {
      target: { value: 'Prepare QBR' },
    });
    fireEvent.change(screen.getAllByRole('combobox')[1], {
      target: { value: '3' },
    });
    fireEvent.change(screen.getAllByRole('combobox')[2], {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByText(/Learn feedback/i));
    await waitFor(() => expect(mockedApi.learnFromFeedback).toHaveBeenCalledWith('Prepare QBR', 3, 2));

    const toggles = screen.getAllByRole('checkbox');
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    fireEvent.click(screen.getByText(/^Retrain$/i));
    await waitFor(() => expect(mockedApi.retrainModel).toHaveBeenCalledWith(false));

    fireEvent.click(screen.getByText(/Clear training data/i));
    await waitFor(() => expect(mockedApi.clearTrainingData).toHaveBeenCalledWith(false));

    fireEvent.change(screen.getAllByRole('combobox')[3], {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByText(/Load examples/i));
    await waitFor(() => expect(screen.getByText('Inbox cleanup')).toBeInTheDocument());
    expect(within(screen.getByText('Inbox cleanup').closest('li') as HTMLElement).getByText('Delete')).toBeInTheDocument();
    expect(onModelUpdated).toHaveBeenCalledTimes(4);
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

    await waitFor(() => expect(screen.getByText('Failed to load stats')).toBeInTheDocument());
    expect(screen.getByText(/Total examples in the experience store/i)).toBeInTheDocument();
    expect(screen.getByText(/Loading providers/i)).toBeInTheDocument();
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
        openai: false,
        embeddings: false,
        vector_db: false,
        langchain: false,
        vision: false,
        tesseract: true,
        ocr: true,
      },
    });
    mockedApi.addTrainingExample.mockRejectedValueOnce('offline');
    mockedApi.getExamplesByQuadrant.mockRejectedValueOnce('offline');

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(/Total examples in the experience store/i)).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Task text/i), {
      target: { value: 'Review docs' },
    });
    fireEvent.click(screen.getByText(/Add example/i));
    await waitFor(() => expect(screen.getByText('Action failed')).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Load examples/i));
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
        openai: true,
        embeddings: true,
        vector_db: false,
        langchain: false,
        vision: true,
        tesseract: true,
        ocr: true,
      },
    });
    mockedApi.retrainModel.mockRejectedValueOnce(new Error('Retrain exploded'));
    mockedApi.getExamplesByQuadrant
      .mockRejectedValueOnce(new Error('Example loader down'))
      .mockResolvedValueOnce({ examples: [{ text: 'Unknown bucket task', quadrant: 9 }] });

    renderWithLanguage(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(/Training state/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Retrain$/i }));
    await waitFor(() => expect(screen.getByText('Retrain exploded')).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Load examples/i));
    await waitFor(() => expect(screen.getByText('Example loader down')).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Load examples/i));
    await waitFor(() => expect(screen.getByText('Unknown bucket task')).toBeInTheDocument());
    expect(screen.getByText('Quadrant 9')).toBeInTheDocument();
  });
});
