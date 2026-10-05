// Envelope contract. See kb/mcp-surface.md § Envelope.
// Same shape as a sibling project's okEnvelope / errorEnvelope.

import { ERROR_CODES } from "./error-codes.js";

const SERVER_VERSION = 1;

function meta(toolName) {
  return { tool: toolName, version: SERVER_VERSION };
}

export function ok(toolName, data) {
  return {
    ok: true,
    data: data == null ? {} : data,
    error: null,
    meta: meta(toolName),
  };
}

export function error(toolName, code, message, details) {
  if (!Object.values(ERROR_CODES).includes(code)) {
    code = ERROR_CODES.INTERNAL_ERROR;
  }
  const errObj = { code, message: message || code };
  if (details !== undefined) errObj.details = details;
  return {
    ok: false,
    data: null,
    error: errObj,
    meta: meta(toolName),
  };
}

// Server-stamped timestamp. Per spec, ts is never accepted from the caller.
export function serverTs() {
  return new Date().toISOString();
}
