// A stand-in for production's Caddy, for smoke tests of the built images:
// /api/* goes to the API with the prefix stripped, everything else to the
// dashboard's nginx, so the browser sees one origin exactly as it does at
// avatar.mehdisadeghian.com.
//
//   node deploy/smoke/proxy.mjs <port> <dashboard-url> <api-url>
//   node deploy/smoke/proxy.mjs 7090 http://127.0.0.1:7091 http://127.0.0.1:7092
import http from "node:http";

const [port, web, api] = process.argv.slice(2);
if (!port || !web || !api) {
  console.error("usage: node proxy.mjs <port> <dashboard-url> <api-url>");
  process.exit(2);
}

http
  .createServer((req, res) => {
    const toApi = req.url === "/api" || req.url.startsWith("/api/");
    const target = new URL(toApi ? api : web);
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: toApi ? req.url.slice(4) || "/" : req.url,
        headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress, "x-forwarded-proto": "http" },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxy: ${error.message}`);
    });
    req.pipe(upstream);
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`proxy on http://127.0.0.1:${port}: /api -> ${api}, / -> ${web}`));
