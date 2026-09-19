import { createServer } from "node:http";
import { loadServiceConfig } from "@huddle/config";
import { createSafeEventSink } from "@huddle/observability";

const config = loadServiceConfig(process.env, "signaling");
const events = createSafeEventSink({ write: (line) => { process.stdout.write(line); } });

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", service: "signaling", coordination: "firebase-rtdb-required", iceServerCount: config.iceServers.length }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
  response.end('{"code":"NOT_FOUND"}');
  events.emit({ name: "request_rejected", statusCode: 404, errorCode: "NOT_FOUND" });
});

server.listen(config.port, config.bindHost, () => {
  events.emit({ name: "service_started" });
});
