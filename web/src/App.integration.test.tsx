import http from 'node:http';
import https from 'node:https';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RunningBackendProcess } from './testUtils/backendProcess';
import { startBackendProcess } from './testUtils/backendProcess';

interface TaskPayload {
  _id: string;
  title: string;
  description: string;
  urgent: boolean;
  important: boolean;
}

let backend: RunningBackendProcess;
let AppComponent: typeof import('./App').default;

const originalApiUrl = process.env.VITE_API_URL;
const originalAiApiUrl = process.env.VITE_AI_API_URL;
const originalFetch = global.fetch;

jest.setTimeout(120_000);

function normalizeHeaders(headers?: HeadersInit) {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers;
}

function createNodeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const requestUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = normalizeHeaders(init.headers);

    return new Promise((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: init.method ?? 'GET',
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const responseHeaders = {
              get(name: string) {
                const value = response.headers[name.toLowerCase()];
                if (Array.isArray(value)) {
                  return value.join(', ');
                }

                return value ?? null;
              },
            };

            resolve({
              ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
              status: response.statusCode ?? 0,
              headers: responseHeaders,
              json: async () => (body ? JSON.parse(body) : undefined),
              text: async () => body,
            } as Response);
          });
        }
      );

      request.once('error', reject);

      if (init.body) {
        request.write(typeof init.body === 'string' ? init.body : String(init.body));
      }

      request.end();
    });
  }) as typeof fetch;
}

async function createBackendTask(task: Omit<TaskPayload, '_id'>) {
  const response = await fetch(`${backend.url}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(task),
  });

  return (await response.json()) as TaskPayload;
}

async function listBackendTasks() {
  const response = await fetch(`${backend.url}/tasks`);
  return (await response.json()) as TaskPayload[];
}

describe('App integration', () => {
  beforeAll(async () => {
    backend = await startBackendProcess();
    global.fetch = createNodeFetch();

    process.env.VITE_API_URL = backend.url;
    process.env.VITE_AI_API_URL = 'http://127.0.0.1:8100';

    AppComponent = (await import('./App')).default;
  });

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    if (backend) {
      await backend.stop();
    }

    if (originalApiUrl === undefined) {
      delete process.env.VITE_API_URL;
    } else {
      process.env.VITE_API_URL = originalApiUrl;
    }

    if (originalAiApiUrl === undefined) {
      delete process.env.VITE_AI_API_URL;
    } else {
      process.env.VITE_AI_API_URL = originalAiApiUrl;
    }

    if (originalFetch === undefined) {
      delete global.fetch;
    } else {
      global.fetch = originalFetch;
    }
  });

  it('loads live tasks from the backend and refreshes them', async () => {
    await createBackendTask({
      title: 'Seeded live task',
      description: 'loaded from integration backend',
      urgent: true,
      important: false,
    });

    render(<AppComponent />);

    expect(screen.getByText(/Ładowanie zadań/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Seeded live task')).toBeInTheDocument());

    await createBackendTask({
      title: 'Fresh after refresh',
      description: 'arrived later',
      urgent: false,
      important: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Odśwież' }));

    await waitFor(() => expect(screen.getByText('Fresh after refresh')).toBeInTheDocument());
  });

  it('creates, updates and deletes tasks against the live backend', async () => {
    render(<AppComponent />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Dodaj zadanie' })).toBeInTheDocument());
    const title = `Live integration task ${Date.now()}`;

    fireEvent.change(screen.getByPlaceholderText(/Tytuł zadania/i), {
      target: { value: title },
    });
    fireEvent.change(screen.getByPlaceholderText(/Opis/i), {
      target: { value: 'real backend, no mocks' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dodaj zadanie' }));

    await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument());

    await waitFor(async () => {
      const tasks = await listBackendTasks();
      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title,
            description: 'real backend, no mocks',
            urgent: false,
            important: false,
          }),
        ])
      );
    });

    fireEvent.click(screen.getByLabelText(`toggle urgent ${title}`));

    await waitFor(async () => {
      const tasks = await listBackendTasks();
      expect(tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title,
            urgent: true,
            important: false,
          }),
        ])
      );
    });

    const taskCard = await screen.findByText(title);
    const article = taskCard.closest('article');
    expect(article).not.toBeNull();

    fireEvent.click(within(article as HTMLElement).getByRole('button', { name: 'Usuń' }));

    await waitFor(() => expect(screen.queryByText(title)).not.toBeInTheDocument());
    await waitFor(async () => {
      const tasks = await listBackendTasks();
      expect(tasks).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title,
          }),
        ])
      );
    });
  });
});
