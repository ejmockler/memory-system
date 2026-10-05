// bot-actors.js — single source of truth for bot-actor identity detection.
//
// Background (R43, cross-source): bot-actor detection had drifted across
// connectors. git-log/stage0 ran `/dependabot|renovate-bot|github-actions/i`
// against author_email; github-events/stage0 ran `/dependabot|renovate/i`
// against actor_login; codex-cli and imessage had no bot filter at all even
// though forwarded automation events occasionally surface there. Adding a
// new bot identity (e.g. claude[bot], gpt-engineer-app[bot]) required
// hunting every connector for the right substring and the right anchor —
// which meant new bots were silently missed in N-1 sources.
//
// This module exposes:
//   * BOT_ACTOR_REGEX — one anchored regex covering every known bot login
//   * BOT_SUFFIX_REGEX — the generic `[bot]@` email-suffix marker
//   * isBotActor(input) — boolean predicate accepting either a bare login
//                         (e.g. "dependabot[bot]") or a full email
//                         (e.g. "dependabot[bot]@users.noreply.github.com").
//
// Anchoring discipline (R43 critic concern):
//   The named-bot regex is anchored at `^` and either end-of-string or `@`
//   so that human usernames containing `bot` as a substring DO NOT match.
//   Counter-examples that MUST fail isBotActor():
//     * "robotics-fan"
//     * "robotics-fan@example.com"
//     * "bottom"
//     * "bottom@example.com"
//     * "bots-r-us"
//   Whereas the canonical bot logins MUST match:
//     * dependabot, dependabot[bot], dependabot[bot]@users.noreply.github.com
//     * renovate, renovate[bot], renovate-bot@…  (the older Renovate email)
//     * github-actions, github-actions[bot], github-actions[bot]@…
//     * copilot, copilot[bot], copilot[bot]@…
//     * web-flow, web-flow@…   (GitHub's web-UI commit signer)
//     * pr-bot, pr-bot@…
//     * claude[bot], claude[bot]@…
//     * gpt-engineer-app[bot], gpt-engineer-app[bot]@…
//
// Generic `[bot]@` suffix:
//   Any GitHub bot account has a noreply email of the form
//   `<name>[bot]@users.noreply.github.com`. The literal `[bot]@` substring
//   is the safe generic marker — it cannot appear in a human handle because
//   `[` and `]` are illegal in real GitHub logins. BOT_SUFFIX_REGEX catches
//   future bots not yet enumerated in the named list.
//
// Consumers:
//   * mcp/lib/ingest/stage0/gitlog.js  — author_email check
//   * mcp/lib/ingest/stage0/githubevents.js — actor_login check
//   * mcp/lib/connectors/codex-cli.js  — agent-identity guard
//   * mcp/lib/connectors/imessage.js   — forwarded-automation guard
//
// ES module. No external dependencies.

// ---------------------------------------------------------------------------
// Named-bot regex.
//
// Each alternative either stands alone OR carries the optional `[bot]`
// suffix. The whole match is anchored at `^` and terminated by either
// end-of-string or `@` (the email separator). The trailing `(@.*)?$` swallows
// the noreply-domain tail when present. Case-insensitive.
//
// IMPORTANT: keep the alternatives in this exact form. `[bot]` MUST be
// escaped as `\[bot\]` inside the regex source. A bare `[bot]` would be a
// character class matching `b`, `o`, or `t`.
// ---------------------------------------------------------------------------
export const BOT_ACTOR_REGEX = /^(dependabot(\[bot\])?|renovate(\[bot\])?|renovate-bot|github-actions(\[bot\])?|copilot(\[bot\])?|web-flow|pr-bot|claude\[bot\]|gpt-engineer-app\[bot\])(@.*)?$/i;

// ---------------------------------------------------------------------------
// Generic `[bot]@` suffix marker.
//
// Matches anywhere in the string (not anchored) because the meaningful
// signal is the literal `[bot]@` — a sequence that cannot occur in a human
// GitHub login or email-localpart (GitHub disallows `[` and `]` in
// usernames). This is the safety net for bots not yet enumerated above.
// ---------------------------------------------------------------------------
export const BOT_SUFFIX_REGEX = /\[bot\]@/i;

// ---------------------------------------------------------------------------
// isBotActor(input)
//
// Returns true iff the input string identifies a bot actor. Accepts both:
//   * bare login    e.g. "dependabot[bot]"
//   * full email    e.g. "dependabot[bot]@users.noreply.github.com"
//   * legacy email  e.g. "29139614+renovate-bot@users.noreply.github.com"
//
// The legacy case is handled by also testing the email's localpart on its
// own (the chunk before `@`) and by stripping any leading `<digits>+`
// prefix that GitHub prepends to noreply emails when the user opts in to
// commit-email privacy. Without that strip, `29139614+renovate-bot@…` would
// fail the anchor.
//
// Non-string inputs return false (defensive — callers occasionally pass
// `undefined` from a missing field).
// ---------------------------------------------------------------------------
export function isBotActor(input) {
  if (typeof input !== "string" || input.length === 0) return false;

  // Test the full input first (covers bare login + canonical bot email).
  if (BOT_ACTOR_REGEX.test(input)) return true;

  // Generic `[bot]@` suffix marker — catches future bots not enumerated above.
  if (BOT_SUFFIX_REGEX.test(input)) return true;

  // Email forms: extract localpart, strip GitHub's `<digits>+` privacy prefix,
  // and retest. This handles the legacy `29139614+renovate-bot@…` shape.
  const atIdx = input.indexOf("@");
  if (atIdx > 0) {
    const localpart = input.slice(0, atIdx);
    if (BOT_ACTOR_REGEX.test(localpart)) return true;

    const plusIdx = localpart.indexOf("+");
    if (plusIdx >= 0 && /^\d+$/.test(localpart.slice(0, plusIdx))) {
      const stripped = localpart.slice(plusIdx + 1);
      if (BOT_ACTOR_REGEX.test(stripped)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// KNOWN_BOT_IDENTITIES — exported for tests and documentation. Each entry
// is a representative login or email that MUST be classified as a bot. Used
// by the cross-connector regression test to assert parity.
// ---------------------------------------------------------------------------
export const KNOWN_BOT_IDENTITIES = Object.freeze([
  "dependabot",
  "dependabot[bot]",
  "dependabot[bot]@users.noreply.github.com",
  "renovate",
  "renovate[bot]",
  "renovate-bot",
  "29139614+renovate-bot@users.noreply.github.com",
  "github-actions",
  "github-actions[bot]",
  "github-actions[bot]@users.noreply.github.com",
  "copilot",
  "copilot[bot]",
  "copilot[bot]@users.noreply.github.com",
  "web-flow",
  "web-flow@noreply.github.com",
  "pr-bot",
  "pr-bot@users.noreply.github.com",
  "claude[bot]",
  "claude[bot]@users.noreply.github.com",
  "gpt-engineer-app[bot]",
  "gpt-engineer-app[bot]@users.noreply.github.com",
]);

// ---------------------------------------------------------------------------
// KNOWN_HUMAN_IDENTITIES — counter-examples that MUST NOT match. Exported
// for the same regression test. Adding a human identity that the regex
// accidentally matches here will fail the test and force a regex fix.
// ---------------------------------------------------------------------------
export const KNOWN_HUMAN_IDENTITIES = Object.freeze([
  "robotics-fan",
  "robotics-fan@example.com",
  "bottom",
  "bottom@example.com",
  "bots-r-us",
  "alex",
  "alex@example.com",
  "alex.example@example.org",
  "actions@github.com",   // NOT github-actions; this is a real human-style address
]);
