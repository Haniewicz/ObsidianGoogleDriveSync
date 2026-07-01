import { Notice, Plugin, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { formatRequestError, isDnsResolutionError, requestGoogleUrl } from "./googleRequest";
import { DRIVE_SCOPE, PluginData, StoredAuth } from "./types";
import { sleep } from "./utils";

const DEVICE_ENDPOINT = "https://oauth2.googleapis.com/device/code";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";
const DRIVE_ABOUT_ENDPOINT = "https://www.googleapis.com/drive/v3/about?fields=user";
const GOOGLE_ACCOUNTS_ENDPOINT = "https://accounts.google.com/.well-known/openid-configuration";

type DeviceResponse = {
  device_code: string;
  user_code: string;
  verification_url?: string;
  verification_uri?: string;
  verification_url_complete?: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export type DeviceFlowSession = {
  device: DeviceResponse;
  cancel: () => void;
  done: Promise<StoredAuth>;
};

export type NetworkDiagnosticResult = {
  name: string;
  host: string;
  url: string;
  method: string;
  ok: boolean;
  reachable: boolean;
  expectedErrorResponse?: boolean;
  note?: string;
  status?: number;
  statusText?: string;
  responseError?: string;
  responseDescription?: string;
  responsePreview?: string;
  durationMs: number;
  error?: string;
};

type NetworkDiagnosticTest = {
  name: string;
  host: string;
  request: RequestUrlParam;
  expectedError?: string;
  note?: string;
};

export async function runGoogleNetworkDiagnostics(clientId: string, clientSecret: string): Promise<NetworkDiagnosticResult[]> {
  const tests: NetworkDiagnosticTest[] = [
    {
      name: "OAuth device endpoint",
      host: "oauth2.googleapis.com",
      request: {
        url: DEVICE_ENDPOINT,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId.trim() || "diagnostic-client-id", scope: DRIVE_SCOPE }).toString(),
        throw: false
      }
    },
    {
      name: "OAuth token endpoint",
      host: "oauth2.googleapis.com",
      request: {
        url: TOKEN_ENDPOINT,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId.trim() || "diagnostic-client-id",
          client_secret: clientSecret.trim() || "diagnostic-client-secret",
          refresh_token: "diagnostic-refresh-token",
          grant_type: "refresh_token"
        }).toString(),
        throw: false
      },
      expectedError: "invalid_grant",
      note: "Expected for this diagnostic request because it uses a fake refresh token. It proves the device reached Google's token endpoint."
    },
    {
      name: "Drive API endpoint",
      host: "www.googleapis.com",
      request: {
        url: DRIVE_ABOUT_ENDPOINT,
        method: "GET",
        throw: false
      }
    },
    {
      name: "Google Accounts endpoint",
      host: "accounts.google.com",
      request: {
        url: GOOGLE_ACCOUNTS_ENDPOINT,
        method: "GET",
        throw: false
      }
    }
  ];

  const results: NetworkDiagnosticResult[] = [];
  for (const test of tests) {
    const startedAt = Date.now();
    try {
      const response = await requestGoogleUrl(test.request);
      const body = readDiagnosticBody(response);
      const parsed = parseDiagnosticBody(body);
      const expectedErrorResponse = test.expectedError !== undefined && parsed.error === test.expectedError;
      results.push({
        name: test.name,
        host: test.host,
        url: String(test.request.url),
        method: test.request.method ?? "GET",
        ok: response.status >= 200 && response.status < 300,
        reachable: true,
        expectedErrorResponse,
        note: expectedErrorResponse ? test.note : undefined,
        status: response.status,
        statusText: response.status >= 200 && response.status < 300 ? "HTTP success" : "HTTP error response",
        responseError: parsed.error,
        responseDescription: parsed.error_description ?? parsed.message,
        responsePreview: parsed.preview,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      results.push({
        name: test.name,
        host: test.host,
        url: String(test.request.url),
        method: test.request.method ?? "GET",
        ok: false,
        reachable: false,
        durationMs: Date.now() - startedAt,
        error: formatRequestError(error)
      });
    }
  }
  return results;
}

export class GoogleAuth {
  private auth?: StoredAuth;

  constructor(
    private plugin: Plugin,
    private getClientId: () => string,
    private getClientSecret: () => string,
    private savePluginData: (data: Partial<PluginData>) => Promise<void>,
    private markDisconnected: () => Promise<void>
  ) {}

  setAuth(auth?: StoredAuth) {
    this.auth = auth;
  }

  getAuth(): StoredAuth | undefined {
    return this.auth;
  }

  async startDeviceFlow(): Promise<DeviceFlowSession> {
    const clientId = this.requireClientId();
    this.requireClientSecret();
    const response = await this.requestGoogle({
      url: DEVICE_ENDPOINT,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: DRIVE_SCOPE }).toString(),
      throw: false
    }, "oauth2.googleapis.com");
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google device authorization failed (${response.status}).`);
    }
    const device = response.json as DeviceResponse;
    let cancelled = false;
    const done = this.pollForToken(device, () => cancelled);
    return {
      device,
      cancel: () => {
        cancelled = true;
      },
      done
    };
  }

  async getValidAccessToken(): Promise<string> {
    if (!this.auth?.access_token) throw new Error("Google Drive is not connected.");
    if (this.auth.expires_at - Date.now() > 60000) return this.auth.access_token;
    await this.refresh();
    if (!this.auth?.access_token) throw new Error("Google Drive is not connected.");
    return this.auth.access_token;
  }

  async disconnect() {
    this.auth = undefined;
    await this.savePluginData({ auth: undefined });
  }

  async getAccountLabel(): Promise<string | undefined> {
    try {
      const token = await this.getValidAccessToken();
      const response = await this.requestGoogle({
        url: USERINFO_ENDPOINT,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      }, "www.googleapis.com");
      if (response.status >= 200 && response.status < 300) {
        const body = response.json as { email?: string; name?: string };
        return body.email ?? body.name;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async pollForToken(device: DeviceResponse, isCancelled: () => boolean): Promise<StoredAuth> {
    const clientId = this.requireClientId();
    const clientSecret = this.requireClientSecret();
    let intervalMs = Math.max(1, device.interval ?? 5) * 1000;
    const expiresAt = Date.now() + device.expires_in * 1000;
    while (Date.now() < expiresAt) {
      if (isCancelled()) throw new Error("Google authorization cancelled.");
      await sleep(intervalMs);
      if (isCancelled()) throw new Error("Google authorization cancelled.");
      const response = await this.requestGoogle({
        url: TOKEN_ENDPOINT,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        }).toString(),
        throw: false
      }, "oauth2.googleapis.com");
      const body = response.json as TokenResponse;
      if (response.status >= 200 && response.status < 300 && body.access_token) {
        const auth: StoredAuth = {
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_at: Date.now() + Math.max(0, body.expires_in ?? 3600) * 1000,
          scope: body.scope,
          token_type: body.token_type
        };
        this.auth = auth;
        await this.savePluginData({ auth });
        return auth;
      }
      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      if (body.error === "expired_token") throw new Error("Google authorization code expired.");
      if (body.error === "access_denied") throw new Error("Google authorization was denied.");
      throw new Error(this.formatTokenError(body, response.status));
    }
    throw new Error("Google authorization code expired.");
  }

  private async refresh(): Promise<void> {
    if (!this.auth?.refresh_token) {
      await this.markDisconnected();
      throw new Error("Google session expired. Please reconnect.");
    }
    const clientId = this.requireClientId();
    const clientSecret = this.requireClientSecret();
    const response = await this.requestGoogle({
      url: TOKEN_ENDPOINT,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: this.auth.refresh_token,
        grant_type: "refresh_token"
      }).toString(),
      throw: false
    }, "oauth2.googleapis.com");
    const body = response.json as TokenResponse;
    if (response.status >= 200 && response.status < 300 && body.access_token) {
      this.auth = {
        ...this.auth,
        access_token: body.access_token,
        expires_at: Date.now() + Math.max(0, body.expires_in ?? 3600) * 1000,
        scope: body.scope ?? this.auth.scope,
        token_type: body.token_type ?? this.auth.token_type
      };
      await this.savePluginData({ auth: this.auth });
      return;
    }
    await this.markDisconnected();
    new Notice("Google Drive session expired. Please reconnect.");
    throw new Error(this.formatTokenError(body, response.status));
  }

  private requireClientId(): string {
    const clientId = this.getClientId().trim();
    if (!clientId) throw new Error("Add a Google OAuth client ID in Google Drive Vault Sync settings first.");
    return clientId;
  }

  private requireClientSecret(): string {
    const clientSecret = this.getClientSecret().trim();
    if (!clientSecret) throw new Error("Add a Google OAuth client secret in Google Drive Vault Sync settings first.");
    return clientSecret;
  }

  private formatTokenError(body: TokenResponse, status: number): string {
    const message = body.error_description || body.error || `Google token request failed (${status}).`;
    if (message.toLowerCase().includes("client secret")) {
      return "This OAuth client requires a client secret. Copy the client secret from Google Cloud Console and paste it in Google Drive Vault Sync settings.";
    }
    return message;
  }

  private async requestGoogle(options: RequestUrlParam, host: string): Promise<RequestUrlResponse> {
    try {
      return await requestGoogleUrl(options);
    } catch (error) {
      throw this.formatNetworkError(error, host);
    }
  }

  private formatNetworkError(error: unknown, host: string): Error {
    const message = formatRequestError(error);
    if (isDnsResolutionError(error)) {
      return new Error(`Could not resolve ${host}. Check the mobile device internet connection, Private DNS/VPN settings, and whether Obsidian has network access, then try connecting Google Drive again.`);
    }
    return error instanceof Error ? error : new Error(message);
  }
}

function readDiagnosticBody(response: RequestUrlResponse): string {
  if (typeof response.text === "string") return response.text;
  try {
    if (response.json !== undefined) return JSON.stringify(response.json);
  } catch {
    return "";
  }
  return "";
}

function parseDiagnosticBody(body: string): { error?: string; error_description?: string; message?: string; preview?: string } {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string; status?: string };
      error_description?: string;
      message?: string;
    };
    const error = typeof parsed.error === "string" ? parsed.error : parsed.error?.status;
    const message = parsed.message ?? (typeof parsed.error === "object" ? parsed.error.message : undefined);
    return {
      error,
      error_description: parsed.error_description,
      message,
      preview: truncateDiagnosticText(body)
    };
  } catch {
    return { preview: truncateDiagnosticText(body.replace(/\s+/g, " ").trim()) };
  }
}

function truncateDiagnosticText(value: string): string | undefined {
  if (!value) return undefined;
  return value.length > 220 ? `${value.slice(0, 220)}...` : value;
}
