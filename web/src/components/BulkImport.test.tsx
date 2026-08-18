import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BulkImport from './BulkImport';
import { LanguageProvider } from '../i18n/LanguageContext';
import * as api from '../services/api';

jest.mock('../services/api');
const mockedApi = jest.mocked(api);

function renderBulk(onAddTask = jest.fn().mockResolvedValue(undefined)) {
  render(
    <LanguageProvider>
      <BulkImport existingTitles={['Existing task']} onAddTask={onAddTask} onClose={jest.fn()} />
    </LanguageProvider>
  );
  return onAddTask;
}

describe('BulkImport', () => {
  beforeEach(() => {
    localStorage.setItem('eisenhower-language', 'en');
    jest.clearAllMocks();
    mockedApi.batchAnalyzeTasks.mockResolvedValue({
      batch_results: [
        {
          task: 'Existing task',
          analyses: {
            rag: { quadrant: 0, quadrant_name: 'Do Now', confidence: 0.9 },
            langchain: { quadrant: null, confidence: 0, reasoning: '', method: 'disabled' },
          },
        },
        {
          task: 'Plan roadmap',
          analyses: {
            rag: { quadrant: 2, quadrant_name: 'Schedule', confidence: 0.8 },
            langchain: { quadrant: null, confidence: 0, reasoning: '', method: 'disabled' },
          },
        },
      ],
      summary: { methods: {}, total_tasks: 2 },
    });
  });

  it('classifies, reviews, detects duplicates, edits quadrants, and imports only confirmed rows', async () => {
    const onAddTask = renderBulk();
    fireEvent.change(screen.getByLabelText('Tasks to import'), {
      target: { value: ' Existing   task \nPlan roadmap\nPLAN ROADMAP' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Classify and review' }));

    await screen.findByRole('group', { name: 'Review before import' });
    expect(mockedApi.batchAnalyzeTasks).toHaveBeenCalledWith(
      ['Existing task', 'Plan roadmap', 'PLAN ROADMAP'],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    const existingRow = screen.getByTestId('bulk-row-0');
    const planRow = screen.getByTestId('bulk-row-1');
    const repeatedRow = screen.getByTestId('bulk-row-2');
    expect(within(existingRow).getByText('Already in the matrix')).toBeVisible();
    expect(within(repeatedRow).getByText('Repeated in this import')).toBeVisible();
    expect(within(existingRow).getByRole('checkbox')).not.toBeChecked();
    expect(within(repeatedRow).getByRole('checkbox')).not.toBeChecked();

    fireEvent.change(within(planRow).getByLabelText('Task title'), {
      target: { value: 'Plan Q4 roadmap' },
    });
    fireEvent.change(within(planRow).getByLabelText('Quadrant'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(1));
    expect(onAddTask).toHaveBeenCalledWith(
      { title: 'Plan Q4 roadmap', description: '', urgent: true, important: false },
      expect.stringMatching(/^web-bulk-import-/)
    );
    expect(screen.getByText('Created 1. Skipped duplicates 2. Failed 0.')).toBeVisible();
  });

  it('keeps a stable idempotency key for a failed row retry and reports partial outcomes per row', async () => {
    const onAddTask = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    renderBulk(onAddTask);
    fireEvent.change(screen.getByLabelText('Tasks to import'), {
      target: { value: 'Plan roadmap' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Classify and review' }));
    await screen.findByRole('group', { name: 'Review before import' });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));
    await screen.findByText('Created 0. Skipped duplicates 0. Failed 1.');
    const firstKey = onAddTask.mock.calls[0][1];
    expect(screen.getByTestId('bulk-row-0')).toHaveTextContent('Failed');

    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    await screen.findByText('Created 1. Skipped duplicates 0. Failed 0.');
    expect(onAddTask.mock.calls[1][1]).toBe(firstKey);
    expect(screen.getByTestId('bulk-row-0')).toHaveTextContent('Created');
  });
});
