import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Matrix from './components/Matrix';
import { LanguageProvider } from './i18n/LanguageContext';
import * as api from './services/api';
import { quadrantToTaskState, resolveQuadrantLabel, resolveSuggestedQuadrant } from './components/matrixUtils';

jest.mock('./services/api');

const dragCallbacks: Array<(result: unknown) => void | Promise<void>> = [];
const matrixTimelineOnCompleteCallbacks: Array<() => void> = [];

jest.mock('@hello-pangea/dnd', () => {
  const React = require('react');

  return {
    DragDropContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (result: unknown) => void }) => {
      dragCallbacks.push(onDragEnd);
      return React.createElement('div', { 'data-testid': 'drag-context' }, children);
    },
    Droppable: ({ children, droppableId }: { children: Function; droppableId: string }) =>
      children(
        {
          innerRef: jest.fn(),
          droppableProps: { 'data-droppable-id': droppableId },
          placeholder: null,
        },
        {}
      ),
    Draggable: ({ children, draggableId }: { children: Function; draggableId: string }) =>
      children(
        {
          innerRef: jest.fn(),
          draggableProps: { 'data-draggable-id': draggableId },
          dragHandleProps: { 'data-drag-handle': draggableId },
        },
        {}
      ),
  };
});
jest.mock('./components/matrixLazyComponents', () => ({
  __esModule: true,
  MatrixSceneComponent: () => <div data-testid="matrix-scene" />,
  AIToolsComponent: ({
    onAnalysisComplete,
    onAnalysisTaskAdd,
    onOCRTasksExtracted,
    onClose,
  }: {
    onAnalysisComplete: (analysis: api.LangChainAnalysis) => void;
    onAnalysisTaskAdd: (analysis: api.LangChainAnalysis) => Promise<void>;
    onOCRTasksExtracted: (result: api.OCRResult) => Promise<number>;
    onClose: () => void;
  }) => (
    <div>
      <p>AI tools</p>
      <button
        type="button"
        onClick={() =>
          void onAnalysisTaskAdd({
            task: 'critical task',
            langchain_analysis: {
              quadrant: 1,
              reasoning: 'Schedule this',
              confidence: 0.9,
              method: 'langchain',
            },
            rag_classification: {
              quadrant: 0,
              quadrant_name: 'Do Now',
              confidence: 0.7,
            },
            comparison: {
              methods_agree: false,
              confidence_difference: 0.2,
            },
            timestamp: new Date().toISOString(),
          })
        }
      >
        Add analyzed task
      </button>
      <button
        type="button"
        onClick={() =>
          onAnalysisComplete({
            task: 'critical task',
            langchain_analysis: {
              quadrant: 2,
              reasoning: 'Delegate this',
              confidence: 0.9,
              method: 'langchain',
            },
            rag_classification: {
              quadrant: 0,
              quadrant_name: 'Do Now',
              confidence: 0.7,
            },
            comparison: {
              methods_agree: false,
              confidence_difference: 0.2,
            },
            timestamp: new Date().toISOString(),
          })
        }
      >
        Apply AI analysis
      </button>
      <button
        type="button"
        onClick={() =>
          void onOCRTasksExtracted({
            filename: 'tasks.txt',
            image_info: {
              size_bytes: 32,
              shape: 'unknown',
            },
            ocr: {
              extracted_text: 'Escalate outage\nPlan roadmap',
              raw_tasks_detected: 3,
              method: 'tesseract',
            },
            classified_tasks: [
              {
                text: 'Escalate outage',
                quadrant: 0,
                quadrant_name: 'Do Now',
                confidence: 0.96,
              },
              {
                text: '   ',
                quadrant: 1,
                quadrant_name: 'Schedule',
                confidence: 0.2,
              },
              {
                text: 'Plan roadmap',
                quadrant: 2,
                quadrant_name: 'Delegate',
                confidence: 0.74,
              },
              {
                text: 'Escalate outage',
                quadrant: 0,
                quadrant_name: 'Do Now',
                confidence: 0.9,
              },
            ],
            summary: {
              total_tasks: 3,
              quadrant_distribution: {
                counts: { 0: 2, 1: 0, 2: 1, 3: 0 },
                percentages: { 0: 66.67, 1: 0, 2: 33.33, 3: 0 },
                quadrant_names: { 0: 'Do Now', 1: 'Schedule', 2: 'Delegate', 3: 'Delete' },
              },
            },
            timestamp: new Date().toISOString(),
          })
        }
      >
        Import OCR tasks
      </button>
      <button type="button" onClick={onClose}>
        Close AI tools
      </button>
    </div>
  ),
}));

const mockShouldDisableMotion = jest.fn(() => true);
const mockGsapContext = jest.fn();
const mockGsapTimeline = jest.fn();
const mockGsapFrom = jest.fn();
const mockGsapTo = jest.fn();
const mockGsapRevert = jest.fn();

jest.mock('./lib/motion', () => ({
  shouldDisableMotion: () => mockShouldDisableMotion(),
}));
jest.mock('gsap', () => ({
  gsap: {
    context: (...args: unknown[]) => mockGsapContext(...args),
    timeline: (...args: unknown[]) => mockGsapTimeline(...args),
    from: (...args: unknown[]) => mockGsapFrom(...args),
    to: (...args: unknown[]) => mockGsapTo(...args),
  },
}));

const classifyTask = jest.mocked(api.classifyTask);
const learnFromAcceptedOCRTasks = jest.mocked(api.learnFromAcceptedOCRTasks);

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
    learnFromAcceptedOCRTasks.mockResolvedValue({ examples_added: 2, retrained: true });
    dragCallbacks.length = 0;
    matrixTimelineOnCompleteCallbacks.length = 0;
    mockShouldDisableMotion.mockReturnValue(true);
    mockGsapContext.mockImplementation((callback: () => void) => {
      callback();
      return { revert: mockGsapRevert };
    });
    mockGsapTimeline.mockImplementation((config?: { onComplete?: () => void }) => {
      if (config?.onComplete) {
        matrixTimelineOnCompleteCallbacks.push(config.onComplete);
        config.onComplete();
      }

      const chain = {
        to: jest.fn().mockReturnThis(),
      };
      return chain;
    });
    mockGsapFrom.mockImplementation(() => undefined);
    mockGsapTo.mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => {
      await Promise.resolve();
    });
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

  it('ignores empty submissions and trims form fields when creating a task', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={onAddTask} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByText(/Dodaj zadanie/i));
    expect(onAddTask).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: '  Plan sprintu  ' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Opis/i), {
      target: { value: '  dopiąć release  ' },
    });

    const formCheckboxes = screen.getAllByRole('checkbox');
    fireEvent.click(formCheckboxes[0]);
    fireEvent.click(formCheckboxes[1]);
    fireEvent.click(screen.getByText(/Dodaj zadanie/i));

    await waitFor(() =>
      expect(onAddTask).toHaveBeenCalledWith({
        title: 'Plan sprintu',
        description: 'dopiąć release',
        urgent: true,
        important: true,
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
      method: 'local-minilm',
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

  it('imports OCR tasks into the matrix form pipeline', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={onAddTask} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'dowolne zadanie' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));
    fireEvent.click(await screen.findByText('Import OCR tasks'));

    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(learnFromAcceptedOCRTasks).toHaveBeenCalledWith(
        [
          { text: 'Escalate outage', quadrant: 0 },
          { text: 'Plan roadmap', quadrant: 2 },
        ]
      )
    );
    expect(onAddTask).toHaveBeenNthCalledWith(1, {
      title: 'Escalate outage',
      description: '',
      urgent: true,
      important: true,
    });
    expect(onAddTask).toHaveBeenNthCalledWith(2, {
      title: 'Plan roadmap',
      description: '',
      urgent: false,
      important: true,
    });
  });

  it('keeps importing OCR tasks when persisting accepted OCR feedback fails', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);
    learnFromAcceptedOCRTasks.mockRejectedValueOnce(new Error('feedback offline'));

    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={onAddTask} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'dowolne zadanie' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));
    fireEvent.click(await screen.findByText('Import OCR tasks'));

    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(learnFromAcceptedOCRTasks).toHaveBeenCalledTimes(1));
  });

  it('adds the analyzed task to the matrix and resets the form', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={onAddTask} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'Przygotować plan kwartalny' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Opis/i), {
      target: { value: 'Do omówienia z zarządem' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));
    fireEvent.click(await screen.findByText('Add analyzed task'));

    await waitFor(() =>
      expect(onAddTask).toHaveBeenCalledWith({
        title: 'Przygotować plan kwartalny',
        description: 'Do omówienia z zarządem',
        urgent: true,
        important: false,
      })
    );
    await waitFor(() => expect(screen.getByPlaceholderText(/Tytuł zadania/i)).toHaveValue(''));
    await waitFor(() => expect(screen.queryByText(/AI tools/i)).not.toBeInTheDocument());
  });

  it('falls back to the analyzed title when the draft title is cleared before adding', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={onAddTask} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'tymczasowy tytuł' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));
    await screen.findByText('Add analyzed task');

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByText('Add analyzed task'));

    await waitFor(() =>
      expect(onAddTask).toHaveBeenCalledWith({
        title: 'critical task',
        description: '',
        urgent: true,
        important: false,
      })
    );
  });


  it('ignores empty AI suggestions', async () => {
    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={jest.fn()} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByText(/Zasugeruj kwadrant/i));

    expect(classifyTask).not.toHaveBeenCalled();
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

  it('falls back to a default message for non-error AI suggestion failures', async () => {
    classifyTask.mockRejectedValueOnce('offline');

    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={jest.fn()} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'critical task' },
    });
    fireEvent.click(screen.getByText(/Zasugeruj kwadrant/i));

    await waitFor(() => expect(screen.getByText('Suggestion failed')).toBeInTheDocument());
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

    await screen.findByText(/Apply AI analysis/i);
  });

  it('applies AI analysis results back into the form and closes the drawer', async () => {
    render(
      <LanguageProvider>
        <Matrix tasks={[]} loading={false} onAddTask={jest.fn()} onUpdateTask={jest.fn()} onDeleteTask={jest.fn()} />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'critical task' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));

    await screen.findByText(/Apply AI analysis/i);

    fireEvent.click(screen.getByText(/Apply AI analysis/i));

    await waitFor(() => {
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).not.toBeChecked();
      expect(checkboxes[1]).toBeChecked();
    });

    fireEvent.click(screen.getByText(/Close AI tools/i));

    await waitFor(() => expect(screen.queryByText(/AI tools/i)).not.toBeInTheDocument());
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
    expect(
      resolveQuadrantLabel(
        2,
        { 0: 'Do Now', 1: 'Schedule', 2: 'Delegate', 3: 'Delete' },
        (quadrant) => `Quadrant ${quadrant}`
      )
    ).toBe('Delegate');
    expect(
      resolveQuadrantLabel(
        9,
        { 0: 'Do Now', 1: 'Schedule', 2: 'Delegate', 3: 'Delete' },
        (quadrant) => `Quadrant ${quadrant}`
      )
    ).toBe('Quadrant 9');

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

  it('handles drag guard clauses and maps valid destinations to task state', async () => {
    const onUpdateTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix
          tasks={[{ _id: '1', title: 'Task', description: '', urgent: true, important: true }]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={onUpdateTask}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );

    const onDragEnd = dragCallbacks.at(-1);
    expect(onDragEnd).toBeDefined();

    await act(async () => {
      await onDragEnd?.({
        destination: null,
        source: { droppableId: 'do' },
        draggableId: '1',
      });
    });
    expect(onUpdateTask).not.toHaveBeenCalled();

    await act(async () => {
      await onDragEnd?.({
        destination: { droppableId: 'do' },
        source: { droppableId: 'do' },
        draggableId: '1',
      });
    });
    expect(onUpdateTask).not.toHaveBeenCalled();

    await act(async () => {
      await onDragEnd?.({
        destination: { droppableId: 'delete' },
        source: { droppableId: 'do' },
        draggableId: '1',
      });
    });

    expect(onUpdateTask).toHaveBeenCalledWith('1', { urgent: false, important: false });
  });

  it('initializes and cleans up matrix motion when enabled', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    const { unmount } = renderMatrix();

    await waitFor(() => expect(mockGsapContext).toHaveBeenCalledTimes(1));
    expect(mockGsapTimeline).toHaveBeenCalledTimes(1);
    expect(mockGsapTo).toHaveBeenCalledTimes(2);

    unmount();

    expect(mockGsapRevert).toHaveBeenCalledTimes(1);
  });

  it('marks the matrix intro as ready when motion setup throws', async () => {
    mockShouldDisableMotion.mockReturnValue(false);
    mockGsapContext.mockImplementationOnce(() => {
      throw new Error('motion failed');
    });

    const { container } = renderMatrix();

    await waitFor(() =>
      expect(container.firstChild).toHaveAttribute('data-matrix-intro', 'ready')
    );
  });

  it('skips matrix motion setup when unmounted before gsap resolves', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    const { unmount } = renderMatrix();
    unmount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGsapContext).not.toHaveBeenCalled();
  });

  it('ignores delayed matrix motion completion after unmount', async () => {
    mockShouldDisableMotion.mockReturnValue(false);
    mockGsapTimeline.mockImplementation((config?: { onComplete?: () => void }) => {
      if (config?.onComplete) {
        matrixTimelineOnCompleteCallbacks.push(config.onComplete);
      }

      return {
        to: jest.fn().mockReturnThis(),
      };
    });

    const { unmount } = renderMatrix();

    await waitFor(() => expect(mockGsapContext).toHaveBeenCalledTimes(1));

    unmount();

    act(() => {
      matrixTimelineOnCompleteCallbacks.forEach((callback) => callback());
    });

    expect(mockGsapRevert).toHaveBeenCalledTimes(1);
  });
});
