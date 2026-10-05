// Evaluated before any config.js-loading import (ESM evaluates imports
// depth-first in declaration order): redirect the telemetry sink so
// dispatch-seam calls in this suite can never write to the real
// <MEMORY_ROOT>/telemetry/. See config.js TELEMETRY_BASE_DIR.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
if (!process.env.TELEMETRY_BASE_DIR) {
  process.env.TELEMETRY_BASE_DIR = mkdtempSync(join(tmpdir(), "telemetry-hermetic-"));
}
