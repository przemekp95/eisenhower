import { runtimeConfig } from '../config';
import {
  addTrainingExample,
  analyzeWithLangChain,
  batchAnalyzeTasks,
  classifyTask,
  createTask,
  deleteTask,
  extractTasksFromImage,
  getCapabilities,
  getExamplesByQuadrant,
  getTasks,
  getTrainingStats,
  learnFromFeedback,
  retrainModel,
  updateTask,
} from './api';

describe('api service', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('uses runtime config for task CRUD', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [{ _id: '1', title: 'Task', description: '', urgent: false, important: false }],
    });

    await getTasks();
    await createTask({ title: 'Task', description: '', urgent: false, important: false });
    await updateTask('1', { urgent: true });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: new Headers(),
      json: async () => undefined,
    });
    await deleteTask('1');

    expect(global.fetch).toHaveBeenCalledWith(`${runtimeConfig.apiUrl}/tasks`);
    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.apiUrl}/tasks`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `${runtimeConfig.apiUrl}/tasks/1`,
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('uses runtime config for AI endpoints', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ total_examples: 1 }),
    });

    await classifyTask('urgent');
    await analyzeWithLangChain('urgent');
    await batchAnalyzeTasks(['one']);
    await extractTasksFromImage(new File(['task'], 'tasks.txt', { type: 'text/plain' }));
    await addTrainingExample('task', 1);
    await learnFromFeedback('task', 1, 2);
    await retrainModel(false);
    await getTrainingStats();
    await getExamplesByQuadrant(0, 5);
    await getCapabilities();

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(runtimeConfig.aiApiUrl);
  });

  it('throws JSON errors when requests fail', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'Validation failed' }),
    });

    await expect(createTask({ title: '', description: '', urgent: false, important: false })).rejects.toThrow(
      'Validation failed'
    );
  });

  it('throws a generic error for non-json failures', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => undefined,
    });

    await expect(classifyTask('urgent')).rejects.toThrow('Request failed');
  });
});
