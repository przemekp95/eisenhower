export type ContractMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'DELETE';

export interface ContractRequest {
  id: string;
  method: ContractMethod;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ContractResponse {
  status: number;
  headers: Record<string, string>;
  rawBody: string;
  jsonBody: unknown | null;
  state: Record<string, unknown>;
}

export interface ContractTarget {
  request(input: ContractRequest): Promise<ContractResponse>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface NormalizationRules {
  generatedHeaders?: string[];
  generatedJsonPaths?: Record<string, string>;
}

export interface ContractFixture {
  baselineSha: string;
  nodeVersion: string;
  cases: Array<{
    id: string;
    routeKey: string;
    request: ContractRequest;
    response: ContractResponse;
  }>;
}

export interface RouteManifestEntry {
  method: ContractMethod;
  path: string;
  currentRouter: string;
  finalModule: string;
  auth: 'public' | 'bearer-or-oidc' | 'internal-hmac';
  scope: string | null;
  trustedOrigin: 'not-applicable' | 'unsafe-methods';
  body: 'none' | 'json-32kb' | 'raw-json-32kb';
  sideEffects: string[];
  consumers: string[];
}

export interface ContractCase {
  route: RouteManifestEntry;
  request: ContractRequest;
  normalization?: NormalizationRules;
}
