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
    taskTitle,
    taskDescription,
    onApplyDescription,
    onApplyQuadrant,
    onOCRTasksExtracted,
    onClose,
  }: {
    taskTitle: string;
    taskDescription?: string;
    onApplyDescription?: (description: string) => Promise<void> | void;
    onApplyQuadrant?: (patch: { urgent: boolean; important: boolean }) => Promise<void> | void;
    onOCRTasksExtracted: (result: api.OCRResult) => Promise<unknown>;
    onClose: () => void;
  }) => (
    <div>
      <p>AI tools</p>
      <p data-testid="assistant-target">{`${taskTitle}|${taskDescription ?? ''}`}</p>
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(onApplyDescription?.('AI description')).catch(() => undefined);
        }}
      >
        Apply assistant description
      </button>
      <button
        type="button"
        onClick={() => void onApplyQuadrant?.({ urgent: true, important: false })}
      >
        Apply assistant quadrant
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
          })
        }
      >
        Import scanned tasks
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

  it('opens scan and bulk import as separate matrix actions and closes each dialog', async () => {
    renderMatrix();

    fireEvent.click(screen.getByRole('button', { name: 'Skanuj zdjęcie' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Skanuj zdjęcie');
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dodaj zbiorczo' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Dodaj zadania zbiorczo');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Zamknij' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('applies a task-scoped quadrant suggestion and closes only that assistant', async () => {
    const onUpdateTask = jest.fn().mockResolvedValue(undefined);
    renderMatrix({ onUpdateTask });

    fireEvent.click(screen.getByRole('button', { name: 'Pomoc przy zadaniu Urgent task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply assistant quadrant' }));
    await waitFor(() =>
      expect(onUpdateTask).toHaveBeenCalledWith('1', {
        urgent: true,
        important: false,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close AI tools' }));
    expect(screen.queryByText('AI tools')).not.toBeInTheDocument();
  });

  it('keeps scan and bulk import visible above the matrix and task help scoped to a saved task', () => {
    renderMatrix();

    expect(screen.getByRole('button', { name: 'Dodaj zadanie' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Skanuj zdjęcie' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Dodaj zbiorczo' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pomoc przy zadaniu Urgent task' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Pomoc AI' })).not.toBeInTheDocument();
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

  it('opens the assistant from an owned task and persists only the confirmed patch', async () => {
    const onUpdateTask = jest.fn().mockResolvedValue(undefined);
    renderMatrix({
      tasks: [
        {
          _id: 'existing',
          title: 'Existing task',
          description: 'Existing description',
          urgent: false,
          important: true,
          lifecycleState: 'active',
        },
      ],
      onUpdateTask,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pomoc przy zadaniu Existing task' }));
    expect(await screen.findByTestId('assistant-target')).toHaveTextContent(
      'Existing task|Existing description'
    );
    expect(onUpdateTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply assistant description' }));
    await waitFor(() =>
      expect(onUpdateTask).toHaveBeenCalledWith('existing', { description: 'AI description' })
    );
  });

  it('surfaces an assistant write failure on the task and keeps the assistant open', async () => {
    const onUpdateTask = jest
      .fn()
      .mockRejectedValueOnce(new Error('revision conflict'))
      .mockRejectedValueOnce('offline');
    renderMatrix({
      tasks: [
        {
          _id: 'assistant-failure',
          title: 'Conflicting task',
          description: '',
          urgent: false,
          important: false,
          lifecycleState: 'active',
        },
      ],
      onUpdateTask,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pomoc przy zadaniu Conflicting task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply assistant description' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('revision conflict');
    expect(screen.getByTestId('assistant-target')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply assistant description' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Nie udało się zapisać zmian')
    );
  });

  it('does not offer mutating AI actions on delegated read-only tasks', () => {
    renderMatrix({
      taskView: 'delegated',
      tasks: [
        {
          _id: 'delegated-ai',
          title: 'Delegated AI task',
          description: '',
          urgent: true,
          important: false,
          lifecycleState: 'active',
        },
      ],
    });

    expect(
      screen.queryByRole('button', { name: 'Pomoc przy zadaniu Delegated AI task' })
    ).not.toBeInTheDocument();
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
