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

  it('handles OCR upload failures', async () => {
    mockedApi.extractTasksFromImage.mockRejectedValueOnce(new Error('OCR unavailable'));

    render(<ImageUpload onTasksExtracted={jest.fn()} />);
    const file = new File(['task'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('OCR unavailable')).toBeInTheDocument());
  });

  it('shows stats loading failures in management', async () => {
    mockedApi.getTrainingStats.mockRejectedValueOnce(new Error('Stats unavailable'));

    render(<AIManagement onModelUpdated={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Failed to load stats')).toBeInTheDocument());
  });
});
