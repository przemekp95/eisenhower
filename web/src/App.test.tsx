import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import * as api from './services/api';

jest.mock('./services/api');

const mockShouldDisableMotion = jest.fn(() => true);
const mockGsapContext = jest.fn();
const mockGsapTimeline = jest.fn();
const mockGsapFrom = jest.fn();
const mockGsapTo = jest.fn();
const mockGsapRevert = jest.fn();

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

      config?.onComplete?.();
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

  it('initializes and cleans up hero motion when enabled', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    const { unmount } = render(<App />);

    await waitFor(() => expect(mockGsapContext).toHaveBeenCalledTimes(2));
    expect(mockGsapTimeline).toHaveBeenCalledTimes(2);
    expect(mockGsapTo).toHaveBeenCalledTimes(5);

    unmount();

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
});
