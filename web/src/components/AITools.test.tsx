import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AITools from './AITools';
import { LanguageProvider } from '../i18n/LanguageContext';
import * as api from '../services/api';

jest.mock('../services/api');

const mockedApi = jest.mocked(api);

function renderTools(onOCRTasksExtracted = jest.fn()) {
  return render(
    <LanguageProvider>
      <AITools
        taskTitle="urgent roadmap"
        onClose={jest.fn()}
        onAnalysisComplete={jest.fn()}
        onOCRTasksExtracted={onOCRTasksExtracted}
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
        quadrant_names: { 0: 'Do Now', 1: 'Schedule', 2: 'Delegate', 3: 'Delete' },
      },
    },
    timestamp: new Date().toISOString(),
  };
}

describe('AITools', () => {
  beforeEach(() => {
    localStorage.setItem('eisenhower-language', 'en');
    mockedApi.analyzeWithLangChain.mockResolvedValue({
      task: 'urgent roadmap',
      langchain_analysis: { quadrant: 0, reasoning: 'Critical path', confidence: 0.9, method: 'langchain' },
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
      classified_tasks: [{ text: 'urgent outage', quadrant: 0, quadrant_name: 'Do Now', confidence: 0.8 }],
      summary: {
        total_tasks: 1,
        quadrant_distribution: {
          counts: { 0: 1, 1: 0, 2: 0, 3: 0 },
          percentages: { 0: 100, 1: 0, 2: 0, 3: 0 },
          quadrant_names: { 0: 'Do Now', 1: 'Schedule', 2: 'Delegate', 3: 'Delete' },
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
    mockedApi.clearTrainingData.mockResolvedValue({ message: 'Training data cleared.', remaining_examples: 8 });
    mockedApi.getExamplesByQuadrant.mockResolvedValue({ examples: [{ text: 'urgent outage', quadrant: 0 }] });
  });

  it('runs advanced analysis', async () => {
    renderTools();

    fireEvent.click(screen.getByText(/Run advanced analysis/i));

    await waitFor(() => expect(screen.getByText(/Critical path/i)).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText(/Extracted 1 task from tasks.txt/i)).toBeInTheDocument());
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

    await waitFor(() => expect(screen.getByText(/OCR added 1 task to the matrix/i)).toBeInTheDocument());
  });

  it('uses the plural English OCR import summary', async () => {
    mockedApi.extractTasksFromImage.mockResolvedValueOnce(ocrPayload(3));

    renderTools(jest.fn().mockResolvedValue(3));

    fireEvent.click(screen.getByText('OCR'));
    const file = new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText(/OCR added 3 tasks to the matrix/i)).toBeInTheDocument());
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

    await waitFor(() => expect(screen.getByText(/OCR dodał 1 zadanie do macierzy/i)).toBeInTheDocument());
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

    await waitFor(() => expect(screen.getByText(/OCR dodał 2 zadania do macierzy/i)).toBeInTheDocument());
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

    await waitFor(() => expect(screen.getByText(/OCR dodał 5 zadań do macierzy/i)).toBeInTheDocument());
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

    await waitFor(() => expect(screen.getByText(/OCR dodał 12 zadań do macierzy/i)).toBeInTheDocument());
  });

  it('handles AI management actions', async () => {
    renderTools();

    fireEvent.click(screen.getByText('Manage'));

    await waitFor(() => expect(screen.getByText(/Total examples in the experience store/i)).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Task text/i), {
      target: { value: 'Review architecture notes' },
    });
    fireEvent.click(screen.getByText(/Add example/i));
    await waitFor(() => expect(mockedApi.addTrainingExample).toHaveBeenCalledWith('Review architecture notes', 2));

    fireEvent.change(screen.getByPlaceholderText(/Task corrected by the user/i), {
      target: { value: 'Escalate vendor issue' },
    });
    fireEvent.click(screen.getByText(/Learn feedback/i));
    await waitFor(() => expect(mockedApi.learnFromFeedback).toHaveBeenCalledWith('Escalate vendor issue', 1, 0));

    fireEvent.click(screen.getByRole('button', { name: /^Retrain$/i }));
    await waitFor(() => expect(mockedApi.retrainModel).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByText(/Clear training data/i));
    await waitFor(() => expect(mockedApi.clearTrainingData).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByText(/Load examples/i));
    await waitFor(() => expect(screen.getByText(/urgent outage/i)).toBeInTheDocument());
  });
});
