/**
 * The API, mocked at the network: `fetch` and `XMLHttpRequest` answered
 * from a table of routes, so a screen test runs the real client
 * (lib/api: tokens, errors, the 401 refresh), the feature's data module
 * and React Query's cache, and only the server is pretend.
 *
 *   server.on("GET", "/orgs/:org/avatars", () => [avatar]);
 *   server.on("POST", "/orgs/:org/avatars/:id/publish", () => apiError(409, "nothing_to_publish"));
 *
 * Paths are the API's (the client's "/api" prefix is dropped). The route
 * registered last wins, so a test overrides a default by adding its own.
 * A handler returns a Response, or a value sent as JSON (undefined: 204).
 * An unmocked request answers 404 `not_mocked` and is listed in
 * `server.unhandled`.
 */
import { vi } from "vitest";

export interface MockRequest {
  method: string;
  /** The API path, without "/api" and the query. */
  path: string;
  url: URL;
  /** JSON parsed; a FormData as it was sent; undefined without a body. */
  body: unknown;
  headers: Headers;
}

type Reply = Response | unknown;
type Handler = (request: MockRequest, params: Record<string, string>) => Reply | Promise<Reply>;

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  once: boolean;
  used: boolean;
}

/** A JSON answer. */
export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

/** A refusal in the API's envelope: `{detail, code, ...extra}`. */
export function apiError(
  status: number,
  code: string,
  detail = code,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Response {
  return json({ detail, code, ...extra }, { status, headers });
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        keys.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}$`), keys };
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body ?? undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function createServer() {
  const routes: Route[] = [];
  const calls: MockRequest[] = [];
  const unhandled: string[] = [];

  const make = (method: string, pattern: string, handler: Handler, once: boolean): Route => ({
    method: method.toUpperCase(),
    pattern,
    ...compile(pattern),
    handler,
    once,
    used: false,
  });
  const add = (method: string, pattern: string, handler: Handler, once: boolean) => {
    routes.push(make(method, pattern, handler, once));
  };

  async function respond(method: string, input: string, body: unknown, headers: Headers): Promise<Response> {
    const url = new URL(input, "http://localhost");
    const path = url.pathname.startsWith("/api/") ? url.pathname.slice(4) : url.pathname;
    const request: MockRequest = { method: method.toUpperCase(), path, url, body: parseBody(body), headers };
    calls.push(request);
    for (let i = routes.length - 1; i >= 0; i--) {
      const route = routes[i];
      if (route.method !== request.method || (route.once && route.used)) continue;
      const match = route.regex.exec(path);
      if (!match) continue;
      route.used = true;
      const params = Object.fromEntries(route.keys.map((key, n) => [key, decodeURIComponent(match[n + 1])]));
      const reply = await route.handler(request, params);
      if (reply instanceof Response) return reply;
      if (reply === undefined) return new Response(null, { status: 204 });
      return json(reply);
    }
    unhandled.push(`${request.method} ${path}`);
    return apiError(404, "not_mocked", `${request.method} ${path} is not mocked`);
  }

  /** XMLHttpRequest, answered from the same table (uploads with progress). */
  class FakeXHR {
    status = 0;
    statusText = "";
    responseText = "";
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private method = "GET";
    private url = "";
    private headers = new Headers();
    private responseHeaders = new Headers();
    private aborted = false;

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers.set(name, value);
    }
    getResponseHeader(name: string) {
      return this.responseHeaders.get(name);
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    send(body?: unknown) {
      void respond(this.method, this.url, body, this.headers).then(async (response) => {
        if (this.aborted) return;
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent);
        this.status = response.status;
        this.statusText = response.statusText;
        this.responseHeaders = response.headers;
        this.responseText = await response.text();
        this.onload?.();
      });
    }
  }

  return {
    /** Every request made, in order. */
    calls,
    /** Requests no route answered ("METHOD /path"). */
    unhandled,
    on(method: string, pattern: string, handler: Handler) {
      add(method, pattern, handler, false);
      return this;
    },
    /** Answers the next matching request only. */
    once(method: string, pattern: string, handler: Handler) {
      add(method, pattern, handler, true);
      return this;
    },
    /** A default: any route added with `on` or `once` wins over it. */
    fallback(method: string, pattern: string, handler: Handler) {
      routes.unshift(make(method, pattern, handler, false));
      return this;
    },
    /** The requests made to one route, e.g. requests("POST", "/orgs/:org/avatars/:id/publish"). */
    requests(method: string, pattern: string): MockRequest[] {
      const { regex } = compile(pattern);
      return calls.filter((call) => call.method === method.toUpperCase() && regex.test(call.path));
    },
    install() {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const signal = init.signal;
          if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
          return respond(init.method ?? "GET", url, init.body, new Headers(init.headers));
        })
      );
      vi.stubGlobal("XMLHttpRequest", FakeXHR);
    },
  };
}

export type MockServer = ReturnType<typeof createServer>;
