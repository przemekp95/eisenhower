import { ContractResponse, NormalizationRules } from './types';

function replaceJsonPath(value: unknown, path: string[], replacement: string): unknown {
  if (path.length === 0) return replacement;
  if (Array.isArray(value)) {
    const [head, ...tail] = path;
    if (head === '*') return value.map((item) => replaceJsonPath(item, tail, replacement));
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return value;
    const copy = [...value];
    copy[index] = replaceJsonPath(copy[index], tail, replacement);
    return copy;
  }
  if (!value || typeof value !== 'object') return value;
  const [head, ...tail] = path;
  if (head === '*') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      replaceJsonPath(child, tail, replacement),
    ]));
  }
  if (!(head in value)) return value;
  return {
    ...(value as Record<string, unknown>),
    [head]: replaceJsonPath((value as Record<string, unknown>)[head], tail, replacement),
  };
}

export function normalizeResponse(
  response: ContractResponse,
  rules: NormalizationRules = {},
): ContractResponse {
  const generatedHeaders = new Set(
    (rules.generatedHeaders ?? []).map((header) => header.toLowerCase()),
  );
  const headers = Object.fromEntries(
    Object.entries(response.headers).map(([name, value]) => [
      name.toLowerCase(),
      generatedHeaders.has(name.toLowerCase()) ? `<${name.toLowerCase()}>` : value,
    ]),
  );
  let jsonBody = response.jsonBody;
  for (const [path, replacement] of Object.entries(rules.generatedJsonPaths ?? {})) {
    jsonBody = replaceJsonPath(jsonBody, path.split('.'), replacement);
  }
  return { ...response, headers, jsonBody };
}
