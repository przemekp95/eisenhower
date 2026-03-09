import { runtimeConfig } from '../config';
import {
  addTrainingExample,
  analyzeWithLangChain,
  batchAnalyzeTasks,
  clearTrainingData,
  classifyTask,
  createTask,
  deleteTask,
  extractTasksFromImage,
  getCapabilities,
  getExamplesByQuadrant,
  getTasks,
  getTrainingStats,
  learnFromAcceptedOCRTasks,
  learnFromFeedback,
  retrainModel,
  setProviderEnabled,
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
    await analyzeWithLangChain('urgent', 'pl');
    await batchAnalyzeTasks(['one']);
    await extractTasksFromImage(new File(['task'], 'tasks.txt', { type: 'text/plain' }));
    await addTrainingExample('task', 1);
    await learnFromFeedback('task', 1, 2);
    await learnFromAcceptedOCRTasks([{ text: 'task', quadrant: 2 }], false);
    await retrainModel(false);
    await retrainModel();
    await getTrainingStats();
    await clearTrainingData(false);
    await clearTrainingData();
    await getExamplesByQuadrant(0);
    await getExamplesByQuadrant(0, 5);
    await getCapabilities();
    await setProviderEnabled('local_model', false);
    await setProviderEnabled('tesseract', true);

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(runtimeConfig.aiApiUrl);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('language=en');
    expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('language=pl');
    expect((global.fetch as jest.Mock).mock.calls[7][0]).toContain('/learn-ocr-feedback');
    expect((global.fetch as jest.Mock).mock.calls[7][1].body).toBe(
      JSON.stringify({ tasks: [{ task: 'task', quadrant: 2 }], retrain: false })
    );
    expect((global.fetch as jest.Mock).mock.calls[8][1].body.toString()).toContain('preserve_experience=false');
    expect((global.fetch as jest.Mock).mock.calls[9][1].body.toString()).toContain('preserve_experience=true');
    expect((global.fetch as jest.Mock).mock.calls[11][0]).toContain('/training-data?keep_defaults=false');
    expect((global.fetch as jest.Mock).mock.calls[12][0]).toContain('/training-data?keep_defaults=true');
    expect((global.fetch as jest.Mock).mock.calls[13][0]).toContain('/examples/0?limit=10');
    expect((global.fetch as jest.Mock).mock.calls[16][0]).toContain('/providers/local_model');
    expect((global.fetch as jest.Mock).mock.calls[16][1].body).toBe(JSON.stringify({ enabled: false }));
    expect((global.fetch as jest.Mock).mock.calls[17][0]).toContain('/providers/tesseract');
  });

  it('uses retrain=true by default for accepted OCR feedback', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ examples_added: 1, retrained: true }),
    });

    await learnFromAcceptedOCRTasks([{ text: 'task', quadrant: 0 }]);

    expect((global.fetch as jest.Mock).mock.calls[0][1].body).toBe(
      JSON.stringify({ tasks: [{ task: 'task', quadrant: 0 }], retrain: true })
    );
  });

  it('skips OCR feedback requests for empty accepted-task batches', async () => {
    await expect(learnFromAcceptedOCRTasks([])).resolves.toEqual({
      examples_added: 0,
      retrained: false,
    });

    expect(global.fetch).not.toHaveBeenCalled();
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

  it('falls back to a generic JSON error when the payload has no message', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
    });

    await expect(createTask({ title: '', description: '', urgent: false, important: false })).rejects.toThrow(
      'Request failed'
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
