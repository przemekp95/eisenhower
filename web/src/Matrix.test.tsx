import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Matrix from './components/Matrix';
import { LanguageProvider } from './i18n/LanguageContext';
import * as api from './services/api';
import {
  quadrantToTaskState,
  resolveQuadrantLabel,
  resolveSuggestedQuadrant,
} from './components/matrixUtils';

jest.mock('./services/api');

const dragCallbacks: Array<(result: unknown) => void | Promise<void>> = [];
const matrixTimelineOnCompleteCallbacks: Array<() => void> = [];

jest.mock('@hello-pangea/dnd', () => {
  const React = require('react');

  return {
    DragDropContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode;
      onDragEnd: (result: unknown) => void;
    }) => {
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
    onOCRTasksExtracted: (result: api.OCRResult, learn: boolean) => Promise<unknown>;
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
        Add analyzed task
      </button>
      <button
        type="button"
        onClick={() =>
          onAnalysisComplete({
            task: 'critical task',
            langchain_analysis: {
              quadrant: 2,
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
        Apply AI analysis
      </button>
      <button
        type="button"
        onClick={() =>
          void onOCRTasksExtracted(
            {
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
                  quadrant_name: 'Delegate',
                  confidence: 0.2,
                },
                {
                  text: 'Plan roadmap',
                  quadrant: 2,
                  quadrant_name: 'Schedule',
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
                  quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
                },
              },
              timestamp: new Date().toISOString(),
            },
            true
          )
        }
      >
        Import OCR tasks
      </button>
      <button
        type="button"
        onClick={() =>
          void onOCRTasksExtracted(
            {
              filename: 'one.txt',
              image_info: { size_bytes: 3, shape: 'unknown' },
              ocr: { extracted_text: 'One', raw_tasks_detected: 1, method: 'tesseract' },
              classified_tasks: [
                { text: 'One', quadrant: 1, quadrant_name: 'Delegate', confidence: 0.8 },
              ],
              summary: {
                total_tasks: 1,
                quadrant_distribution: {
                  counts: { 0: 0, 1: 1, 2: 0, 3: 0 },
                  percentages: { 0: 0, 1: 100, 2: 0, 3: 0 },
                  quadrant_names: { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
                },
              },
            },
            false
          )
        }
      >
        Import OCR without feedback
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

function renderMatrix(overrides: Partial<React.ComponentProps<typeof Matrix>> = {}) {
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
        {...overrides}
      />
    </LanguageProvider>
  );
}

describe('Matrix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem('eisenhower-language', 'pl');
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

  it('runs lifecycle filters and default workflow callbacks safely', async () => {
    renderMatrix({
      tasks: [
        {
          _id: 'workflow',
          title: 'Workflow task',
          description: '',
          urgent: true,
          important: false,
          lifecycleState: 'active',
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Wszystkie' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ukończ Workflow task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dodaj termin Workflow task' }));
    fireEvent.change(screen.getByLabelText('Termin'), { target: { value: '2026-08-16T09:30' } });
    fireEvent.change(screen.getByLabelText('Strefa czasowa'), { target: { value: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz termin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Przekaż Workflow task' }));
    fireEvent.change(screen.getByLabelText('Identyfikator osoby'), { target: { value: 'user-b' } });
    fireEvent.change(screen.getByLabelText('Nazwa wyświetlana'), { target: { value: 'Pat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Wyślij przekazanie' }));

    await act(async () => Promise.resolve());
  });

  it('renders delegated read-only cards with and without handoff details', () => {
    const view = renderMatrix({
      taskView: 'delegated',
      tasks: [
        {
          _id: 'plain',
          title: 'Plain delegated',
          description: '',
          urgent: true,
          important: false,
          lifecycleState: 'active',
        },
      ],
    });

    expect(
      screen.queryByRole('button', { name: 'Dodaj termin Plain delegated' })
    ).not.toBeInTheDocument();
    view.rerender(
      <LanguageProvider>
        <Matrix
          tasks={[
            {
              _id: 'assigned',
              title: 'Assigned delegated',
              description: '',
              urgent: true,
              important: false,
              lifecycleState: 'active',
              delegation: {
                assigneeUserId: 'user-b',
                displayLabel: 'Pat',
                handoffNote: '',
                status: 'offered',
                offeredAt: '2026-08-12T12:00:00.000Z',
                statusUpdatedAt: '2026-08-12T12:05:00.000Z',
              },
            },
          ]}
          loading={false}
          taskView="delegated"
          onAddTask={jest.fn()}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );
    expect(screen.getByText('Pat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Akceptuj Assigned delegated' }));
  });

  it('places delegate and schedule tasks under their canonical quadrant labels', () => {
    const view = render(
      <LanguageProvider>
        <Matrix
          tasks={[
            { _id: '1', title: 'Hand off alert', description: '', urgent: true, important: false },
            { _id: '2', title: 'Plan roadmap', description: '', urgent: false, important: true },
          ]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );

    expect(
      within(screen.getByText('Deleguj').closest('section') as HTMLElement).getByText(
        'Hand off alert'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByText('Zaplanuj').closest('section') as HTMLElement).getByText(
        'Plan roadmap'
      )
    ).toBeInTheDocument();
  });

  it('submits a new task', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={onAddTask}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'Plan sprintu' },
    });
    fireEvent.click(screen.getByText(/Dodaj zadanie/i));

    await waitFor(() =>
      expect(onAddTask).toHaveBeenCalledWith(
        {
          title: 'Plan sprintu',
          description: '',
          urgent: false,
          important: false,
        },
        expect.stringMatching(/^web-/)
      )
    );
  });

  it('keeps the complete draft when task creation rejects', async () => {
    const onAddTask = jest.fn().mockRejectedValue(new Error('offline'));
    renderMatrix({ onAddTask });

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania|Task title/i), {
      target: { value: 'Keep this draft' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Opis|Description/i), {
      target: { value: 'Still needed' },
    });
    fireEvent.click(screen.getByText(/Dodaj zadanie|Add task/i));

    await waitFor(() => expect(onAddTask).toHaveBeenCalled());
    expect(screen.getByPlaceholderText(/Tytuł zadania|Task title/i)).toHaveValue('Keep this draft');
    expect(screen.getByPlaceholderText(/Opis|Description/i)).toHaveValue('Still needed');
    expect(screen.getByRole('alert')).toHaveTextContent(/szkic pozostał/i);
  });

  it('reuses the create operation key for an unchanged retry and rotates it after editing', async () => {
    const onAddTask = jest.fn().mockRejectedValue(new Error('offline'));
    renderMatrix({ tasks: [], onAddTask });
    const title = screen.getByPlaceholderText(/Tytuł zadania|Task title/i);
    const submit = screen.getByRole('button', { name: /Dodaj zadanie|Add task/i });

    fireEvent.change(title, { target: { value: 'Retry this' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(1));
    const firstKey = onAddTask.mock.calls[0][1];

    fireEvent.click(submit);
    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(2));
    expect(onAddTask.mock.calls[1][1]).toBe(firstKey);

    fireEvent.change(title, { target: { value: 'Changed draft' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(3));
    expect(onAddTask.mock.calls[2][1]).not.toBe(firstKey);
  });

  it('prevents a second create request while the first request is pending', async () => {
    let finishCreate: (() => void) | undefined;
    const onAddTask = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        })
    );
    renderMatrix({ tasks: [], onAddTask });

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania|Task title/i), {
      target: { value: 'Only once' },
    });
    const submit = screen.getByRole('button', { name: /Dodaj zadanie|Add task/i });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(onAddTask).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent(/Zapisywanie|Saving/i);

    finishCreate?.();
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('ignores empty submissions and trims form fields when creating a task', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={onAddTask}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
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
      expect(onAddTask).toHaveBeenCalledWith(
        {
          title: 'Plan sprintu',
          description: 'dopiąć release',
          urgent: true,
          important: true,
        },
        expect.stringMatching(/^web-/)
      )
    );
  });

  it('toggles task flags and deletes tasks', async () => {
    const onUpdateTask = jest.fn().mockResolvedValue(undefined);
    const onDeleteTask = jest.fn().mockResolvedValue(undefined);

    const view = render(
      <LanguageProvider>
        <Matrix
          tasks={[
            {
              _id: '1',
              title: 'Task',
              description: '',
              urgent: false,
              important: false,
              lifecycleState: 'active',
            },
          ]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={onUpdateTask}
          onDeleteTask={onDeleteTask}
        />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByLabelText('Przełącz pilność zadania Task'));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith('1', { urgent: true }));
    fireEvent.click(screen.getByLabelText('Przełącz ważność zadania Task'));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith('1', { important: true }));

    view.rerender(
      <LanguageProvider>
        <Matrix
          tasks={[
            {
              _id: '1',
              title: 'Task',
              description: '',
              urgent: false,
              important: false,
              lifecycleState: 'trashed',
            },
          ]}
          loading={false}
          lifecycleFilter="trashed"
          onAddTask={jest.fn()}
          onUpdateTask={onUpdateTask}
          onDeleteTask={onDeleteTask}
        />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Usuń trwale Task' }));
    fireEvent.click(screen.getByText('Anuluj'));
    expect(onDeleteTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Usuń trwale Task' }));
    fireEvent.click(screen.getByText('Potwierdź trwałe usunięcie'));

    await waitFor(() => expect(onDeleteTask).toHaveBeenCalledWith('1'));
  });

  it('edits title and description and preserves the draft after a conflict', async () => {
    const onUpdateTask = jest
      .fn()
      .mockRejectedValueOnce(new Error('To zadanie zmieniło się w innym miejscu.'))
      .mockResolvedValueOnce(undefined);
    const view = renderMatrix({
      tasks: [
        {
          _id: '1',
          title: 'Old title',
          description: 'Old description',
          urgent: true,
          important: true,
        },
      ],
      onUpdateTask,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj Old title' }));
    fireEvent.change(screen.getByLabelText('Tytuł edytowanego zadania'), {
      target: { value: 'New title' },
    });
    fireEvent.change(screen.getByLabelText('Opis edytowanego zadania'), {
      target: { value: 'New description' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz zmiany' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/zmieniło się w innym miejscu/i);
    expect(screen.getByLabelText('Tytuł edytowanego zadania')).toHaveValue('New title');
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz zmiany' }));
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(2));
  });

  it('handles non-Error update failures, empty edits, cancellation and delete failures locally', async () => {
    const onUpdateTask = jest.fn().mockRejectedValue('offline');
    const onDeleteTask = jest
      .fn()
      .mockRejectedValueOnce(new Error('Delete unavailable'))
      .mockRejectedValueOnce('offline');
    const view = renderMatrix({
      tasks: [
        { _id: '1', title: 'Task', description: 'Description', urgent: true, important: true },
      ],
      onUpdateTask,
      onDeleteTask,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edytuj Task' }));
    const title = screen.getByLabelText('Tytuł edytowanego zadania');
    fireEvent.change(title, { target: { value: '   ' } });
    fireEvent.submit(title.closest('form')!);
    expect(onUpdateTask).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: 'Changed' } });
    fireEvent.submit(title.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/nie udało się zapisać/i);
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj edycję' }));
    expect(screen.queryByLabelText('Tytuł edytowanego zadania')).not.toBeInTheDocument();

    view.rerender(
      <LanguageProvider>
        <Matrix
          tasks={[
            {
              _id: '1',
              title: 'Task',
              description: 'Description',
              urgent: true,
              important: true,
              lifecycleState: 'trashed',
            },
          ]}
          loading={false}
          lifecycleFilter="trashed"
          onAddTask={jest.fn()}
          onUpdateTask={onUpdateTask}
          onDeleteTask={onDeleteTask}
        />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Usuń trwale Task' }));
    for (const expected of [/Delete unavailable/i, /nie udało się zapisać/i]) {
      fireEvent.click(screen.getByRole('button', { name: 'Potwierdź trwałe usunięcie' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    }
  });

  it('keeps the drag handle separate from task action buttons', () => {
    renderMatrix({
      tasks: [{ _id: 'drag', title: 'Move me', description: '', urgent: false, important: false }],
    });

    const card = screen.getByRole('article');
    const dragHandle = screen.getByRole('button', { name: 'Przeciągnij zadanie Move me' });

    expect(card).not.toHaveAttribute('data-drag-handle');
    expect(dragHandle).toHaveAttribute('data-drag-handle', 'drag');
  });

  it('localizes Polish toggle labels and visible pressed states', () => {
    localStorage.setItem('eisenhower-language', 'pl');
    renderMatrix({
      tasks: [{ _id: 'pl', title: 'Raport', description: '', urgent: true, important: false }],
    });

    expect(
      screen.getByRole('button', { name: 'Przełącz pilność zadania Raport' })
    ).toHaveTextContent('Pilne: włączone');
    expect(
      screen.getByRole('button', { name: 'Przełącz ważność zadania Raport' })
    ).toHaveTextContent('Ważne: wyłączone');
  });

  it('localizes English toggle labels and visible pressed states', () => {
    localStorage.setItem('eisenhower-language', 'en');
    renderMatrix({
      tasks: [{ _id: 'en', title: 'Report', description: '', urgent: false, important: true }],
    });

    expect(screen.getByRole('button', { name: 'Toggle urgent for Report' })).toHaveTextContent(
      'Urgent: off'
    );
    expect(screen.getByRole('button', { name: 'Toggle important for Report' })).toHaveTextContent(
      'Important: on'
    );
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
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
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
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={onAddTask}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'dowolne zadanie' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));
    fireEvent.click(await screen.findByText('Import OCR tasks'));

    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(learnFromAcceptedOCRTasks).toHaveBeenCalledWith([
        { text: 'Escalate outage', quadrant: 0 },
        { text: 'Plan roadmap', quadrant: 2 },
      ])
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
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={onAddTask}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
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

  it('imports reviewed OCR without feedback when consent is false', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);
    render(
      <LanguageProvider>
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={onAddTask}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );
    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'draft' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));
    fireEvent.click(await screen.findByText('Import OCR without feedback'));

    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(1));
    expect(learnFromAcceptedOCRTasks).not.toHaveBeenCalled();
  });

  it('reports unknown OCR feedback failures without losing persisted tasks', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);
    learnFromAcceptedOCRTasks.mockRejectedValueOnce('feedback offline');
    render(
      <LanguageProvider>
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={onAddTask}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );
    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'draft' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));
    fireEvent.click(await screen.findByText('Import OCR tasks'));

    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(2));
    expect(learnFromAcceptedOCRTasks).toHaveBeenCalledTimes(1);
  });

  it('sends OCR feedback only for tasks that were actually persisted', async () => {
    const onAddTask = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second write failed'));

    render(
      <LanguageProvider>
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={onAddTask}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );
    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'draft' },
    });
    fireEvent.click(screen.getByText(/Otwórz narzędzia AI/i));
    fireEvent.click(await screen.findByText('Import OCR tasks'));

    await waitFor(() => expect(onAddTask).toHaveBeenCalledTimes(2));
    expect(learnFromAcceptedOCRTasks).toHaveBeenCalledWith([
      { text: 'Escalate outage', quadrant: 0 },
    ]);
  });

  it('adds the analyzed task to the matrix and resets the form', async () => {
    const onAddTask = jest.fn().mockResolvedValue(undefined);

    render(
      <LanguageProvider>
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={onAddTask}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
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
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={onAddTask}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
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
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByText(/Zasugeruj kwadrant/i));

    expect(classifyTask).not.toHaveBeenCalled();
  });

  it('surfaces AI suggestion errors', async () => {
    classifyTask.mockRejectedValueOnce(new Error('AI offline'));

    render(
      <LanguageProvider>
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'critical task' },
    });
    fireEvent.click(screen.getByText(/Zasugeruj kwadrant/i));

    await waitFor(() => expect(screen.getByText('Analiza nie powiodła się')).toBeInTheDocument());
  });

  it('falls back to a default message for non-error AI suggestion failures', async () => {
    classifyTask.mockRejectedValueOnce('offline');

    render(
      <LanguageProvider>
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'critical task' },
    });
    fireEvent.click(screen.getByText(/Zasugeruj kwadrant/i));

    await waitFor(() => expect(screen.getByText('Analiza nie powiodła się')).toBeInTheDocument());
  });

  it('opens lazy AI tools when a title exists', async () => {
    render(
      <LanguageProvider>
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
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
        <Matrix
          tasks={[]}
          loading={false}
          onAddTask={jest.fn()}
          onUpdateTask={jest.fn()}
          onDeleteTask={jest.fn()}
        />
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
        quadrant_name: 'Schedule',
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
        { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
        (quadrant) => `Quadrant ${quadrant}`
      )
    ).toBe('Schedule');
    expect(
      resolveQuadrantLabel(
        9,
        { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' },
        (quadrant) => `Quadrant ${quadrant}`
      )
    ).toBe('Quadrant 9');

    expect(
      resolveSuggestedQuadrant({
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
      })
    ).toBe(3);
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

    await act(async () => {
      await onDragEnd?.({
        destination: { droppableId: 'delegate' },
        source: { droppableId: 'do' },
        draggableId: '1',
      });
    });
    expect(onUpdateTask).toHaveBeenLastCalledWith('1', { urgent: true, important: false });

    await act(async () => {
      await onDragEnd?.({
        destination: { droppableId: 'schedule' },
        source: { droppableId: 'do' },
        draggableId: '1',
      });
    });
    expect(onUpdateTask).toHaveBeenLastCalledWith('1', { urgent: false, important: true });
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

    await waitFor(() => expect(container.firstChild).toHaveAttribute('data-matrix-intro', 'ready'));
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
