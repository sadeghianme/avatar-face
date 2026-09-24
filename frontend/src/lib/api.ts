/**
 * Typed fetch client. All errors are ApiError {status, code, detail}.
 * On a 401 it transparently refreshes the access token ONCE and retries.
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
    /** The whole error payload, for the few errors that carry more than a
     *  sentence (a refused fit lists its reasons). */
    public body: Record<string, unknown> = {},
    /** Seconds the server asked us to wait (Retry-After on a 429 or 503),
     *  so "busy, try again" can say when. Null when it did not say. */
    public retryAfter: number | null = null
  ) {
    super(detail);
  }
}

/** Retry-After as seconds; the HTTP-date form is not used by this API. */
function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
}

const STORAGE_KEY = "liveface.tokens";

export function getTokens(): Tokens | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Tokens) : null;
}

export function setTokens(tokens: Tokens | null): void {
  if (tokens) localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  else localStorage.removeItem(STORAGE_KEY);
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  // Coalesce concurrent 401s into one refresh request.
  refreshing ??= (async () => {
    const tokens = getTokens();
    if (!tokens) return false;
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
      });
      if (!response.ok) {
        setTokens(null);
        return false;
      }
      setTokens((await response.json()) as Tokens);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function responseRequest(
  method: string,
  path: string,
  body?: unknown,
  retried = false,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {};
  // FormData sets its own Content-Type, including the multipart boundary.
  // Setting it by hand produces a body the server cannot parse.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  const tokens = getTokens();
  if (tokens) headers.Authorization = `Bearer ${tokens.access_token}`;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    signal,
  });

  if (response.status === 401 && !retried && tokens) {
    if (await tryRefresh()) return responseRequest(method, path, body, true, signal);
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
    throw new ApiError(
      response.status, code, detail, body, retryAfterSeconds(response.headers.get("Retry-After"))
    );
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
      const tokens = getTokens();
      if (tokens) xhr.setRequestHeader("Authorization", `Bearer ${tokens.access_token}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
      const abort = () => xhr.abort();
      signal?.addEventListener("abort", abort, { once: true });
      xhr.onload = () => {
        signal?.removeEventListener("abort", abort);
        if (xhr.status === 401 && !retried && tokens) {
          void tryRefresh().then((ok) => {
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
  const attempt = () => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/x-ndjson" };
    const tokens = getTokens();
    if (tokens) headers.Authorization = `Bearer ${tokens.access_token}`;
    return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal });
  };
  let response = await attempt();
  if (response.status === 401 && (await tryRefresh())) response = await attempt();
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
