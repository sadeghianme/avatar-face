/**
 * Typed fetch client. All errors are ApiError {status, code, detail}.
 *
 * The session (docs/frontend-ui.md, "Security notes"): the access token
 * lives in this module's memory and nowhere else, and goes out as a bearer
 * header. The refresh token is an httpOnly cookie no script can read; the
 * browser sends it to /api/auth/* only. On a 401 the client refreshes ONCE
 * (one request however many calls were refused, and one at a time across
 * tabs) and retries; a session the server has ended signs this tab out
 * (onSignedOut).
 */

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  code: string;
  detail: string;
  /** The whole error payload, for the few errors that carry more than a
   *  sentence (a refused fit lists its reasons). */
  body: Record<string, unknown>;
  /** Seconds the server asked us to wait (Retry-After on a 429 or 503),
   *  so "busy, try again" can say when. Null when it did not say. */
  retryAfter: number | null;

  // Fields declared, not parameter properties: Node's type stripping (the
  // node --test suite imports this file) cannot run those.
  constructor(
    status: number,
    code: string,
    detail: string,
    body: Record<string, unknown> = {},
    retryAfter: number | null = null
  ) {
    super(detail);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

/** Retry-After as seconds; the HTTP-date form is not used by this API. */
function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

/** What sign-in, a refresh and a password reset answer (AccessToken). */
export interface SessionToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** Where older releases kept both tokens. Removed on load (forgetLegacyTokens). */
const LEGACY_TOKENS_KEY = "liveface.tokens";
/** Set by the API beside the refresh cookie, with nothing secret in it:
 *  whether there is a session to restore on load at all. */
const SESSION_HINT_COOKIE = "lf_session";
/** Serializes refreshes across this browser's tabs (Web Locks). */
const REFRESH_LOCK = "liveface-session-refresh";

let accessToken: string | null = null;
const signedOutListeners = new Set<() => void>();

/** The access token in memory, or null when signed out. */
export function getAccessToken(): string | null {
  return accessToken;
}

/** Adopt a session's access token (sign-in, a password reset), or forget it. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Whether the API says this browser holds a session (the lf_session cookie). */
export function hasSessionHint(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((part) => part.trim().startsWith(`${SESSION_HINT_COOKIE}=`));
}

/**
 * Drop the tokens an older release kept in localStorage. They were the
 * pair a script could read; the server no longer accepts them anyway.
 */
export function forgetLegacyTokens(): void {
  try {
    localStorage.removeItem(LEGACY_TOKENS_KEY);
  } catch {
    // no storage (a private window, a sandbox): nothing was kept there
  }
}

/** Called when the server ends this tab's session (a refresh refused with
 *  401). Returns the unsubscribe. */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => {
    signedOutListeners.delete(listener);
  };
}

function endSession(): void {
  accessToken = null;
  for (const listener of signedOutListeners) listener();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function errorCode(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { code?: unknown };
    return typeof payload.code === "string" ? payload.code : `http_${response.status}`;
  } catch {
    return `http_${response.status}`;
  }
}

/** One exchange of the refresh cookie for a new access token. */
async function exchange(): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${BASE}/auth/refresh`, { method: "POST", credentials: "same-origin" });
    } catch {
      // Offline, or the API restarting: the session may well be fine.
      return false;
    }
    if (response.ok) {
      accessToken = ((await response.json()) as SessionToken).access_token;
      return true;
    }
    if (response.status !== 401) return false;
    // Another tab exchanged the same cookie a moment ago; its new one is in
    // this browser's jar now. Once more, then it is a real refusal.
    if ((await errorCode(response)) === "refresh_superseded" && attempt === 0) {
      await sleep(250);
      continue;
    }
    endSession();
    return false;
  }
}

/** `work` holding this browser's refresh lock: two tabs never present the
 *  same refresh cookie at once (each would spend it for the other). */
async function withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return work();
  return await locks.request(REFRESH_LOCK, work);
}

let refreshing: Promise<boolean> | null = null;

/**
 * A new access token from the refresh cookie: true when there is one.
 * Concurrent callers share one request.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= withRefreshLock(exchange).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * After a 401 on a request sent with `sentWith`: whether a token worth a
 * retry is now in hand. A refresh another call already finished counts;
 * otherwise one refresh, shared by every call refused meanwhile.
 */
async function renewedAfter401(sentWith: string | null): Promise<boolean> {
  if (accessToken !== null && accessToken !== sentWith) return true;
  if (sentWith === null) return false;
  return refreshSession();
}

function authHeader(headers: Record<string, string>): string | null {
  const token = accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  return token;
}

/**
 * Sign out: the API revokes this session (the cookie's, and the bearer
 * token's) and deletes the cookies; this tab forgets the token whatever the
 * answer. `everywhere`: every session of the account, which needs the
 * server's yes (it throws, and nothing changes, if it fails).
 */
export async function signOut({ everywhere = false }: { everywhere?: boolean } = {}): Promise<void> {
  if (everywhere) {
    await request<void>("POST", "/auth/logout-all");
    accessToken = null;
    return;
  }
  try {
    const headers: Record<string, string> = {};
    authHeader(headers);
    await fetch(`${BASE}/auth/logout`, { method: "POST", headers, credentials: "same-origin" });
  } catch {
    // Offline: forgotten here all the same.
  } finally {
    accessToken = null;
  }
}

async function responseRequest(
  method: string,
  path: string,
  body?: unknown,
  retried = false,
  signal?: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {};
  // FormData sets its own Content-Type, including the multipart boundary.
  // Setting it by hand produces a body the server cannot parse.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  const sentWith = authHeader(headers);

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    signal,
  });

  if (response.status === 401 && !retried && (await renewedAfter401(sentWith))) {
    return responseRequest(method, path, body, true, signal);
  }

  if (!response.ok) {
    let code = `http_${response.status}`;
    let detail = response.statusText;
    let body: Record<string, unknown> = {};
    try {
      const payload = (await response.json()) as { code?: string; detail?: string };
      code = payload.code ?? code;
      detail = payload.detail ?? detail;
      body = payload;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(response.status, code, detail, body, retryAfterSeconds(response.headers.get("Retry-After")));
  }
  return response;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await responseRequest(method, path, body, false, signal);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>("POST", path, body, signal),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  postForm: <T>(path: string, form: FormData, signal?: AbortSignal) => request<T>("POST", path, form, signal),
  // Refresh only on an HTTP 401 before consuming a body. Never retry a
  // partially consumed speech stream, which could duplicate speech/usage.
  stream: (path: string, body: unknown, signal: AbortSignal) => responseRequest("POST", path, body, false, signal),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

/**
 * An authenticated multipart POST that reports upload progress (0..1).
 *
 * fetch cannot report upload progress, and a 15 MB photo on a phone
 * connection takes long enough that a spinner alone reads as a hang. Same
 * contract as `api.postForm`: the bearer token, one refresh-and-retry on a
 * 401, and failures as ApiError with the server's code, payload and
 * Retry-After.
 */
export function postFormWithProgress<T>(
  path: string,
  form: FormData,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal
): Promise<T> {
  const attempt = (retried: boolean): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE}${path}`);
      const sentWith = accessToken;
      if (sentWith) xhr.setRequestHeader("Authorization", `Bearer ${sentWith}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
      const abort = () => xhr.abort();
      signal?.addEventListener("abort", abort, { once: true });
      xhr.onload = () => {
        signal?.removeEventListener("abort", abort);
        if (xhr.status === 401 && !retried) {
          void renewedAfter401(sentWith).then((ok) => {
            if (!ok) {
              reject(new ApiError(401, "http_401", xhr.statusText));
              return;
            }
            onProgress(0);
            attempt(true).then(resolve, reject);
          });
          return;
        }
        let payload: Record<string, unknown> = {};
        try {
          payload = xhr.responseText ? (JSON.parse(xhr.responseText) as Record<string, unknown>) : {};
        } catch {
          // non-JSON body
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload as T);
          return;
        }
        reject(
          new ApiError(
            xhr.status,
            typeof payload.code === "string" ? payload.code : `http_${xhr.status}`,
            typeof payload.detail === "string" ? payload.detail : xhr.statusText,
            payload,
            retryAfterSeconds(xhr.getResponseHeader("Retry-After"))
          )
        );
      };
      xhr.onerror = () => {
        signal?.removeEventListener("abort", abort);
        reject(new ApiError(0, "network_error", "Upload failed"));
      };
      xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled"));
      xhr.send(form);
    });
  return attempt(false);
}

/** Raw PUT to a presigned URL via XHR, reporting upload progress 0..1. */
export function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
  contentType?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    // S3 presigned PUTs sign the Content-Type; it must match exactly
    // (.glb files often have an empty file.type, so callers override it).
    xhr.setRequestHeader("Content-Type", contentType || file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError(xhr.status, "upload_failed", xhr.responseText));
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error", "Upload failed"));
    xhr.send(file);
  });
}

/**
 * An authenticated request whose body is read as a stream (NDJSON speech).
 * The JSON client above buffers and parses; this hands the Response back
 * untouched, after the same one-shot token refresh on a 401.
 */
export async function fetchStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let sentWith: string | null = null;
  const attempt = () => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/x-ndjson" };
    sentWith = authHeader(headers);
    return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal });
  };
  let response = await attempt();
  if (response.status === 401 && (await renewedAfter401(sentWith))) response = await attempt();
  if (!response.ok) {
    let detail = response.statusText;
    let code = "http_error";
    try {
      const parsed = await response.json();
      detail = parsed.detail ?? detail;
      code = parsed.code ?? code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(response.status, code, detail);
  }
  return response;
}
