import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import * as api from './services/api';

jest.mock('./services/api');

const mockedApi = jest.mocked(api);

describe('App', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
