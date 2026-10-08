// The Simulator's side of the customer's page (src/features/simulator/
// snippet.ts, buildDocument). It is loaded first in that page, before the
// widget's own tag. It tells the Simulator what the widget does, and it
// passes Speak and Stop on to the widget.
//
// The page runs in a sandboxed frame WITHOUT allow-same-origin. Its origin
// is opaque, so it cannot read the dashboard's storage, and the dashboard
// cannot reach into it. Everything goes by postMessage:
//  - to the Simulator: addressed to the dashboard's origin, which is this
//    script's own origin, never to "*";
//  - from the Simulator: only messages from the parent window, sent from
//    that origin, are acted on.
// It is a file and not an inline script. The page inherits the dashboard's
// CSP, which allows scripts from the dashboard's origin only.
(() => {
  const dashboard = new URL(document.currentScript.src).origin;
  const send = (level, message) => parent.postMessage({ lf: true, level, message: String(message) }, dashboard);

  // A script's own error (an ErrorEvent), and a script that did not load (an
  // error event on its <script>, which only a capturing listener sees).
  window.addEventListener(
    "error",
    (event) => {
      if (event.target instanceof HTMLScriptElement) send("error", `script failed to load: ${event.target.src}`);
      else if (event instanceof ErrorEvent) send("error", event.message || "script error");
    },
    true
  );
  window.addEventListener("unhandledrejection", (event) => send("error", `unhandled: ${event.reason}`));
  // The widget reports its own failures through console.error. Forward them
  // so a bad key or a missing avatar shows up in the log, and not only in
  // devtools, which is the whole point of running it here.
  const realError = console.error;
  console.error = (...args) => {
    send("error", args.map(String).join(" "));
    realError.apply(console, args);
  };

  // The widget's own word on the avatar (embed/src/widget/handles.ts and
  // widget/failure.ts): both events bubble from its canvas. A failure is
  // otherwise only a console warning and a note under the canvas.
  document.addEventListener("liveface:ready", () => send("ok", "avatar ready"));
  document.addEventListener("liveface:error", (event) => {
    const detail = event.detail || {};
    send("error", `avatar failed (${detail.stage}): ${detail.message}`);
  });

  let tries = 0;
  const poll = setInterval(() => {
    if (window.Liveface) {
      clearInterval(poll);
      send("ok", "widget loaded — window.Liveface is available");
      const canvas = document.querySelector("canvas");
      send(
        canvas ? "ok" : "error",
        canvas ? `canvas mounted (${canvas.width}x${canvas.height})` : "no canvas was mounted"
      );
    } else if (++tries > 100) {
      clearInterval(poll);
      send("error", "timed out after 10s — window.Liveface never appeared");
    }
  }, 100);

  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== dashboard) return;
    const data = event.data;
    if (!data || !window.Liveface) return;
    if (typeof data.speak === "string") {
      send("info", `speak(${JSON.stringify(data.speak)})`);
      Promise.resolve(window.Liveface.speak(data.speak))
        .then(() => send("ok", "finished speaking"))
        .catch((error) => send("error", `speak failed: ${error}`));
    }
    if (data.stop === true) window.Liveface.stop();
  });
})();
