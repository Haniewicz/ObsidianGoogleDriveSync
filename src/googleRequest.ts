import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

const REQUEST_RETRY_COUNT = 3;
const REQUEST_RETRY_DELAY_MS = 1000;

export async function requestGoogleUrl(options: RequestUrlParam): Promise<RequestUrlResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REQUEST_RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => window.setTimeout(resolve, REQUEST_RETRY_DELAY_MS * attempt));
    }
    try {
      return await requestUrl(options);
    } catch (error) {
      lastError = error;
      if (isDnsResolutionError(error) && attempt < REQUEST_RETRY_COUNT - 1) continue;
      throw error;
    }
  }
  throw lastError;
}

export function formatRequestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isDnsResolutionError(error: unknown): boolean {
  return /UnknownHostException|Unable to resolve host|ERR_NAME_NOT_RESOLVED/i.test(formatRequestError(error));
}
