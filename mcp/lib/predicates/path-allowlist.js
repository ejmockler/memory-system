// path-allowlist.js
//
// Shared vendor/upstream path-allowlist predicate.
//
// Background (F-CROSS-PATH-ALLOWLIST, cross-source):
//   * git-log-local walks `~` with depth=3 and picks up huge upstream-only
//     clones (openwrt 252,031 rows, iTerm2 175,970 rows — 0 operator
//     commits in either). 64% of the historical ledger is upstream-only
//     clones the operator merely read.
//   * screentime captures app-usage rows on system bundles (Apple's own
//     com.apple.* notifications, 173 rows) that have no operator content.
//   * codex-cli AGENTS.md auto-injection references the same per-repo
//     paths that git-log walks, double-counting per-repo weight.
//
//   Each connector reimplemented its own skip-list. New vendor names had
//   to be added in N places.
//
// This module is the single source of truth.
//
// Critic-modified contract (per node critic_modifications, derived from
// GIT_LOG-F2 adversarial verdict):
//   * Prefer downgrade to structural_score=0.10 over DROP. Repos with 0
//     operator commits today might be fork-in-progress, study repos, or
//     a co-founder repo where the operator hasn't yet committed.
//   * Walk FULL history, not last-500. Last-500 missed a single operator
//     commit deep in a long-lived upstream-tracking repo.
//   * Cache classification per (repo, day) and re-evaluate weekly so a
//     repo that becomes operator-owned isn't pinned to "vendor" forever.
//   * Honor an operator allowlist override (READ_ONLY_REPOS env var) for
//     repos the operator KNOWS are read-only but wants emitted at a low
//     score for cross-source corroboration.
//
// ES module. No external runtime dependencies. Pure predicates.

// ---------------------------------------------------------------------------
// VENDOR_SKIP_NAMES
//
// Directory base-names that NEVER host operator-authored content.
// Matched against any segment of the path (case-sensitive — these names
// are conventional and lower-case across ecosystems). Cross-language:
//
//   JS / TS         : node_modules
//   Generic vendor  : vendor, third_party, external, submodules
//   Build / cache   : .cache, build, dist, target, __pycache__
//   Python venv     : .venv
//
// The leading-dot names (`.cache`, `.venv`) are listed explicitly so
// callers can use this set without also implementing a "skip all dot-dirs"
// rule (some dot-dirs like `.github/` DO host operator content).
// ---------------------------------------------------------------------------
export const VENDOR_SKIP_NAMES = Object.freeze(new Set([
  "node_modules",
  "vendor",
  "third_party",
  "external",
  "submodules",
  ".cache",
  "build",
  "dist",
  ".venv",
  "target",
  "__pycache__",
]));

// ---------------------------------------------------------------------------
// SYSTEM_BUNDLE_DENY_PREFIXES
//
// macOS / iOS app-bundle id prefixes that identify system-owned apps and
// services. screentime / app-usage rows whose bundle id starts with one of
// these are system noise (control center, notification center, settings,
// etc.) and carry no operator content.
//
// The list is conservative: it covers Apple-shipped system processes and
// a few well-known "always-running" daemons. User-installed apps from the
// App Store under `com.apple.*` (e.g. `com.apple.iWork.Pages`) are
// excluded by an explicit allowlist below.
// ---------------------------------------------------------------------------
export const SYSTEM_BUNDLE_DENY_PREFIXES = Object.freeze([
  "com.apple.controlcenter",
  "com.apple.notificationcenterui",
  "com.apple.dock",
  "com.apple.finder.system",
  "com.apple.systemuiserver",
  "com.apple.WindowManager",
  "com.apple.loginwindow",
  "com.apple.spotlight",
  "com.apple.coreservices",
  "com.apple.systempreferences",
  "com.apple.preference.",
  "com.apple.PowerChime",
  "com.apple.ScreenTime",
  "com.apple.universalaccessAuthWarn",
  "com.apple.weather.menu",
]);

// Allowlist: bundle ids that look "system" but are operator-facing apps.
// Anything starting with these is NOT classified as system noise even if
// it also matches a deny prefix.
const SYSTEM_BUNDLE_ALLOW_PREFIXES = Object.freeze([
  "com.apple.iWork.",       // Pages, Numbers, Keynote
  "com.apple.dt.Xcode",
  "com.apple.Safari",
  "com.apple.MobileSMS",    // Messages
  "com.apple.mail",
  "com.apple.Notes",
  "com.apple.Music",
  "com.apple.Maps",
  "com.apple.Terminal",
  "com.apple.ScriptEditor",
]);

// ---------------------------------------------------------------------------
// hasVendorSkipSegment(path)
//
// True iff any path segment matches a VENDOR_SKIP_NAMES entry. Splits on
// both `/` and `\` for cross-platform safety. Empty / non-string inputs
// return false (fail-open: an unknown path is NOT vendor-skipped).
// ---------------------------------------------------------------------------
export function hasVendorSkipSegment(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  const segments = path.split(/[\\/]/);
  for (const seg of segments) {
    if (seg.length === 0) continue;
    if (VENDOR_SKIP_NAMES.has(seg)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// isSystemBundle(bundleId)
//
// True iff `bundleId` is on the system-deny list AND not on the allow list.
// Used by the screentime connector to classify app-usage rows on Apple
// system processes.
// ---------------------------------------------------------------------------
export function isSystemBundle(bundleId) {
  if (typeof bundleId !== "string" || bundleId.length === 0) return false;
  // Allowlist wins — operator-facing Apple apps are NEVER classified as
  // system noise even if their bundle id starts with `com.apple.`.
  for (const allow of SYSTEM_BUNDLE_ALLOW_PREFIXES) {
    if (bundleId.startsWith(allow)) return false;
  }
  for (const deny of SYSTEM_BUNDLE_DENY_PREFIXES) {
    if (bundleId.startsWith(deny)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// hasOperatorContent(path, opts)
//
// The headline predicate. Connectors call this BEFORE emitting a row to
// decide whether the path likely carries operator-authored content.
//
// Returns a structured verdict:
//   {
//     operator:         bool,
//     reason:           'vendor_skip' | 'system_bundle' | 'no_operator_commits'
//                       | 'allowlist_override' | 'classified_operator' | 'unknown',
//     suggested_action: 'PASS' | 'DOWNGRADE' | 'DROP',
//     triggers:         string[],
//   }
//
// `suggested_action` follows the critic guidance:
//   * vendor_skip  -> DROP    (node_modules etc. are unambiguous noise)
//   * system_bundle -> DROP   (com.apple.dock etc. are unambiguous noise)
//   * no_operator_commits -> DOWNGRADE (score=0.10, not DROP — could be a
//                                       fork-in-progress / study repo)
//   * allowlist_override -> DOWNGRADE (operator says "low score, but keep")
//   * classified_operator -> PASS (full structural score)
//   * unknown -> PASS (fail-open)
//
// Opts:
//   {
//     hasOperatorCommits?: bool      // precomputed by the caller from full
//                                    // history (NOT last-500)
//     readOnlyAllowlist?:  string[]  // READ_ONLY_REPOS operator override
//     repoName?:           string    // base name for allowlist matching
//   }
// ---------------------------------------------------------------------------
export function hasOperatorContent(path, opts) {
  const triggers = [];
  const options = opts && typeof opts === "object" ? opts : {};

  if (typeof path !== "string" || path.length === 0) {
    return {
      operator: false,
      reason: "unknown",
      suggested_action: "PASS",
      triggers: ["invalid_path"],
    };
  }

  // Vendor-skip names — unambiguous noise.
  if (hasVendorSkipSegment(path)) {
    triggers.push("vendor_skip_segment");
    return {
      operator: false,
      reason: "vendor_skip",
      suggested_action: "DROP",
      triggers,
    };
  }

  // System-bundle prefix on the path's basename (screentime path = bundle id).
  if (isSystemBundle(path)) {
    triggers.push("system_bundle_prefix");
    return {
      operator: false,
      reason: "system_bundle",
      suggested_action: "DROP",
      triggers,
    };
  }

  // READ_ONLY_REPOS operator override — caller-supplied list of repo names
  // the operator KNOWS are read-only but wants emitted at low score for
  // cross-source corroboration.
  const allowlist = Array.isArray(options.readOnlyAllowlist)
    ? options.readOnlyAllowlist
    : [];
  const repoName = typeof options.repoName === "string" ? options.repoName : "";
  if (repoName.length > 0 && allowlist.includes(repoName)) {
    triggers.push("read_only_allowlist");
    return {
      operator: false,
      reason: "allowlist_override",
      suggested_action: "DOWNGRADE",
      triggers,
    };
  }

  // Operator-commits hint. The caller computes this from FULL history (not
  // last-500). If the caller did not supply the hint we fall through to
  // PASS (fail-open) — the connector takes the row at full score.
  if (Object.prototype.hasOwnProperty.call(options, "hasOperatorCommits")) {
    if (options.hasOperatorCommits === true) {
      triggers.push("operator_commits_present");
      return {
        operator: true,
        reason: "classified_operator",
        suggested_action: "PASS",
        triggers,
      };
    }
    // Explicitly false — repo has zero operator commits over full history.
    // DOWNGRADE not DROP (critic guidance: could be fork-in-progress).
    triggers.push("no_operator_commits");
    return {
      operator: false,
      reason: "no_operator_commits",
      suggested_action: "DOWNGRADE",
      triggers,
    };
  }

  // Fail-open: unknown path, no hint — caller takes the row at full score.
  return {
    operator: true,
    reason: "unknown",
    suggested_action: "PASS",
    triggers: ["no_classification_hint"],
  };
}

// ---------------------------------------------------------------------------
// STRUCTURAL_SCORE_DOWNGRADE
//
// The recommended structural_score for rows classified as
// `allowlist_override` or `no_operator_commits`. Centralised so the value
// stays in sync across connectors. Per critic guidance: 0.10.
// ---------------------------------------------------------------------------
export const STRUCTURAL_SCORE_DOWNGRADE = 0.10;

export default {
  VENDOR_SKIP_NAMES,
  SYSTEM_BUNDLE_DENY_PREFIXES,
  STRUCTURAL_SCORE_DOWNGRADE,
  hasVendorSkipSegment,
  isSystemBundle,
  hasOperatorContent,
};
