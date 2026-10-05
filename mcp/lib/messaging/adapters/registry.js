// adapters/registry.js — the ADAPTER BARREL (L1 wiring).
//
// This is the ONE place that names the concrete per-platform adapter modules.
// It belongs to the ADAPTER LAYER — where platform identity legitimately lives
// (each adapter file is named for, and knows, its own platform). It exports an
// OPAQUE list of adapter modules; nothing here branches on a platform name, it
// merely assembles the modules so a downstream consumer (the L5 catch-up surface)
// can loop them GENERICALLY without ever importing a platform-named file itself.
//
// Why this file exists separately from catchup.js:
//   The abstraction invariant requires the L5 surface to carry ZERO platform
//   tokens — including in `import` paths. Concentrating the platform-named
//   imports HERE keeps catchup.js token-free (it imports this barrel as data),
//   so the N10 grep gate over catchup.js returns 0 while the registry stays a
//   single, auditable wiring point. Adding a platform is ONE import + ONE array
//   entry HERE; catchup.js never changes.
//
// Each adapter module exposes a `PLATFORM` string constant (its self-declared id)
// and a pure `_toEnvelope(row) -> Envelope` mapper (some also alias `toEnvelope`
// / default). The consumer reads those off the module by capability, never by a
// platform literal.

import * as whatsapp from "./whatsapp.js";
import * as imessage from "./imessage.js";
import * as mail from "./mail.js";
import * as telegram from "./telegram.js";

/**
 * ADAPTER_MODULES — the opaque, ordered list of L1 adapter modules. The order is
 * deterministic (registry construction keeps first-wins per platform). A consumer
 * keys a registry on each module's own `PLATFORM`.
 */
export const ADAPTER_MODULES = Object.freeze([
  whatsapp,
  imessage,
  mail,
  telegram,
]);

export default ADAPTER_MODULES;
