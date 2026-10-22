import { defineConfig } from "vitest/config";

// Reap and count the detached heartbeat-loop processes this suite's hooks spawn.
export default defineConfig({ test: { globalSetup: ["../claude-code/test/heartbeat-guard.ts"] } });
