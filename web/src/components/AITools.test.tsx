import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AITools from './AITools';
import { LanguageProvider } from '../i18n/LanguageContext';
import * as api from '../services/api';

jest.mock('../services/api');

const mockedApi = jest.mocked(api);

function renderTools() {
  return render(
    <LanguageProvider>
      <AITools taskTitle="urgent roadmap" onClose={jest.fn()} onAnalysisComplete={jest.fn()} />
    </LanguageProvider>
  );
}

describe('AITools', () => {
  beforeEach(() => {
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
    mockedApi.addTrainingExample.mockResolvedValue(undefined);
    mockedApi.learnFromFeedback.mockResolvedValue(undefined);
    mockedApi.retrainModel.mockResolvedValue({ preserve_experience: false });
    mockedApi.getExamplesByQuadrant.mockResolvedValue({ examples: [{ text: 'urgent outage', quadrant: 0 }] });
  });

  it('runs advanced analysis', async () => {
    renderTools();

    fireEvent.click(screen.getByText(/Run advanced analysis/i));

    await waitFor(() => expect(screen.getByText(/Critical path/i)).toBeInTheDocument());
  });

  it('switches to batch and OCR tools', async () => {
    renderTools();

    fireEvent.click(screen.getByText('Batch'));
    fireEvent.change(screen.getByPlaceholderText(/One task per line/i), {
      target: { value: 'urgent outage' },
    });
    fireEvent.click(screen.getByText(/Analyze batch/i));
    await waitFor(() => expect(screen.getByText(/urgent outage: Do Now/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('OCR'));
    const file = new File(['urgent outage'], 'tasks.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });
    await waitFor(() => expect(screen.getByText(/Extracted 1 tasks from tasks.txt/i)).toBeInTheDocument());
  });

  it('handles AI management actions', async () => {
    renderTools();

    fireEvent.click(screen.getByText('Manage'));

    await waitFor(() => expect(screen.getByText(/Total examples: 8/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Add example/i));
    fireEvent.click(screen.getByText(/Learn feedback/i));
    fireEvent.click(screen.getByText(/Retrain/i));
    fireEvent.click(screen.getByText(/Load examples/i));

    await waitFor(() => expect(screen.getByText(/urgent outage/i)).toBeInTheDocument());
  });
});
