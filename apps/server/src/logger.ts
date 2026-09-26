import { pino, type DestinationStream, type Logger } from "pino";
import type { Config } from "./config.js";

/**
 * Structured JSON logs via pino (Dev Plan: pino + OpenTelemetry from day one; security review #13).
 * Audit events are NEVER written here: they go to the hash-chained audit store (core-audit).
 * Anything that might carry secrets is redacted by path.
 */
export function createLogger(
  config: Pick<Config, "logLevel">,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      name: "openhoard",
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "*.password",
          "*.token",
          "*.secret",
          "*.apiKey",
          "*.headers",
          'req.headers["x-api-key"]',
          'req.headers["api-key"]',
          "database.url",
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}
