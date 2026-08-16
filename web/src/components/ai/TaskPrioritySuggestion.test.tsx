import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TaskPrioritySuggestion from './TaskPrioritySuggestion';
import { LanguageProvider } from '../../i18n/LanguageContext';
import * as api from '../../services/api';

jest.mock('../../services/api');

const mockedApi = jest.mocked(api);

function renderSuggestion(onApply = jest.fn().mockResolvedValue(undefined)) {
  return {
    onApply,
    ...render(
      <LanguageProvider>
        <TaskPrioritySuggestion
          taskTitle="Delegate the incident summary"
          currentUrgent={false}
          currentImportant={true}
          onApply={onApply}
        />
      </LanguageProvider>
    ),
  };
}

describe('TaskPrioritySuggestion', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    localStorage.setItem('eisenhower-language', 'en');
    mockedApi.classifyTask.mockResolvedValue({
      task: 'Delegate the incident summary',
      urgent: true,
      important: false,
      quadrant: 1,
      quadrant_name: 'Delegate',
      confidence: 0.86,
      confidence_status: 'high',
      requires_confirmation: false,
      timestamp: new Date().toISOString(),
      method: 'local-minilm',
    });
  });

  it('keeps the suggested quadrant staged until the user confirms it', async () => {
    const { onApply } = renderSuggestion();

    fireEvent.click(screen.getByRole('button', { name: 'Suggest quadrant' }));
    await screen.findByText('Suggested quadrant: Delegate');
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Review quadrant change' }));
    expect(screen.getByText('Schedule → Delegate')).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm quadrant change' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ urgent: true, important: false }));
    expect(screen.getByRole('status')).toHaveTextContent('Task quadrant updated');
  });

  it('warns about low confidence and preserves confirmation after a save failure', async () => {
    mockedApi.classifyTask.mockResolvedValueOnce({
      task: 'Delegate the incident summary',
      urgent: true,
      important: false,
      quadrant: 1,
      quadrant_name: 'Delegate',
      confidence: 0.42,
      confidence_status: 'low',
      requires_confirmation: true,
      timestamp: new Date().toISOString(),
      method: 'local-minilm',
    });
    const onApply = jest.fn().mockRejectedValue(new Error('revision conflict'));
    renderSuggestion(onApply);

    fireEvent.click(screen.getByRole('button', { name: 'Suggest quadrant' }));
    await screen.findByText(/low confidence/i);
    fireEvent.click(screen.getByRole('button', { name: 'Review quadrant change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm quadrant change' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not be updated/i)
    );
    expect(screen.getByRole('button', { name: 'Confirm quadrant change' })).toBeInTheDocument();
  });

  it('reports classifier failure and lets the user cancel a staged change', async () => {
    mockedApi.classifyTask.mockRejectedValueOnce(new Error('offline'));
    const view = renderSuggestion();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest quadrant' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be checked/i);

    mockedApi.classifyTask.mockResolvedValueOnce({
      task: 'Changed task',
      urgent: false,
      important: false,
      quadrant: 3,
      quadrant_name: 'Delete',
      confidence: 0.9,
      timestamp: new Date().toISOString(),
      method: 'local-minilm',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Suggest quadrant' }));
    await screen.findByText('Suggested quadrant: Delete');
    fireEvent.click(screen.getByRole('button', { name: 'Review quadrant change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Schedule → Delete')).not.toBeInTheDocument();

    view.rerender(
      <LanguageProvider>
        <TaskPrioritySuggestion
          taskTitle=""
          currentUrgent={false}
          currentImportant={false}
          onApply={jest.fn()}
        />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Suggest quadrant' }));
  });

  it.each([
    [true, true, 'Do Now → Delegate'],
    [true, false, 'Delegate → Delegate'],
  ])('labels the remaining current quadrant combinations', async (urgent, important, label) => {
    render(
      <LanguageProvider>
        <TaskPrioritySuggestion
          taskTitle="Delegate the incident summary"
          currentUrgent={urgent}
          currentImportant={important}
          onApply={jest.fn()}
        />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Suggest quadrant' }));
    await screen.findByText('Suggested quadrant: Delegate');
    fireEvent.click(screen.getByRole('button', { name: 'Review quadrant change' }));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('falls back to a numeric label for an unexpected classifier quadrant', async () => {
    mockedApi.classifyTask.mockResolvedValueOnce({
      task: 'Unexpected',
      urgent: false,
      important: false,
      quadrant: 9,
      quadrant_name: 'Unknown',
      confidence: 0.9,
      timestamp: new Date().toISOString(),
      method: 'local-minilm',
    } as unknown as api.ClassificationResult);
    renderSuggestion();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest quadrant' }));
    await screen.findByText('Suggested quadrant: 9');
  });
});
