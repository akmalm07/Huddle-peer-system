import assert from "node:assert/strict";
import test from "node:test";
import { createSafeEventSink } from "./index.js";

test("emits only the allowlisted structured event fields", () => {
  const lines: string[] = [];
  const sink = createSafeEventSink({ write: (line) => lines.push(line) });
  sink.emit({ name: "request_rejected", statusCode: 400, errorCode: "PAYLOAD_TOO_LARGE" });
  assert.equal(lines[0], '{"statusCode":400,"errorCode":"PAYLOAD_TOO_LARGE","name":"request_rejected"}\n');
});

test("rejects malformed event fields instead of serializing arbitrary data", () => {
  const sink = createSafeEventSink({ write: () => undefined });
  assert.throws(() => sink.emit({ name: "request_rejected", errorCode: "message body leaked" }));
});
