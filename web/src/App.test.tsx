import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { clearApiToken, setApiToken } from './authSession';
import * as api from './services/api';

jest.mock('./services/api');
jest.mock('./components/Matrix', () => ({
  __esModule: true,
  default: ({ tasks, loading, onAddTask, onUpdateTask, onDeleteTask }: any) => (
    <section aria-label="Test board">
      <p>{loading ? 'board-loading' : 'board-ready'}</p>
      {tasks.map((task: any) => (
        <p key={task._id}>{task.title}</p>
      ))}
      <button
        type="button"
        onClick={() =>
          void onAddTask({
            title: 'New task',
            description: '',
            urgent: false,
            important: false,
          }).catch(() => undefined)
        }
      >
        test-add
      </button>
      <button
        type="button"
        onClick={() => void onUpdateTask('1', { title: 'Updated title' }).catch(() => undefined)}
      >
        test-update
      </button>
      <button type="button" onClick={() => void onDeleteTask('1').catch(() => undefined)}>
        test-delete
      </button>
    </section>
  ),
}));
jest.mock('./components/matrixLazyComponents', () => ({
  __esModule: true,
  AIToolsComponent: ({
    initialTab,
    onClose,
    onAnalysisComplete,
  }: {
    initialTab?: string;
    onClose: () => void;
    onAnalysisComplete: () => void;
  }) => (
    <div>
      <p>{initialTab === 'manage' ? 'Administration panel' : 'AI tools'}</p>
      <button type="button" onClick={onAnalysisComplete}>
        complete-admin-analysis
      </button>
      <button type="button" onClick={onClose}>
        close-admin
      </button>
    </div>
  ),
}));

const mockedApi = jest.mocked(api);
const initialTask = {
  _id: '1',
  title: 'Existing task',
  description: 'desc',
  urgent: true,
  important: false,
  revision: 7,
};

describe('App', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'pl');
    setApiToken('runtime-only-code');
    mockedApi.getTasks.mockResolvedValue([initialTask]);
    mockedApi.createTask.mockResolvedValue({
      _id: '2',
      title: 'New task',
      description: '',
      urgent: false,
      important: false,
      revision: 1,
    });
    mockedApi.updateTask.mockResolvedValue({ ...initialTask, title: 'Updated title', revision: 8 });
    mockedApi.deleteTask.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => clearApiToken());
  });

  it('guides access in plain language and unlocks with an in-memory code', async () => {
    clearApiToken();
    render(<App />);

    const input = screen.getByLabelText('Kod dostępu');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveFocus();
    expect(screen.getByText(/otrzymasz od administratora/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wejdź do systemu' })).toBeDisabled();

    fireEvent.change(input, { target: { value: ' entered-code ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(mockedApi.getTasks).toHaveBeenCalled());
  });

  it('keeps an empty access form locked', () => {
    clearApiToken();
    render(<App />);
    fireEvent.submit(screen.getByLabelText('Kod dostępu').closest('form')!);
    expect(mockedApi.getTasks).not.toHaveBeenCalled();
  });

  it('shows a rejected-code next step and restores focus', () => {
    clearApiToken('rejected');
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent(/nieprawidłowy lub wygasł/i);
    expect(screen.getByLabelText('Kod dostępu')).toHaveFocus();
  });

  it('loads tasks, reports a confirmed fresh state and opens administration independently', async () => {
    render(<App />);
    expect(screen.getByText('board-loading')).toBeInTheDocument();
    expect(await screen.findByText('Existing task')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/dane są aktualne/i);
    fireEvent.click(screen.getByRole('button', { name: 'Odśwież tablicę' }));
    await waitFor(() => expect(mockedApi.getTasks).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Administracja' }));
    expect(screen.getByText('Administration panel')).toBeInTheDocument();
    fireEvent.click(screen.getByText('complete-admin-analysis'));
    fireEvent.click(screen.getByText('close-admin'));
    expect(screen.queryByText('Administration panel')).not.toBeInTheDocument();
  });

  it('shows offline state, never claims freshness and retries locally', async () => {
    mockedApi.getTasks.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/brak połączenia/i));
    expect(screen.queryByText(/dane są aktualne/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    await screen.findByText('Existing task');
    expect(mockedApi.getTasks).toHaveBeenCalledTimes(2);
  });

  it('maps generic, forbidden and unauthorized load failures to safe local guidance', async () => {
    const cases = [
      [new Error('raw server detail'), /nie udało się pobrać/i],
      [Object.assign(new Error('raw forbidden'), { status: 403 }), /nie masz uprawnień/i],
      [Object.assign(new Error('raw unauthorized'), { status: 401 }), /kod jest nieprawidłowy/i],
    ] as const;

    for (const [failure, message] of cases) {
      mockedApi.getTasks.mockRejectedValueOnce(failure);
      const view = render(<App />);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
      expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('reacts to browser offline and online events and removes listeners on unmount', async () => {
    const view = render(<App />);
    await screen.findByText('Existing task');
    fireEvent(window, new Event('offline'));
    expect(screen.getByRole('alert')).toHaveTextContent(/brak połączenia/i);
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(mockedApi.getTasks).toHaveBeenCalledTimes(2));
    view.unmount();
    fireEvent(window, new Event('online'));
    expect(mockedApi.getTasks).toHaveBeenCalledTimes(2);
  });

  it('creates, edits and deletes using the current revision', async () => {
    render(<App />);
    await screen.findByText('Existing task');
    fireEvent.click(screen.getByText('test-add'));
    expect(await screen.findByText('New task')).toBeInTheDocument();
    fireEvent.click(screen.getByText('test-update'));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith('1', { title: 'Updated title' }, 7)
    );
    expect(await screen.findByText('Updated title')).toBeInTheDocument();
    fireEvent.click(screen.getByText('test-delete'));
    await waitFor(() => expect(mockedApi.deleteTask).toHaveBeenCalledWith('1', 8));
    await waitFor(() => expect(screen.queryByText('Updated title')).not.toBeInTheDocument());
  });

  it('uses revision-less compatibility only when the server omitted a revision', async () => {
    mockedApi.getTasks.mockResolvedValueOnce([{ ...initialTask, revision: undefined }]);
    render(<App />);
    await screen.findByText('Existing task');
    fireEvent.click(screen.getByText('test-update'));
    await waitFor(() =>
      expect(mockedApi.updateTask).toHaveBeenCalledWith('1', { title: 'Updated title' }, undefined)
    );
  });

  it('returns understandable mutation failures while preserving server conflict semantics', async () => {
    render(<App />);
    await screen.findByText('Existing task');

    mockedApi.createTask.mockRejectedValueOnce('unknown');
    fireEvent.click(screen.getByText('test-add'));

    mockedApi.updateTask.mockRejectedValueOnce(
      Object.assign(new Error('raw conflict'), { status: 412 })
    );
    fireEvent.click(screen.getByText('test-update'));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalled());

    mockedApi.deleteTask.mockRejectedValueOnce(
      Object.assign(new Error('raw forbidden'), { status: 403 })
    );
    fireEvent.click(screen.getByText('test-delete'));
    await waitFor(() => expect(mockedApi.deleteTask).toHaveBeenCalled());
  });

  it('logs out without persisting the access code', async () => {
    render(<App />);
    await screen.findByText('Existing task');
    fireEvent.click(screen.getByRole('button', { name: 'Wyloguj' }));
    expect(screen.getByLabelText('Kod dostępu')).toBeInTheDocument();
    expect(localStorage.getItem('api-token')).toBeNull();
  });
});
