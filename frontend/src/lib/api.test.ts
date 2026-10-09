/**
 * The session in the API client: `npm test` (node --test), with `fetch`
 * answered from a table here and a Map standing in for localStorage.
 *
 * The access token lives in memory only; the refresh token is an httpOnly
 * cookie this code never sees (the browser sends it to /api/auth/*).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  api,
  ApiError,
  fetchStream,
  forgetLegacyTokens,
  getAccessToken,
  hasSessionHint,
  onSignedOut,
  refreshSession,
  setAccessToken,
  signOut,
} from "./api.ts";

const store = new Map<string, string>();
let writes = 0;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes++;
      store.set(key, value);
    },
    removeItem: (key: string) => void store.delete(key),
  },
});

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  credentials: RequestCredentials | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;
let handler: Handler = () => json(404, { code: "not_mocked" });
let calls: Call[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  const call: Call = {
    url: String(input),
    method: init.method ?? "GET",
    authorization: headers.get("Authorization"),
    credentials: init.credentials,
  };
  calls.push(call);
  return handler(call);
}) as typeof fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const session = (token: string) => json(200, { access_token: token, token_type: "bearer", expires_in: 900 });
const refreshes = () => calls.filter((call) => call.url === "/api/auth/refresh");

/** A promise and the function that settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  store.clear();
  writes = 0;
  calls = [];
  setAccessToken(null);
  handler = () => json(404, { code: "not_mocked" });
});

describe("the access token", () => {
  it("is kept in memory and sent as a bearer header, never written to storage", async () => {
    setAccessToken("t1");
    handler = () => json(200, { ok: true });
    assert.deepEqual(await api.get("/orgs"), { ok: true });
    assert.equal(calls[0].authorization, "Bearer t1");
    assert.equal(getAccessToken(), "t1");
    assert.equal(writes, 0);
  });

  it("an older release's tokens in localStorage are removed", () => {
    store.set("liveface.tokens", '{"access_token":"a","refresh_token":"r"}');
    store.set("liveface.theme", "dark");
    forgetLegacyTokens();
    assert.equal(store.has("liveface.tokens"), false);
    assert.equal(store.get("liveface.theme"), "dark");
  });

  it("whether a session can be restored is the lf_session cookie's to say", () => {
    assert.equal(hasSessionHint(), false, "no document: no hint");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "a=b; lf_session=1" } });
    try {
      assert.equal(hasSessionHint(), true);
      (globalThis as { document: { cookie: string } }).document.cookie = "a=b";
      assert.equal(hasSessionHint(), false);
    } finally {
      Reflect.deleteProperty(globalThis, "document");
    }
  });
});

describe("a refused access token", () => {
  it("concurrent 401s make ONE refresh, and every call is retried with the new token", async () => {
    setAccessToken("old");
    handler = (call) => {
      if (call.url === "/api/auth/refresh") return session("new");
      return call.authorization === "Bearer new" ? json(200, { url: call.url }) : json(401, { code: "invalid_token" });
    };
    const answers = await Promise.all(["/a", "/b", "/c", "/d", "/e"].map((path) => api.get<{ url: string }>(path)));
    assert.deepEqual(
      answers.map((answer) => answer.url),
      ["/api/a", "/api/b", "/api/c", "/api/d", "/api/e"]
    );
    assert.equal(refreshes().length, 1);
    assert.equal(refreshes()[0].credentials, "same-origin", "the refresh cookie goes with it");
    assert.equal(refreshes()[0].authorization, null, "the cookie is the credential, not a token");
    assert.equal(getAccessToken(), "new");
    assert.equal(writes, 0);
  });

  it("a 401 answered after another call refreshed is retried without refreshing again", async () => {
    setAccessToken("old");
    const late = deferred<Response>();
    handler = (call) => {
      if (call.url === "/api/auth/refresh") return session("new");
      if (call.authorization === "Bearer new") return json(200, { ok: call.url });
      return call.url === "/api/slow" ? late.promise : json(401, { code: "invalid_token" });
    };
    const slow = api.get("/slow"); // sent with "old", answered later
    await api.get("/fast"); // refused, refreshed, retried
    late.resolve(json(401, { code: "invalid_token" }));
    assert.deepEqual(await slow, { ok: "/api/slow" });
    assert.equal(refreshes().length, 1);
  });

  it("a refused refresh signs this tab out: listeners told, token forgotten, the call fails", async () => {
    setAccessToken("old");
    let told = 0;
    const stop = onSignedOut(() => told++);
    handler = (call) =>
      call.url === "/api/auth/refresh"
        ? json(401, { code: "session_revoked" })
        : json(401, { code: "session_revoked" });
    await assert.rejects(
      Promise.all([api.get("/a"), api.get("/b")]),
      (error: unknown) => error instanceof ApiError && error.status === 401
    );
    stop();
    assert.equal(told, 1);
    assert.equal(refreshes().length, 1);
    assert.equal(getAccessToken(), null);
  });

  it("another tab's refresh a moment earlier (refresh_superseded) is tried once more", async () => {
    setAccessToken("old");
    let refreshed = 0;
    handler = (call) => {
      if (call.url === "/api/auth/refresh")
        return ++refreshed === 1 ? json(401, { code: "refresh_superseded" }) : session("new");
      return call.authorization === "Bearer new" ? json(200, {}) : json(401, { code: "invalid_token" });
    };
    let told = 0;
    const stop = onSignedOut(() => told++);
    await api.get("/a");
    stop();
    assert.equal(refreshed, 2);
    assert.equal(told, 0);
    assert.equal(getAccessToken(), "new");
  });

  it("a refresh that fails on the network or a 5xx does not sign out", async () => {
    for (const failing of [() => Promise.reject(new TypeError("offline")), () => json(502, {})]) {
      setAccessToken("old");
      let told = 0;
      const stop = onSignedOut(() => told++);
      handler = (call) =>
        call.url === "/api/auth/refresh" ? (failing() as Promise<Response>) : json(401, { code: "invalid_token" });
      await assert.rejects(api.get("/a"));
      stop();
      assert.equal(told, 0);
      assert.equal(getAccessToken(), "old");
    }
  });

  it("signed out, a 401 is just a 401: there is nothing to refresh", async () => {
    handler = () => json(401, { code: "missing_token" });
    await assert.rejects(api.get("/auth/me"), (error: unknown) => error instanceof ApiError && error.status === 401);
    assert.equal(refreshes().length, 0);
  });

  it("the speech stream refreshes and retries the same way", async () => {
    setAccessToken("old");
    handler = (call) => {
      if (call.url === "/api/auth/refresh") return session("new");
      return call.authorization === "Bearer new" ? new Response("{}\n") : json(401, { code: "invalid_token" });
    };
    const response = await fetchStream("/orgs/o/tts/stream", { text: "hi" });
    assert.equal(response.status, 200);
    assert.equal(refreshes().length, 1);
  });
});

describe("refreshSession", () => {
  it("callers at once share one request", async () => {
    handler = () => session("fresh");
    const results = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    assert.deepEqual(results, [true, true, true]);
    assert.equal(refreshes().length, 1);
    assert.equal(getAccessToken(), "fresh");
  });
});

describe("signing out", () => {
  it("asks the API to end the session and forgets the token, whatever it answers", async () => {
    for (const answer of [() => new Response(null, { status: 204 }), () => Promise.reject(new TypeError("offline"))]) {
      calls = [];
      setAccessToken("t1");
      handler = () => answer() as Promise<Response>;
      await signOut();
      assert.equal(calls[0].url, "/api/auth/logout");
      assert.equal(calls[0].method, "POST");
      assert.equal(calls[0].authorization, "Bearer t1");
      assert.equal(calls[0].credentials, "same-origin");
      assert.equal(getAccessToken(), null);
    }
  });

  it("everywhere: POST /auth/logout-all with the bearer token, and a refusal changes nothing", async () => {
    setAccessToken("t1");
    handler = () => json(503, { code: "service_unavailable" });
    await assert.rejects(signOut({ everywhere: true }));
    assert.equal(getAccessToken(), "t1");

    handler = () => new Response(null, { status: 204 });
    await signOut({ everywhere: true });
    const last = calls.at(-1)!;
    assert.equal(last.url, "/api/auth/logout-all");
    assert.equal(last.authorization, "Bearer t1");
    assert.equal(getAccessToken(), null);
    assert.equal(writes, 0);
  });
});
