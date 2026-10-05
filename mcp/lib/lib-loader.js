// lib-loader.js — R25.6 structural defense against the export-vs-lookup
// bug class.
//
// History: R25 shipped 3 CRIT-1 bugs of the form "caller looks for
// `mod.X` but the providing module exports `Y`". R25.5 fixed those 3 but
// shipped a 4th of the same shape (stage0/index.js: caller wanted
// `dispatch`, provider exported `stage0Dispatch`). Each instance is a
// SILENT-fallthrough because the call sites all use defensive
// `typeof mod.X === "function"` guards — when the lookup misses, the
// guard is falsy and the entire layer is skipped without an error.
//
// Defense: a tiny helper that performs the dynamic import AND verifies
// the expected named exports are present, throwing a clear error at
// load-time if any are missing. Converts the next instance of this bug
// class from CRITICAL silent-fallthrough into LOW boot-time throw.
//
// Usage:
//   const mod = await loadModule(
//     new URL("./stage0/index.js", import.meta.url).href,
//     ["dispatch", "stage0Dispatch"]);
//   mod.dispatch(...);
//
// IMPORTANT: dynamic `import()` resolves relative to *this* module
// (lib-loader.js), NOT to the caller. Callers MUST pass an absolute
// URL/path (e.g. `new URL("./sibling.js", import.meta.url).href` from
// the caller's source). Bare specifiers and absolute file paths also
// work; relative paths will resolve from lib-loader.js's directory and
// will almost certainly miss.
//
// `expectedExports` is a list of names. If any name is missing or its
// value is `undefined`, loadModule throws Error("module 'specifier'
// missing expected export(s): a, b, c"). Callers MAY treat any throw as
// fatal at boot.
//
// Hermeticity: this module has no I/O, no side-effects beyond the
// dynamic import, and does not cache. Callers that want caching wrap it.

export async function loadModule(specifier, expectedExports) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    throw new TypeError("loadModule: specifier must be a non-empty string");
  }
  if (!Array.isArray(expectedExports) || expectedExports.length === 0) {
    throw new TypeError(
      "loadModule: expectedExports must be a non-empty string array",
    );
  }
  for (const name of expectedExports) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(
        "loadModule: every expectedExports entry must be a non-empty string",
      );
    }
  }
  const mod = await import(specifier);
  const missing = [];
  for (const name of expectedExports) {
    if (mod[name] === undefined) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `loadModule: module '${specifier}' missing expected export(s): ${missing.join(", ")}`,
    );
  }
  return mod;
}
