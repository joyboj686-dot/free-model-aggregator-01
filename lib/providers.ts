// Trial metadata and catalog normalization. No routing state, clock reads, or random choices.
import { readFileSync } from 'node:fs';

export const PROVIDERS_SCHEMA = 'free-model-aggregator-01/providers/v1';
export const RATINGS_SCHEMA = 'free-model-aggregator-01/ratings/v1';
export const WORKLOAD_SCHEMA = 'free-model-aggregator-01/workload/v1';
export type Wire = 'openai' | 'anthropic' | 'gemini';
export type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';
export type Json = Record<string, unknown>;
export interface ProviderDirectoryEntry {
  id: string; name: string; wire: Wire; auth: AuthScheme;
  base: string; key_env: string; key: string;
}
export interface ProviderDirectory { schema: string; providers: ProviderDirectoryEntry[] }
export interface CatalogModel { id: string; free: boolean; context_length: number | null }
export interface CatalogProvider {
  id: string; base_url: string; key_env: string; wire: Wire; models: CatalogModel[];
}
export interface CatalogReport { providers: CatalogProvider[] }
export interface RatingRow {
  model: string; provider: string; rating_milli: number; context_length: number | null;
  tools: boolean; vision: boolean; json: boolean; free: boolean;
}
export interface RatingsFile {
  schema: string; ratings: RatingRow[]; best: { id: string; rating_milli: number }[];
}
export interface Requirement { tools?: boolean; vision?: boolean; json?: boolean; min_context?: number }
export interface WorkloadRequest {
  id: string; api: 'openai' | 'anthropic'; stream: boolean; weight: 1 | 2; requires: Requirement;
}
export interface WorkloadFile { schema: string; manifest: WorkloadRequest[] }
export interface Brief {
  directory: ProviderDirectory; ratings: RatingsFile | null; workload: WorkloadFile | null; error: string | null;
}
export interface Capabilities {
  context_length: number | null; tools: boolean | null; vision: boolean | null; json: boolean | null;
}
export interface ProbedModel extends Capabilities { id: string; display_name: string; free: boolean | null }
export interface Probe {
  provider: ProviderDirectoryEntry; ok: boolean; status: number; models: ProbedModel[]; error: string | null;
}

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const asText = (value: unknown): string => typeof value === 'string' ? value : '';
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asFlag = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const featureKeys = ['tools', 'vision', 'json'] as const;

// Track all open objects in one pass. Each opening brace is an independent candidate,
// so a valid document can still be recovered from surrounding prose or a JSON wrapper.
// Quotes only have meaning inside a candidate; quoted prose must not hide later JSON.
function schemaDocuments(source: string): Json[] {
  const openings: number[] = [];
  const spans: [number, number][] = [];
  let quoted = false;
  let escaped = false;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && openings.length) quoted = true;
    else if (char === '{') openings.push(cursor);
    else if (char === '}' && openings.length) spans.push([openings.pop()!, cursor + 1]);
  }
  const documents: Json[] = [];
  spans.sort((left, right) => left[0] - right[0]);
  for (const [begin, end] of spans) {
    try {
      const candidate: unknown = JSON.parse(source.slice(begin, end));
      if (isRecord(candidate) && typeof candidate.schema === 'string') documents.push(candidate);
    } catch { /* Balanced prose is not necessarily JSON. */ }
  }
  return documents;
}

function decodeProvider(value: unknown): ProviderDirectoryEntry | null {
  if (!isRecord(value) || !asText(value.id)) return null;
  const wire = value.wire;
  if (wire !== 'openai' && wire !== 'anthropic' && wire !== 'gemini') return null;
  const auth = value.auth;
  return {
    id: asText(value.id), name: asText(value.name) || asText(value.id), wire,
    auth: auth === 'none' || auth === 'x-api-key' || auth === 'x-goog-api-key' ? auth : 'bearer',
    base: ['path', 'base_path', 'base_url', 'base'].map(key => asText(value[key])).find(Boolean) ?? '',
    key_env: asText(value.key_env), key: asText(value.key),
  };
}

function decodeRating(value: unknown): RatingRow | null {
  if (!isRecord(value) || !asText(value.model) || !asText(value.provider)) return null;
  return {
    model: asText(value.model), provider: asText(value.provider),
    rating_milli: asNumber(value.rating_milli) ?? 0, context_length: asNumber(value.context_length),
    tools: value.tools === true, vision: value.vision === true,
    json: value.json === true, free: value.free === true,
  };
}

function decodeRequest(value: unknown): WorkloadRequest | null {
  if (!isRecord(value) || !asText(value.id)) return null;
  const needs = isRecord(value.requires) ? value.requires : {};
  const minimum = asNumber(needs.min_context);
  return {
    id: asText(value.id), api: value.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: value.stream === true, weight: value.weight === 2 ? 2 : 1,
    requires: {
      tools: needs.tools === true, vision: needs.vision === true, json: needs.json === true,
      ...(minimum === null ? {} : { min_context: minimum }),
    },
  };
}

function decodeRows<T>(values: unknown, decode: (value: unknown) => T | null): T[] {
  const rows: T[] = [];
  for (const value of list(values)) {
    const decoded = decode(value);
    if (decoded !== null) rows.push(decoded);
  }
  return rows;
}

export function readBrief(path: string): Brief {
  const result: Brief = {
    directory: { schema: PROVIDERS_SCHEMA, providers: [] }, ratings: null, workload: null, error: null,
  };
  if (!path) {
    result.error = 'MAKEFUN_PROMPT_FILE is not set';
    return result;
  }
  let documents: Json[];
  try { documents = schemaDocuments(readFileSync(path, 'utf8')); }
  catch (error) {
    result.error = `cannot read ${path}: ${(error as Error).message}`;
    return result;
  }
  const locate = (schema: string, rows: string) =>
    documents.find(document => document.schema === schema && Array.isArray(document[rows]));
  const directory = locate(PROVIDERS_SCHEMA, 'providers');
  if (!directory) {
    result.error = `the brief at ${path} holds no ${PROVIDERS_SCHEMA} document`;
    return result;
  }
  result.directory.providers = decodeRows(directory.providers, decodeProvider);
  const ratings = locate(RATINGS_SCHEMA, 'ratings');
  if (ratings) result.ratings = {
    schema: RATINGS_SCHEMA, ratings: decodeRows(ratings.ratings, decodeRating),
    best: decodeRows(ratings.best, value => {
      if (!isRecord(value) || !asText(value.id)) return null;
      return { id: asText(value.id), rating_milli: asNumber(value.rating_milli) ?? 0 };
    }),
  };
  const workload = locate(WORKLOAD_SCHEMA, 'manifest');
  if (workload) result.workload = {
    schema: WORKLOAD_SCHEMA, manifest: decodeRows(workload.manifest, decodeRequest),
  };
  return result;
}

export function joinBase(envUrl: string, base: string): string {
  const trimmed = base.trim();
  const path = trimmed.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return path;
  const separator = trimmed && !trimmed.startsWith('/') ? '/' : '';
  return envUrl.replace(/\/+$/, '') + separator + path;
}

export function authHeaders(auth: AuthScheme, key: string): Record<string, string> {
  if (!key || auth === 'none') return {};
  switch (auth) {
    case 'bearer': return { authorization: `Bearer ${key}` };
    case 'x-api-key': return { 'x-api-key': key };
    case 'x-goog-api-key': return { 'x-goog-api-key': key };
    default: return {};
  }
}

// Missing price information stays unknown; only a nonempty, wholly zero price
// table establishes free access. An explicit free flag takes precedence.
function priceFlag(value: unknown): boolean | null {
  if (!isRecord(value)) return null;
  const numbers: number[] = [];
  for (const price of Object.values(value)) {
    if (typeof price === 'number') numbers.push(price);
    else if (typeof price === 'string' && price.trim()) numbers.push(Number(price));
  }
  return numbers.length ? numbers.every(price => Number.isFinite(price) && price === 0) : null;
}

function decodeModel(wire: Wire, value: unknown): ProbedModel | null {
  if (!isRecord(value)) return null;
  const id = wire === 'gemini' ? asText(value.name).replace(/^models\//, '') : asText(value.id);
  if (!id) return null;
  return {
    id, display_name: asText(value.display_name) || asText(value.displayName) || id,
    free: asFlag(value.free) ?? priceFlag(value.pricing),
    context_length: asNumber(value.context_length) ?? asNumber(value.context_window) ?? asNumber(value.inputTokenLimit),
    tools: asFlag(value.tools), vision: asFlag(value.vision), json: asFlag(value.json),
  };
}

export async function probeProvider(envUrl: string, provider: ProviderDirectoryEntry, timeoutMs = 5000): Promise<Probe> {
  const endpoint = joinBase(envUrl, provider.base) + (provider.wire === 'gemini' ? '/v1beta/models' : '/v1/models');
  const probe: Probe = { provider, ok: false, status: 0, models: [], error: null };
  const headers = { accept: 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      probe.status = response.status;
      probe.error = `GET ${endpoint} answered HTTP ${response.status}`;
      return probe;
    }
    const payload: unknown = await response.json();
    const entries = isRecord(payload) ? payload[provider.wire === 'gemini' ? 'models' : 'data'] : [];
    probe.models = decodeRows(entries, value => decodeModel(provider.wire, value));
    probe.status = response.status;
    probe.ok = true;
  } catch (error) {
    probe.error = `GET ${endpoint} failed: ${(error as Error).message}`;
  }
  return probe;
}

export function ratingOfModel(ratings: RatingsFile | null, providerId: string, modelId: string): RatingRow | null {
  return ratings?.ratings.find(row => row.provider === providerId && row.model === modelId) ?? null;
}

export function modelFree(model: ProbedModel, row: RatingRow | null): boolean {
  return row === null ? model.free === true : row.free;
}

export function capabilitiesOf(model: ProbedModel, row: RatingRow | null): Capabilities {
  const capabilities: Capabilities = { ...model };
  for (const key of featureKeys) capabilities[key] = row?.[key] ?? model[key] ?? null;
  capabilities.context_length = row?.context_length ?? model.context_length ?? null;
  // Return only the capability contract, not listing identifiers or price fields.
  return { context_length: capabilities.context_length, tools: capabilities.tools, vision: capabilities.vision, json: capabilities.json };
}

export function meetsRequirements(requires: Requirement, caps: Capabilities): boolean {
  const hasFeatures = featureKeys.every(key => requires[key] !== true || caps[key] === true);
  const hasContext = requires.min_context === undefined ||
    (caps.context_length !== null && !(caps.context_length < requires.min_context));
  return hasFeatures && hasContext;
}

// Keep provider order, sort and deduplicate each model list, and never serialize
// the transient dial origin: registration must be identical on a fresh replay port.
export function buildCatalog(_envUrl: string, probes: readonly Probe[], ratings: RatingsFile | null): CatalogReport {
  return { providers: probes.filter(probe => probe.ok).map(({ provider, models }) => {
    const unique = new Map<string, ProbedModel>();
    for (const model of models) if (!unique.has(model.id)) unique.set(model.id, model);
    const ids = [...unique.keys()].sort();
    return {
      id: provider.id, base_url: provider.base, key_env: provider.key_env, wire: provider.wire,
      models: ids.map(id => {
        const model = unique.get(id)!;
        const rating = ratingOfModel(ratings, provider.id, id);
        return { id, free: modelFree(model, rating), context_length: rating?.context_length ?? model.context_length ?? null };
      }),
    };
  }) };
}
