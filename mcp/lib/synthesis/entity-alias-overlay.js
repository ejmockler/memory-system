// Read-side entity alias overlay for the operator's identity surfaces.
//
// Historical entity canonical_ids are extractor artifacts and therefore stay
// immutable. This module only projects matching person slugs to the stable
// read-side key `person:operator`; it never writes ledger rows or index data.

import { getOperatorIdentities } from "../identity/operator-identity.js";
import {
  SLUG_EMPTY_SENTINEL,
  slugify,
} from "./entity-extractor.js";

export const OPERATOR_ENTITY_ALIAS = "person:operator";

const RESERVED_ROLE_SLUGS = Object.freeze(new Set([
  "user",
  "assistant",
  "system",
]));

function aliasOverlayEnabled() {
  return process.env.MEMORY_ENTITY_ALIAS_OVERLAY === "1";
}

/**
 * Build the reversible, in-memory operator alias projection.
 *
 * Keys are slugs rather than canonical_ids because canonical_ids retain their
 * extractor source (`person:<source>:<slug>`). Matching only the final slug is
 * the forward axis: raw operator surfaces are slugified with the extractor's
 * canonical pipeline, never reverse-normalized from historical ids.
 *
 * @returns {Map<string, "person:operator">}
 */
export function buildAliasOverlay() {
  const overlay = new Map();
  const identities = getOperatorIdentities();

  for (const surfaces of Object.values(identities)) {
    if (!Array.isArray(surfaces)) continue;
    for (const surface of surfaces) {
      if (typeof surface !== "string") continue;
      const slug = slugify(surface);
      if (
        slug === SLUG_EMPTY_SENTINEL ||
        RESERVED_ROLE_SLUGS.has(slug)
      ) {
        continue;
      }
      overlay.set(slug, OPERATOR_ENTITY_ALIAS);
    }
  }

  return overlay;
}

/**
 * Resolve one immutable extractor canonical_id through the read-side overlay.
 *
 * Flag-off returns the exact input string without parsing or consulting the
 * overlay. Flag-on requires the hand-off to be a Map, so enabled-but-miswired
 * callers fail loudly rather than silently retaining split identities.
 *
 * @param {*} id
 * @param {Map<string, "person:operator">} overlay
 * @returns {*} the original value, or `person:operator` for an aliased person
 */
export function resolveAlias(id, overlay) {
  if (!aliasOverlayEnabled()) return id;

  if (!(overlay instanceof Map)) {
    throw new TypeError(
      "resolveAlias: MEMORY_ENTITY_ALIAS_OVERLAY=1 requires a Map overlay",
    );
  }
  if (typeof id !== "string") return id;

  // Exactly the extractor shape `person:<source>:<slug>`. The fixed operator
  // key itself has only two segments and therefore remains unchanged.
  const match = /^person:[^:]+:([a-z0-9]+(?:_[a-z0-9]+)*)$/.exec(id);
  if (!match) return id;

  const slug = match[1];
  if (RESERVED_ROLE_SLUGS.has(slug)) return id;

  return overlay.get(slug) === OPERATOR_ENTITY_ALIAS
    ? OPERATOR_ENTITY_ALIAS
    : id;
}
