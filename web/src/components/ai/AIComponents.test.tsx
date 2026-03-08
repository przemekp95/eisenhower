import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdvancedAIAnalysis from './AdvancedAIAnalysis';
import BatchAnalysis from './BatchAnalysis';
import ImageUpload from './ImageUpload';
import AIManagement from './AIManagement';
import * as api from '../../services/api';

jest.mock('../../services/api');

const mockedApi = jest.mocked(api);

describe('AI component error paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders analysis errors', async () => {
    mockedApi.analyzeWithLangChain.mockRejectedValueOnce(new Error('LangChain offline'));

    render(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getByText(/Run advanced analysis/i));

    await waitFor(() => expect(screen.getByText('LangChain offline')).toBeInTheDocument());
  });

  it('ignores empty advanced-analysis titles and falls back on unknown failures', async () => {
    render(<AdvancedAIAnalysis taskTitle="   " onAnalysisComplete={jest.fn()} />);

    const disabledButton = screen.getByText(/Run advanced analysis/i) as HTMLButtonElement;
    disabledButton.removeAttribute('disabled');
    disabledButton.disabled = false;
    fireEvent.click(disabledButton);

    expect(mockedApi.analyzeWithLangChain).not.toHaveBeenCalled();

    mockedApi.analyzeWithLangChain.mockRejectedValueOnce('offline');

    render(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getAllByText(/Run advanced analysis/i)[1]);

    await waitFor(() => expect(screen.getByText('Analysis failed')).toBeInTheDocument());
  });

  it('renders the fallback suggested quadrant when langchain does not return one', async () => {
    mockedApi.analyzeWithLangChain.mockResolvedValueOnce({
      task: 'task',
      langchain_analysis: {
        quadrant: null,
        reasoning: 'Needs scheduling',
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

    render(<AdvancedAIAnalysis taskTitle="task" onAnalysisComplete={jest.fn()} />);
    fireEvent.click(screen.getByText(/Run advanced analysis/i));

    await waitFor(() => expect(screen.getByText(/Suggested quadrant: 1/i)).toBeInTheDocument());
  });

  it('validates and handles batch failures', async () => {
    mockedApi.batchAnalyzeTasks.mockRejectedValueOnce(new Error('Batch failed'));

    render(<BatchAnalysis onBatchComplete={jest.fn()} />);
    fireEvent.click(screen.getByText(/Analyze batch/i));
    expect(screen.getByText(/Add at least one task/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/One task per line/i), {
      target: { value: 'task one' },
    });
    fireEvent.click(screen.getByText(/Analyze batch/i));

    await waitFor(() => expect(screen.getByText('Batch failed')).toBeInTheDocument());
  });

  it('falls back on unknown batch failures', async () => {
    mockedApi.batchAnalyzeTasks.mockRejectedValueOnce('offline');

    render(<BatchAnalysis onBatchComplete={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/One task per line/i), {
      target: { value: 'task one' },
    });
    fireEvent.click(screen.getByText(/Analyze batch/i));

    await waitFor(() => expect(screen.getByText('Batch analysis failed')).toBeInTheDocument());
  });

  it('handles OCR upload failures', async () => {
    mockedApi.extractTasksFromImage.mockRejectedValueOnce(new Error('OCR unavailable'));

    render(<ImageUpload onTasksExtracted={jest.fn()} />);
    const file = new File(['task'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('OCR unavailable')).toBeInTheDocument());
  });

  it('ignores empty OCR selections, opens the file picker, and falls back on unknown OCR failures', async () => {
    const inputClickSpy = jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    mockedApi.extractTasksFromImage.mockRejectedValueOnce('offline');

    render(<ImageUpload onTasksExtracted={jest.fn()} />);

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

    render(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Failed to load stats')).toBeInTheDocument());
  });
});
