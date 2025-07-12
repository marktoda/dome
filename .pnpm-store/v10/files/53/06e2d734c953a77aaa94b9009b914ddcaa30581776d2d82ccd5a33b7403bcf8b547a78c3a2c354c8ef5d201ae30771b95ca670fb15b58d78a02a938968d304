import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { PostHog } from 'posthog-node';

// src/analytics/index.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var PosthogAnalytics = class {
  sessionId;
  client;
  distinctId;
  version;
  constructor({
    version,
    apiKey,
    host = "https://app.posthog.com"
  }) {
    this.version = version;
    const cliConfigPath = path.join(__dirname, "mastra-cli.json");
    if (existsSync(cliConfigPath)) {
      try {
        const { distinctId, sessionId } = JSON.parse(readFileSync(cliConfigPath, "utf-8"));
        this.distinctId = distinctId;
        this.sessionId = sessionId;
      } catch {
        this.sessionId = randomUUID();
        this.distinctId = this.getDistinctId();
      }
      this.writeCliConfig({
        distinctId: this.distinctId,
        sessionId: this.sessionId
      });
    } else {
      this.sessionId = randomUUID();
      this.distinctId = this.getDistinctId();
      this.writeCliConfig({
        distinctId: this.distinctId,
        sessionId: this.sessionId
      });
    }
    if (this.isTelemetryEnabled()) {
      this.initializePostHog(apiKey, host);
    }
  }
  writeCliConfig({ distinctId, sessionId }) {
    try {
      writeFileSync(path.join(__dirname, "mastra-cli.json"), JSON.stringify({ distinctId, sessionId }));
    } catch {
    }
  }
  initializePostHog(apiKey, host) {
    this.client = new PostHog(apiKey, {
      host,
      flushAt: 1,
      flushInterval: 0,
      disableGeoip: false
    });
    this.captureSessionStart();
    process.on("exit", () => {
      this.client?.flush().catch(() => {
      });
    });
  }
  isTelemetryEnabled() {
    if (process.env.MASTRA_TELEMETRY_DISABLED) {
      return false;
    }
    return true;
  }
  getDistinctId() {
    const machineId = os.hostname();
    return `mastra-${machineId}`;
  }
  getSystemProperties() {
    return {
      os: process.platform,
      os_version: os.release(),
      node_version: process.version,
      platform: process.arch,
      session_id: this.sessionId,
      cli_version: this.version || "unknown",
      machine_id: os.hostname()
    };
  }
  captureSessionStart() {
    if (!this.client) {
      return;
    }
    this.client.capture({
      distinctId: this.distinctId,
      event: "cli_session_start",
      properties: {
        ...this.getSystemProperties()
      }
    });
  }
  trackCommand(options) {
    try {
      if (!this.client) {
        return;
      }
      const commandData = {
        command: options.command,
        status: options.status || "success"
      };
      if (options.args) {
        commandData.args = options.args;
      }
      if (options.durationMs) {
        commandData.durationMs = options.durationMs;
      }
      if (options.error) {
        commandData.error = options.error;
      }
      this.client.capture({
        distinctId: this.distinctId,
        event: "cli_command",
        properties: {
          ...this.getSystemProperties(),
          ...commandData,
          origin: options?.origin || "oss"
        }
      });
    } catch {
    }
  }
  // Helper method to wrap command execution with timing
  async trackCommandExecution({
    command,
    args,
    execution,
    origin
  }) {
    const startTime = process.hrtime();
    try {
      const result = await execution();
      const [seconds, nanoseconds] = process.hrtime(startTime);
      const durationMs = seconds * 1e3 + nanoseconds / 1e6;
      this.trackCommand({
        command,
        args,
        durationMs,
        status: "success",
        origin
      });
      return result;
    } catch (error) {
      const [seconds, nanoseconds] = process.hrtime(startTime);
      const durationMs = seconds * 1e3 + nanoseconds / 1e6;
      this.trackCommand({
        command,
        args,
        durationMs,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        origin
      });
      throw error;
    }
  }
  // Ensure PostHog client is shutdown properly
  async shutdown() {
    if (!this.client) {
      return;
    }
    try {
      await this.client.shutdown();
    } catch {
    }
  }
};

export { PosthogAnalytics };
