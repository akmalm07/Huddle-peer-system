/** A closed allowlist prevents accidental logging of message or key material. */
export interface SafeEvent {
  readonly name: "service_started" | "request_rejected" | "transport_closed";
  readonly statusCode?: number;
  readonly durationMs?: number;
  readonly errorCode?: string;
}

export interface SafeEventSink {
  emit(event: SafeEvent): void;
}

export interface SafeLogWriter {
  write(line: string): void;
}

/** Emits a strictly allowlisted JSON event. Callers cannot attach arbitrary objects. */
export function createSafeEventSink(writer: SafeLogWriter): SafeEventSink {
  return {
    emit(event: SafeEvent): void {
      const safe = validateEvent(event);
      writer.write(`${JSON.stringify(safe)}\n`);
    },
  };
}

function validateEvent(event: SafeEvent): SafeEvent {
  if (!allowedEventNames.has(event.name)) {
    throw new Error("SAFE_EVENT_INVALID");
  }
  if (event.statusCode !== undefined && (!Number.isInteger(event.statusCode) || event.statusCode < 100 || event.statusCode > 599)) {
    throw new Error("SAFE_EVENT_INVALID");
  }
  if (event.durationMs !== undefined && (!Number.isFinite(event.durationMs) || event.durationMs < 0 || event.durationMs > 60_000)) {
    throw new Error("SAFE_EVENT_INVALID");
  }
  if (event.errorCode !== undefined && !/^[A-Z0-9_]{1,64}$/.test(event.errorCode)) {
    throw new Error("SAFE_EVENT_INVALID");
  }
  return Object.freeze({
    ...(event.statusCode === undefined ? {} : { statusCode: event.statusCode }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    name: event.name,
  });
}

const allowedEventNames = new Set<SafeEvent["name"]>(["service_started", "request_rejected", "transport_closed"]);
