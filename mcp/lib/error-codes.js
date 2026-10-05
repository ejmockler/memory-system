// Error-code enum. See kb/mcp-surface.md § Error codes.

export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  NOT_FOUND: "NOT_FOUND",
  STATE_CONFLICT: "STATE_CONFLICT",
  SCOPE_BLOCKED: "SCOPE_BLOCKED",
  CONSENT_BLOCKED: "CONSENT_BLOCKED",
  PRIVILEGE_REQUIRED: "PRIVILEGE_REQUIRED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

// Thrown inside validation/handlers. Dispatch catches and converts to envelope.
export class ToolError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = "ToolError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
