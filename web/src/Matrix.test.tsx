import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Matrix from './components/Matrix';
import { LanguageProvider } from './i18n/LanguageContext';
import * as api from './services/api';
import { quadrantToTaskState, resolveSuggestedQuadrant } from './components/matrixUtils';

jest.mock('./services/api');

const mockShouldDisableMotion = jest.fn(() => true);
const mockGsapContext = jest.fn();
const mockGsapFrom = jest.fn();
const mockGsapTo = jest.fn();
const mockGsapRevert = jest.fn();

jest.mock('./lib/motion', () => ({
  shouldDisableMotion: () => mockShouldDisableMotion(),
}));
jest.mock('gsap', () => ({
  gsap: {
    context: (...args: unknown[]) => mockGsapContext(...args),
    from: (...args: unknown[]) => mockGsapFrom(...args),
    to: (...args: unknown[]) => mockGsapTo(...args),
  },
}));

const classifyTask = jest.mocked(api.classifyTask);

function renderMatrix() {
  return render(
    <LanguageProvider>
      <Matrix
        tasks={[
          { _id: '1', title: 'Urgent task', description: 'desc', urgent: true, important: true },
          { _id: '2', title: 'Later task', description: 'desc', urgent: false, important: true },
        ]}
        loading={false}
        onAddTask={jest.fn().mockResolvedValue(undefined)}
        onUpdateTask={jest.fn().mockResolvedValue(undefined)}
        onDeleteTask={jest.fn().mockResolvedValue(undefined)}
      />
    </LanguageProvider>
  );
}

describe('Matrix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShouldDisableMotion.mockReturnValue(true);
    mockGsapContext.mockImplementation((callback: () => void) => {
      callback();
      return { revert: mockGsapRevert };
    });
    mockGsapFrom.mockImplementation(() => undefined);
    mockGsapTo.mockImplementation(() => undefined);
  });

  it('renders quadrants and tasks', () => {
    renderMatrix();

    expect(screen.getByText(/Zrób teraz/i)).toBeInTheDocument();
    expect(screen.getByText('Urgent task')).toBeInTheDocument();
    expect(screen.getByText('Later task')).toBeInTheDocument();
  });

  it('submits a new task', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={onAddTask} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'Plan sprintu' },
    });
    fireEvent.click(screen.getByText(/Dodaj zadanie/i));

    await waitFor(() =>
      expect(onAddTask).toHaveBeenCalledWith({
        title: 'Plan sprintu',
        description: '',
        urgent: false,
        important: false,
      })
    );
  });

  it('toggles task flags and deletes tasks', async () => {
    const onUpdateTask = jest.fn().mockResolvedValue(undefined);
    const onDeleteTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix
          tasks={[{ _id: '1', title: 'Task', description: '', urgent: false, important: false }]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={onUpdateTask}
          onDeleteTask={onDeleteTask}
        />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByLabelText('toggle urgent Task'));
    fireEvent.click(screen.getByLabelText('toggle important Task'));
    fireEvent.click(screen.getAllByText(/Usuń/i).at(-1)!);

    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith('1', { urgent: true }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith('1', { important: true }));
    await waitFor(() => expect(onDeleteTask).toHaveBeenCalledWith('1'));
  });

  it('applies AI suggestion to the task form', async () => {
    classifyTask.mockResolvedValue({
      task: 'urgent client deadline',
      urgent: true,
      important: true,
      quadrant: 0,
      quadrant_name: 'Do Now',
      timestamp: new Date().toISOString(),
      method: 'heuristic',
    });

    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={jest.fn()} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'urgent client deadline' },
    });
    fireEvent.click(screen.getByText(/Zasugeruj kwadrant/i));

    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).toBeChecked();
      expect(checkboxes[1]).toBeChecked();
    });
  });

  it('surfaces AI suggestion errors', async () => {
    classifyTask.mockRejectedValueOnce(new Error('AI offline'));

    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={jest.fn()} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'critical task' },
    });
    fireEvent.click(screen.getByText(/Zasugeruj kwadrant/i));

    await waitFor(() => expect(screen.getByText('AI offline')).toBeInTheDocument());
  });

  it('opens lazy AI tools when a title exists', async () => {
    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={jest.fn()} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'critical task' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));

    await waitFor(() => expect(screen.getByText(/AI tools/i)).toBeInTheDocument());
  });

  it('preserves quadrant 0 from langchain analysis', () => {
    const resolved = resolveSuggestedQuadrant({
      task: 'critical task',
      langchain_analysis: {
        quadrant: 0,
        reasoning: 'Critical',
        confidence: 0.9,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 2,
        quadrant_name: 'Delegate',
        confidence: 0.7,
      },
      comparison: {
        methods_agree: false,
        confidence_difference: 0.2,
      },
      timestamp: new Date().toISOString(),
    });

    expect(resolved).toBe(0);
  });

  it('maps all quadrants to task state', () => {
    expect(quadrantToTaskState(1)).toEqual({ urgent: true, important: false });
    expect(quadrantToTaskState(2)).toEqual({ urgent: false, important: true });
    expect(quadrantToTaskState(3)).toEqual({ urgent: false, important: false });

    expect(resolveSuggestedQuadrant({
      task: 'non-urgent',
      langchain_analysis: {
        quadrant: null,
        reasoning: 'fallback',
        confidence: 0.5,
        method: 'langchain',
      },
      rag_classification: {
        quadrant: 3,
        quadrant_name: 'Delete',
        confidence: 0.5,
      },
      comparison: {
        methods_agree: true,
        confidence_difference: 0,
      },
      timestamp: new Date().toISOString(),
    })).toBe(3);
  });

  it('initializes and cleans up matrix motion when enabled', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    const { unmount } = renderMatrix();

    await waitFor(() => expect(mockGsapContext).toHaveBeenCalledTimes(1));
    expect(mockGsapFrom).toHaveBeenCalledTimes(2);
    expect(mockGsapTo).toHaveBeenCalledTimes(1);

    unmount();

    expect(mockGsapRevert).toHaveBeenCalledTimes(1);
  });
});
