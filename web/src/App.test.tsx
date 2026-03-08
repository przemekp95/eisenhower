import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import * as api from './services/api';

jest.mock('./services/api');

const mockShouldDisableMotion = jest.fn(() => true);
const mockGsapContext = jest.fn();
const mockGsapTimeline = jest.fn();
const mockGsapFrom = jest.fn();
const mockGsapTo = jest.fn();
const mockGsapRevert = jest.fn();
const timelineOnCompleteCallbacks: Array<() => void> = [];

jest.mock('./hooks/useSmoothScroll', () => jest.fn());
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

const mockedApi = jest.mocked(api);

describe('App', () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const originalScrollY = window.scrollY;

  beforeEach(() => {
    jest.clearAllMocks();
    timelineOnCompleteCallbacks.length = 0;
    mockShouldDisableMotion.mockReturnValue(true);
    mockGsapRevert.mockReset();
    mockGsapContext.mockImplementation((callback: () => void) => {
      callback();
      return { revert: mockGsapRevert };
    });
    mockGsapTimeline.mockImplementation((config?: { onComplete?: () => void }) => {
      const chain = {
        from: jest.fn().mockReturnThis(),
        to: jest.fn().mockReturnThis(),
      };

      if (config?.onComplete) {
        timelineOnCompleteCallbacks.push(config.onComplete);
        config.onComplete();
      }
      return chain;
    });
    mockGsapFrom.mockImplementation(() => undefined);
    mockGsapTo.mockImplementation(() => undefined);
    mockedApi.getTasks.mockResolvedValue([
      { _id: '1', title: 'Existing task', description: 'desc', urgent: true, important: false },
    ]);
    mockedApi.createTask.mockImplementation(async (task) => ({ _id: '2', ...task }));
    mockedApi.updateTask.mockImplementation(async (id, patch) => ({
      _id: id,
      title: 'Existing task',
      description: 'desc',
      urgent: Boolean(patch.urgent),
      important: false,
    }));
    mockedApi.deleteTask.mockResolvedValue(undefined);
    mockedApi.classifyTask.mockResolvedValue({
      task: 'urgent item',
      urgent: true,
      important: false,
      quadrant: 1,
      quadrant_name: 'Schedule',
      timestamp: new Date().toISOString(),
      method: 'heuristic',
    });
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: originalScrollY,
    });
  });

  it('loads tasks and renders the header', async () => {
    render(<App />);

    expect(screen.getByText(/Ładowanie zadań/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Existing task')).toBeInTheDocument());
  });

  it('surfaces fetch errors', async () => {
    mockedApi.getTasks.mockRejectedValueOnce(new Error('Network down'));

    render(<App />);

    await waitFor(() => expect(screen.getByText('Network down')).toBeInTheDocument());
  });

  it('falls back to translated load errors for non-error failures', async () => {
    mockedApi.getTasks.mockRejectedValueOnce('offline');

    render(<App />);

    await waitFor(() => expect(screen.getByText('Nie udało się pobrać zadań.')).toBeInTheDocument());
  });

  it('creates and removes tasks through the API layer', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Existing task')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'New task' },
    });
    fireEvent.click(screen.getByText(/Dodaj zadanie/i));

    await waitFor(() => expect(mockedApi.createTask).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('New task')).toBeInTheDocument());

    const deleteButtons = screen.getAllByText(/Usuń/i);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => expect(mockedApi.deleteTask).toHaveBeenCalledWith('1'));
  });

  it('updates tasks and refreshes data', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Existing task')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('toggle urgent Existing task'));
    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith('1', { urgent: false }));

    fireEvent.click(screen.getByText(/Odśwież/i));
    await waitFor(() => expect(mockedApi.getTasks.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('shows save errors from task mutations', async () => {
    mockedApi.createTask.mockRejectedValueOnce(new Error('Save failed'));

    render(<App />);
    await waitFor(() => expect(screen.getByText('Existing task')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'Broken task' },
    });
    fireEvent.click(screen.getByText(/Dodaj zadanie/i));

    await waitFor(() => expect(screen.getByText('Save failed')).toBeInTheDocument());
  });

  it('falls back to translated save errors for non-error mutations', async () => {
    mockedApi.createTask.mockRejectedValueOnce('save failed');

    render(<App />);
    await waitFor(() => expect(screen.getByText('Existing task')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: 'Broken task' },
    });
    fireEvent.click(screen.getByText(/Dodaj zadanie/i));

    await waitFor(() => expect(screen.getByText('Nie udało się zapisać zmian.')).toBeInTheDocument());
  });

  it('falls back to translated save errors for update and delete failures', async () => {
    mockedApi.getTasks.mockResolvedValueOnce([
      { _id: '1', title: 'Existing task', description: 'desc', urgent: true, important: false },
      { _id: '2', title: 'Secondary task', description: 'desc', urgent: false, important: false },
    ]);
    mockedApi.updateTask.mockRejectedValueOnce('update failed');
    mockedApi.deleteTask.mockRejectedValueOnce('delete failed');

    render(<App />);
    await waitFor(() => expect(screen.getByText('Secondary task')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('toggle urgent Existing task'));
    await waitFor(() => expect(screen.getByText('Nie udało się zapisać zmian.')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText(/Usuń/i)[0]);
    await waitFor(() => expect(mockedApi.deleteTask).toHaveBeenCalledWith('1'));
    expect(screen.getByText('Nie udało się zapisać zmian.')).toBeInTheDocument();
  });

  it('keeps untouched tasks in place when one card updates', async () => {
    mockedApi.getTasks.mockResolvedValueOnce([
      { _id: '1', title: 'Existing task', description: 'desc', urgent: true, important: false },
      { _id: '2', title: 'Secondary task', description: 'desc', urgent: false, important: false },
    ]);
    mockedApi.updateTask.mockResolvedValueOnce({
      _id: '1',
      title: 'Existing task',
      description: 'desc',
      urgent: false,
      important: false,
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText('Secondary task')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('toggle urgent Existing task'));

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith('1', { urgent: false }));
    expect(screen.getByText('Secondary task')).toBeInTheDocument();
  });

  it('keeps unaffected tasks when updating the second card', async () => {
    mockedApi.getTasks.mockResolvedValueOnce([
      { _id: '1', title: 'Existing task', description: 'desc', urgent: true, important: false },
      { _id: '2', title: 'Secondary task', description: 'desc', urgent: false, important: false },
    ]);
    mockedApi.updateTask.mockResolvedValueOnce({
      _id: '2',
      title: 'Secondary task',
      description: 'desc',
      urgent: true,
      important: false,
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText('Secondary task')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('toggle urgent Secondary task'));

    await waitFor(() => expect(mockedApi.updateTask).toHaveBeenCalledWith('2', { urgent: true }));
    expect(screen.getByText('Existing task')).toBeInTheDocument();
  });

  it('removes only the deleted task from local state', async () => {
    mockedApi.getTasks.mockResolvedValueOnce([
      { _id: '1', title: 'Existing task', description: 'desc', urgent: true, important: false },
      { _id: '2', title: 'Secondary task', description: 'desc', urgent: false, important: false },
    ]);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Secondary task')).toBeInTheDocument());

    const existingTaskCard = screen.getByText('Existing task').closest('article');
    fireEvent.click(within(existingTaskCard as HTMLElement).getByText(/Usuń/i));

    await waitFor(() => expect(mockedApi.deleteTask).toHaveBeenCalledWith('1'));
    await waitFor(() => expect(screen.queryByText('Existing task')).not.toBeInTheDocument());
    expect(screen.getByText('Secondary task')).toBeInTheDocument();
  });

  it('shows explicit update and delete error messages from Error objects', async () => {
    mockedApi.updateTask.mockRejectedValueOnce(new Error('Update failed'));
    mockedApi.deleteTask.mockRejectedValueOnce(new Error('Delete failed'));

    render(<App />);
    await waitFor(() => expect(screen.getByText('Existing task')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('toggle urgent Existing task'));
    await waitFor(() => expect(screen.getByText('Update failed')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText(/Usuń/i)[0]);
    await waitFor(() => expect(screen.getByText('Delete failed')).toBeInTheDocument());
  });

  it('initializes and cleans up hero motion when enabled', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    const { unmount } = render(<App />);

    await waitFor(() => expect(mockGsapContext).toHaveBeenCalledTimes(2));
    expect(mockGsapTimeline).toHaveBeenCalledTimes(2);
    expect(mockGsapTo).toHaveBeenCalledTimes(5);

    unmount();

    expect(mockGsapRevert).toHaveBeenCalledTimes(2);
  });

  it('marks the intro as ready when motion setup throws', async () => {
    mockShouldDisableMotion.mockReturnValue(false);
    mockGsapContext.mockImplementationOnce(() => {
      throw new Error('motion failed');
    });

    render(<App />);

    await waitFor(() =>
      expect(document.querySelector('main')).toHaveAttribute('data-app-intro', 'ready')
    );
  });

  it('skips hero motion setup when unmounted before gsap resolves', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    const { unmount } = render(<App />);
    unmount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGsapContext).not.toHaveBeenCalled();
  });

  it('ignores delayed motion completion after unmount', async () => {
    mockShouldDisableMotion.mockReturnValue(false);
    mockGsapTimeline.mockImplementation((config?: { onComplete?: () => void }) => {
      if (config?.onComplete) {
        timelineOnCompleteCallbacks.push(config.onComplete);
      }

      return {
        from: jest.fn().mockReturnThis(),
        to: jest.fn().mockReturnThis(),
      };
    });

    const { unmount } = render(<App />);

    await waitFor(() => expect(mockGsapContext).toHaveBeenCalledTimes(2));

    unmount();

    act(() => {
      timelineOnCompleteCallbacks.forEach((callback) => callback());
    });

    expect(mockGsapRevert).toHaveBeenCalledTimes(2);
  });

  it('animates hero parallax on scroll without queueing duplicate frames', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    let frameCallback: FrameRequestCallback | undefined;
    window.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    window.cancelAnimationFrame = jest.fn();

    render(<App />);

    await waitFor(() => expect(mockGsapContext).toHaveBeenCalledTimes(2));

    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 210,
    });

    fireEvent.scroll(window);
    fireEvent.scroll(window);

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    await act(async () => {
      frameCallback?.(16);
    });

    expect(mockGsapTo).toHaveBeenCalledTimes(9);

    fireEvent.scroll(window);

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it('handles missing parallax targets without trying to animate them', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    const originalQuerySelector = HTMLElement.prototype.querySelector;
    const querySelectorSpy = jest
      .spyOn(HTMLElement.prototype, 'querySelector')
      .mockImplementation(function mockQuerySelector(selector: string) {
        if (
          selector === '[data-app-shell]' ||
          selector === '[data-app-preview]' ||
          selector === '[data-app-backdrop]' ||
          selector === '[data-app-badges]'
        ) {
          return null;
        }

        return originalQuerySelector.call(this, selector);
      });

    let frameCallback: FrameRequestCallback | undefined;
    window.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    window.cancelAnimationFrame = jest.fn();

    render(<App />);

    await waitFor(() => expect(mockGsapContext).toHaveBeenCalledTimes(2));

    fireEvent.scroll(window);

    await act(async () => {
      frameCallback?.(16);
    });

    querySelectorSpy.mockRestore();

    expect(mockGsapTo).toHaveBeenCalledTimes(5);
  });
});
