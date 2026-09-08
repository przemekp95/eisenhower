import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LightMyRequestResponse } from 'fastify';

export interface TestResponse {
  status: number;
  statusCode: number;
  headers: Record<string, any>;
  body: any;
  text: string;
}

type AppInput = NestFastifyApplication | Promise<NestFastifyApplication>;
type TestMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'DELETE';

export class TestRequest implements PromiseLike<TestResponse> {
  private headers: Record<string, string> = {};
  private payload: unknown;
  private queryParameters: Record<string, string> = {};

  constructor(
    private readonly app: AppInput,
    private readonly method: TestMethod,
    private readonly path: string,
  ) {}

  set(name: string | Record<string, string>, value?: string) {
    if (typeof name === 'string') this.headers[name] = value ?? '';
    else Object.assign(this.headers, name);
    return this;
  }

  send(payload?: unknown) {
    this.payload = payload;
    return this;
  }

  query(parameters: Record<string, unknown>) {
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined) this.queryParameters[key] = String(value);
    }
    return this;
  }

  then<TResult1 = TestResponse, TResult2 = never>(
    onfulfilled?: ((value: TestResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute() {
    const app = await this.app;
    const search = new URLSearchParams(this.queryParameters).toString();
    const url = `${this.path}${search ? `${this.path.includes('?') ? '&' : '?'}${search}` : ''}`;
    const response = await app.inject({
      method: this.method,
      url,
      headers: this.headers,
      ...(this.payload === undefined ? {} : { payload: this.payload as string | object }),
    });
    return toTestResponse(response);
  }
}

export type Test = TestRequest;
export type Response = TestResponse;

function toTestResponse(response: LightMyRequestResponse): TestResponse {
  const text = response.body;
  const contentType = String(response.headers['content-type'] ?? '');
  let body: unknown = {};
  if (text && contentType.includes('json')) {
    try { body = JSON.parse(text); } catch { body = {}; }
  }
  return {
    status: response.statusCode,
    statusCode: response.statusCode,
    headers: response.headers as Record<string, any>,
    body,
    text,
  };
}

export function request(app: AppInput) {
  const build = (method: TestMethod) => (path: string) => new TestRequest(app, method, path);
  return {
    get: build('GET'),
    head: build('HEAD'),
    options: build('OPTIONS'),
    post: build('POST'),
    put: build('PUT'),
    delete: build('DELETE'),
  };
}

export default request;
