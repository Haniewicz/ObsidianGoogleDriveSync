import { Platform, requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

export async function requestGoogleUrl(options: RequestUrlParam): Promise<RequestUrlResponse> {
  try {
    return await requestUrl(options);
  } catch (error) {
    if (!shouldUseFetchFallback(error)) throw error;
    try {
      return await fetchRequestUrl(options);
    } catch (fallbackError) {
      throw new Error(`Obsidian requestUrl failed: ${formatRequestError(error)}; fetch fallback failed: ${formatRequestError(fallbackError)}`);
    }
  }
}

export function formatRequestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isDnsResolutionError(error: unknown): boolean {
  return /UnknownHostException|Unable to resolve host|ERR_NAME_NOT_RESOLVED/i.test(formatRequestError(error));
}

function shouldUseFetchFallback(error: unknown): boolean {
  return Platform.isMobile && isDnsResolutionError(error) && typeof fetch === "function";
}

async function fetchRequestUrl(options: RequestUrlParam): Promise<RequestUrlResponse> {
  const response = await fetch(options.url, {
    method: options.method ?? "GET",
    headers: buildFetchHeaders(options),
    body: options.body
  });

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
