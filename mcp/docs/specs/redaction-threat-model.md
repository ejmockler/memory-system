# Redaction Threat Model Specification

**Node:** F-META-REDACTION-THREAT-MODEL
**Status:** SPEC — pending implementation
**Severity:** major
**Owner:** memory-system core (security)

---

## Problem

The redaction layer (`mcp/lib/redaction/predicates.js`) enumerates the
key-shape regexes `KEY_SHAPE_RX_FULL` and runs them at the source-ledger
emit boundary. There is no threat model: no documented adversary, no
asset enumeration, no maintenance cadence, no drift detection. The
audit treats redaction as a one-time fix. In practice it is an ongoing
surveillance task — every provider that adds a new key format introduces
a fresh leak path.

Concrete failure mode: when (not if) OpenAI, GitHub, Anthropic, or GCP
introduce a new key prefix, `KEY_SHAPE_RX_FULL` doesn't match, the key
flows through Stage-0 into the source ledger, and a downstream consumer
(backup, distillation, recall index) carries the secret into a less-
trusted surface.

## Goal

Establish:
1. An adversary model and asset enumeration that scopes the redaction
   layer.
2. A monthly maintenance cadence for `KEY_SHAPE_RX_FULL` keyed against
   each provider's documented key formats.
3. A CI fixture corpus of known key formats that breaks the build when a
   new format ships without a matching regex.
4. A drift-detection mechanism that samples novel high-entropy strings
   in production and flags them for human review.

## Adversary model

Three adversaries in scope:

### A1: Operator-machine compromise

Adversary has read access to `<data root>/storage/`. This is the
worst case: backup theft, malware on the user machine, lost laptop.
The redaction layer is the LAST line of defense; once a secret is in the
on-disk ledger, A1 reads it.

Mitigation: source-ledger files are 0600, parent dirs are 0700. But the
filesystem permissions are bypassed by anyone with `sudo` or physical
access. Redaction-at-emit is the mitigation we control.

### A2: Backup / cloud-sync leak

Adversary has read access to a downstream copy of the storage tree —
Time Machine, iCloud, Backblaze, a thumb drive backup. Same as A1 with
an additional time-axis: the ledger from N months ago surfaces, and
redaction at THAT time's regex set is what's preserved.

Mitigation: redaction is RUN-AT-EMIT, not run-at-read. We cannot fix
historical leaks via a new regex; we can only prevent future leaks.
This drives the monthly maintenance cadence below.

### A3: Downstream-consumer compromise

The distillation pipeline, the recall index, the embedder API call, all
read the redacted source ledger and ship its contents to less-trusted
surfaces (Gemini API call payloads, derived files). If a secret slips
past Stage-0 redaction, it propagates.

Mitigation: defense in depth. Distillation has its own redaction pass.
The embedder call payload is bounded (rows are truncated). But the
primary defense is the Stage-0 redaction layer.

## Asset enumeration

Assets the redaction layer protects:

| Class | Examples | Current regex coverage |
|-------|----------|------------------------|
| Provider API keys | OpenAI `sk-proj-*`, Anthropic `sk-ant-*`, Google `AIza*`, GitHub `ghp_*` / `gho_*` / `ghs_*` / `ghr_*`, GCP service account JSON | partial — needs monthly review |
| OTPs / 2FA codes | 6-digit modern OTP, 8-digit legacy | `MODERN_OTP_REGEX` in predicates/a2p.js |
| Phone numbers | E.164 inbound shortcodes, full phone numbers | partial |
| Address-book UIDs | iMessage GUID, contact UID | full |
| URL query secrets | `?token=`, `?api_key=`, `?access_token=` | needs review |
| JWT / bearer tokens | `eyJ*` 3-part dotted | partial |
| AWS keys | `AKIA*`, `ASIA*` | partial |
| Stripe keys | `sk_live_*`, `pk_live_*` | needs review |
| SSH private keys | `-----BEGIN OPENSSH PRIVATE KEY-----` | full (block-form regex) |
| Slack tokens | `xoxb-*`, `xoxp-*`, `xapp-*` | partial |
| Discord tokens | webhook URLs + bot tokens | needs review |
| Webhook URLs with secrets | Discord, Slack, custom | partial |
| Credit card numbers | 13-19 digit Luhn-valid | not in scope (rarely in operator-machine text) |
| SSN | 9-digit US | not in scope |

Assets explicitly OUT of scope: private message body content, email
body content (those are first-class operator data; redaction would
defeat the system's purpose).

## Maintenance cadence

Monthly cycle, calendar-driven (cron or operator manual review):

1. **First Monday of each month**: review provider documentation for
   the providers in the asset table above. Specifically check:
   - GitHub: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github
   - OpenAI: https://platform.openai.com/docs/guides/production-best-practices/api-key-safety
   - Anthropic: https://docs.anthropic.com/en/api/getting-started
   - Google: https://cloud.google.com/docs/authentication/api-keys
   - Stripe: https://stripe.com/docs/keys
   - AWS: https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html
   - Slack: https://api.slack.com/authentication/token-types

2. For each provider, diff their published key format(s) against the
   `KEY_SHAPE_RX_FULL` entries. Add new regexes as needed.

3. **CI gate** (added as part of this spec):
   `mcp/test/redaction-fixture-corpus.test.mjs` exercises a checked-in
   fixture file of representative key formats per provider. Adding a new
   provider key shape requires:
   - Adding a fixture line to `mcp/test/fixtures/known-keys.jsonl`
   - Adding a regex to `KEY_SHAPE_RX_FULL`
   - Both arrive in the same commit. CI fails if a fixture exists with
     no matching regex, or if a regex matches no fixture.

4. **Operator review log**: each monthly cycle appends a row to
   `storage/redaction-review-log.jsonl`:
   ```json
   {
     "ts": "2026-06-07T00:00:00Z",
     "reviewer": "operator",
     "providers_reviewed": ["github","openai","..."],
     "new_regexes_added": ["github_fine_grained_pat"],
     "issues_flagged": [],
     "next_review_due": "2026-07-07T00:00:00Z"
   }
   ```

## Provider deprecation policy

When a provider deprecates an old key format:
- Old regex stays in `KEY_SHAPE_RX_FULL` indefinitely. Removing it
  would expose historical legitimate use that the user may still
  carry in paste buffers / shell history / etc.
- Fixture corpus row is annotated `deprecated_by_provider: <ts>` but
  not deleted.

## Drift detection

In production, a sampling layer in `mcp/lib/redaction/predicates.js`
emits a stderr warning when it observes a string that:
- Is high-entropy (Shannon entropy > 4.5 bits/byte), AND
- Is 16+ chars, AND
- Is NOT matched by any current `KEY_SHAPE_RX_FULL` regex.

Sampling rate: 0.1% of high-entropy candidates per source per day. The
sample is hashed (blake2b-trunc-12) and logged so the user can:
- See the hash in a stderr line.
- Search the source ledger for that hash to find a sample row.
- Decide whether the entropy hit is a false alarm or a missing regex.

A novel high-entropy string is NOT auto-redacted (false positives would
shred legitimate prose). It is FLAGGED for review only.

## Test fixture corpus

`mcp/test/fixtures/known-keys.jsonl` (created as part of this spec):

```jsonl
{"provider": "github", "shape": "ghp_", "sample": "ghp_AAAA...64chars", "deprecated_by_provider": null}
{"provider": "github", "shape": "fine_grained_pat", "sample": "github_pat_11AAAAA_...", "deprecated_by_provider": null}
{"provider": "openai", "shape": "sk-proj-", "sample": "sk-proj-AAA...100chars", "deprecated_by_provider": null}
{"provider": "openai", "shape": "sk-", "sample": "sk-AAAA...48chars", "deprecated_by_provider": "2024-12-01"}
{"provider": "anthropic", "shape": "sk-ant-api03-", "sample": "sk-ant-api03-...108chars", "deprecated_by_provider": null}
{"provider": "google", "shape": "AIza", "sample": "AIzaSyAAA...39chars", "deprecated_by_provider": null}
{"provider": "google", "shape": "AQ.", "sample": "AQ.AAAA...53chars", "deprecated_by_provider": null}
{"provider": "aws", "shape": "AKIA", "sample": "AKIAIOSFODNN7EXAMPLE", "deprecated_by_provider": null}
{"provider": "stripe", "shape": "sk_live_", "sample": "sk_live_AAAA...32chars", "deprecated_by_provider": null}
{"provider": "slack", "shape": "xoxb-", "sample": "xoxb-AAA...64chars", "deprecated_by_provider": null}
```

(Samples use `AAA...` placeholders so the file itself is not a secrets
honeypot.)

CI test:
```js
import { redactString } from "../lib/redaction/predicates.js";
import { readFileSync } from "node:fs";

const fixtures = readFileSync("./mcp/test/fixtures/known-keys.jsonl", "utf8")
  .trim().split("\n").map(JSON.parse);

for (const fx of fixtures) {
  const redacted = redactString(`api key is ${fx.sample}`);
  assert(!redacted.includes(fx.sample), `${fx.provider}/${fx.shape}: NOT redacted`);
}
```

## Ownership

| Role | Responsibility |
|------|----------------|
| Operator | monthly review; commits new regexes |
| CI | enforces fixture-corpus coverage; fails the build on new provider format without a regex |
| Drift sampler | flags novel high-entropy strings; operator triages |

The threat-model document itself lives at this path; updates to it
require an explicit operator-attributed commit.

## Review questions (from node)

1. Are all major provider key formats enumerated and tested?
   YES — see asset table + fixture corpus.
2. Is there a documented maintenance cadence?
   YES — monthly, first Monday, with operator review log.
3. Is there a drift detection mechanism for novel key shapes?
   YES — Shannon-entropy sampler at 0.1% rate, hashed + logged for
   operator triage.
4. Who owns the threat model document?
   Operator + CI; updates require explicit commit. See "Ownership"
   table.

## Files to touch (implementation, future PR)

- `mcp/lib/redaction/predicates.js` — add drift sampler + entropy check
- `mcp/test/fixtures/known-keys.jsonl` — new fixture corpus
- `mcp/test/redaction-fixture-corpus.test.mjs` — new CI gate
- `storage/redaction-review-log.jsonl` — new monthly review log
- Calendar cron (operator-side, not in repo) — first-Monday reminder

## Risk

- Provider docs are inconsistent; some require sign-in to see key
  formats (Stripe). Operator notes those as "manually verified" with a
  link.
- Drift sampler is statistical; rare high-entropy keys may evade
  sampling. Mitigation: sampling rate is operator-tunable; a paranoia
  mode (1.0%) is available during high-risk periods.
- Fixture corpus is itself low-risk because samples are `AAA...`
  placeholders, but the file MUST stay in the repo with shape regexes
  that match the placeholder (otherwise CI passes vacuously).
