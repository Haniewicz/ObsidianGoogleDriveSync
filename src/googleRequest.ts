import { Platform, requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

const FETCH_TIMEOUT_MS = 15000;
const REQUEST_RETRY_COUNT = 3;
const REQUEST_RETRY_DELAY_MS = 1000;

export class FetchFallbackError extends Error {
  constructor(readonly primaryError: unknown, readonly fallbackError: unknown) {
    super(`Obsidian requestUrl failed: ${formatRequestError(primaryError)}; fetch fallback failed: ${formatRequestError(fallbackError)}`);
  }
}

export async function requestGoogleUrl(options: RequestUrlParam): Promise<RequestUrlResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REQUEST_RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, REQUEST_RETRY_DELAY_MS * attempt));
    }
    try {
      return await requestUrl(options);
    } catch (error) {
      lastError = error;
      if (!shouldUseFetchFallback(error)) {
        if (isDnsResolutionError(error) && attempt < REQUEST_RETRY_COUNT - 1) continue;
        throw error;
      }
      try {
        return await fetchRequestUrl(options);
      } catch (fallbackError) {
        lastError = new FetchFallbackError(error, fallbackError);
        if (attempt < REQUEST_RETRY_COUNT - 1) continue;
        throw lastError;
      }
    }
  }
  throw lastError;
}

export function formatRequestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isDnsResolutionError(error: unknown): boolean {
  if (error instanceof FetchFallbackError) return isDnsResolutionError(error.primaryError);
  return /UnknownHostException|Unable to resolve host|ERR_NAME_NOT_RESOLVED/i.test(formatRequestError(error));
}

function shouldUseFetchFallback(error: unknown): boolean {
  return Platform.isMobile && isDnsResolutionError(error) && typeof fetch === "function";
}

async function fetchRequestUrl(options: RequestUrlParam): Promise<RequestUrlResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(options.url, {
      method: options.method ?? "GET",
      headers: buildFetchHeaders(options),
      body: options.body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const arrayBuffer = await response.arrayBuffer();
  const headers = readFetchHeaders(response.headers);
  const text = shouldDecodeText(headers) ? new TextDecoder().decode(arrayBuffer) : "";
  const json = parseJson(text);

  if (response.status >= 400 && options.throw !== false) {
    throw new Error(`Request failed (${response.status}).`);
  }

  return {
    status: response.status,
    headers,
    arrayBuffer,
    json,
    text
  };
}

function buildFetchHeaders(options: RequestUrlParam): Record<string, string> | undefined {
  const headers = { ...options.headers };
  if (options.contentType && headers["Content-Type"] === undefined && headers["content-type"] === undefined) {
    headers["Content-Type"] = options.contentType;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function readFetchHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function shouldDecodeText(headers: Record<string, string>): boolean {
  const contentType = headers["content-type"] ?? "";
  return /(^text\/)|json|xml|javascript|x-www-form-urlencoded/i.test(contentType);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
