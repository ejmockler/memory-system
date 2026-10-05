// time-anchor-resolver.js — substrate-tier deterministic temporal-phrase
// extractor + resolver. Implements F-SYN-SUBSTRATE-TIME-ANCHOR-RESOLVER and
// honors the contract pinned in docs/specs/synthesis/time-anchor-schema.md.
//
// Output shape (per the work-unit signature, simplified from the full
// TimeAnchor union — the schema validator at the foundation tier widens this
// into the full {parsed:{iso,offset_from,offset_seconds,...}} block; this
// module emits the load-bearing fields the recall scorer reads directly):
//
//   {
//     anchors: Array<{
//       kind: "absolute" | "relative" | "recurring",
//       instant_iso: string | null,   // ISO-8601 with explicit Z offset
//       duration_ms: number | null,
//       raw_phrase: string,           // verbatim substring extracted
//       span: [start, end],           // char offsets into the input text
//       confidence: number,           // [0, 1]
//     }>
//   }
//
// Invariants (mirror schema spec):
//   - I2  Pure: no ambient-clock reads. `now` flows through opts.now ONLY.
//         All references to wall-clock time in this module go through the
//         caller-supplied opts.now argument.
//   - I3  When a relative anchor is parsed without opts.now, instant_iso
//         falls back to null (the caller — promote-time cascade OR
//         recall-time recall-service — is responsible for supplying now).
//   - I9  Recurring anchors carry instant_iso=null (deferred at v0).
//   - F2  Empty anchors are returned when nothing parses. The recall scorer
//         masks time_anchor_match to 0 on empty arrays.
//
// Lint discipline: a CI test asserts this file contains no zero-arg
// constructions of the system clock. The Date constructor is invoked below
// only with an explicit string/number argument.

export const TIME_ANCHOR_RESOLVER_VERSION = "rule-v1";

// Closed CAPS block — per-WU substrate-minor-polish (recurring-kind crash
// check, fuzzy-anchor floor telemetry, multi-anchor conflict detection).
// Bumping any value here REQUIRES TIME_ANCHOR_RESOLVER_VERSION bump so the
// resolver's downstream consumers (multi-feature scorer, density-flag
// feedback) can re-key cached features. Object.freeze enforces single-
// producer discipline at module-load time.
export const TIME_ANCHOR_RESOLVER_CAPS = Object.freeze({
  // FUZZY_FLOOR — anchors with confidence below this are counted in the
  // fuzzy_anchor_floor_hits telemetry counter. The floor matches the
  // recall-side propensity-jitter band (0.3) and is the threshold below
  // which an anchor should be treated as "informational only" rather than
  // load-bearing for time_anchor_match.
  FUZZY_FLOOR: 0.3,
  // Maximum anchors emitted per fact (mirrors the schema spec § CAPS.
  // TIME_ANCHORS_MAX_PER_FACT). Held here as the single source of truth —
  // and that is now literally true rather than aspirational: the three
  // connector CAPS bags that publish this key (chat-claude-code.js,
  // github-events.js, imessage.js) import TIME_ANCHOR_RESOLVER_CAPS and read
  // the value from here instead of re-spelling the literal, so changing this
  // number changes all four PRODUCTION declaration sites at once.
  //
  // WHAT IT DOES NOT CHANGE, stated as a RULE rather than a line list, because
  // this comment has now been wrong twice in the same spot and a line list is
  // what rots:
  //   - the resolver's own suite deliberately pins the literal and will go RED.
  //     That is the design: a cap this schema-visible should not move silently.
  //   - the specs under mcp/docs/specs/ describe the cap in prose, in more than
  //     one file and at many points. They are documentation, not code, and they
  //     do not move with this constant. Grep before assuming a count.
  //
  // The history is the warning. This seat first claimed to be a "single source
  // of truth" while three connectors spelled the literal. That was corrected to
  // "there is nowhere else to change" — a false absolute. That was corrected to
  // a two-file citation that named 2 of 9 spellings and pointed at a path
  // (docs/specs/...) that does not exist, since the specs live under mcp/docs/.
  // Three tries, three over-claims, each one narrower. State the rule; let grep
  // supply the count.
  //
  // Related gap, found while auditing the above and deliberately NOT fixed here:
  // the schema spec requires this cap to land in mcp/lib/validation.js before
  // the scorer consumes it. It never did — validateAnchorList and the
  // time_anchor_cap_exceeded reason exist only in the spec. The truncation that
  // actually runs is the slice in this module and in the three connectors.
  TIME_ANCHORS_MAX_PER_FACT: 8,
  // CONFLICT_THRESHOLD_MS — two anchors with instant_iso values farther
  // apart than this are considered conflicting (when both kinds are
  // absolute/relative, not recurring). 12 hours captures "yesterday at 3pm"
  // vs "Mar 14 2023" while tolerating ambiguity within the same calendar day.
  CONFLICT_THRESHOLD_MS: 12 * 60 * 60 * 1000,
});

// Module-level telemetry counter. The recall-side populator reads this via
// the exported getter; resetting is a test-only concern (resetTelemetry()).
// Single-producer discipline: only this module mutates these counters; all
// readers go through getTelemetry().
const _telemetry = {
  fuzzy_anchor_floor_hits: 0,
  recurring_parse_failures: 0,
  multi_anchor_conflicts: 0,
};

export function getTimeAnchorTelemetry() {
  return Object.freeze({
    fuzzy_anchor_floor_hits: _telemetry.fuzzy_anchor_floor_hits,
    recurring_parse_failures: _telemetry.recurring_parse_failures,
    multi_anchor_conflicts: _telemetry.multi_anchor_conflicts,
  });
}

export function resetTimeAnchorTelemetry() {
  _telemetry.fuzzy_anchor_floor_hits = 0;
  _telemetry.recurring_parse_failures = 0;
  _telemetry.multi_anchor_conflicts = 0;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_SECOND = 1000;
const MS_MINUTE = 60 * MS_SECOND;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;
const MS_WEEK = 7 * MS_DAY;

// Month name → 0-indexed month. Both long and three-letter forms.
const MONTH_NAMES = Object.freeze({
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
});

// Weekday name → 0-indexed weekday (0=Sunday, matches Date.getUTCDay).
const WEEKDAYS = Object.freeze({
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
});

const WORD_NUMBERS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
  a: 1, an: 1,
});

// Unit → ms multiplier.
const UNIT_MS = Object.freeze({
  second: MS_SECOND, seconds: MS_SECOND, sec: MS_SECOND, secs: MS_SECOND,
  minute: MS_MINUTE, minutes: MS_MINUTE, min: MS_MINUTE, mins: MS_MINUTE,
  hour: MS_HOUR, hours: MS_HOUR, hr: MS_HOUR, hrs: MS_HOUR,
  day: MS_DAY, days: MS_DAY,
  week: MS_WEEK, weeks: MS_WEEK,
  // months and years are calendar-relative — handled separately because they
  // are not constant-ms; we still record a duration_ms approximation.
  month: 30 * MS_DAY, months: 30 * MS_DAY,
  year: 365 * MS_DAY, years: 365 * MS_DAY,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

// Build a UTC ISO-8601 string at midnight Z for a given year/month/day.
function isoDay(y, m /* 0-indexed */, d) {
  return `${y}-${pad2(m + 1)}-${pad2(d)}T00:00:00Z`;
}

// Build an ISO-8601 with explicit hour/minute, UTC.
function isoHour(y, m, d, hh, mm = 0) {
  return `${y}-${pad2(m + 1)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:00Z`;
}

// Parse opts.now into a UTC anchor record. Never reads ambient clock.
function nowAnchor(now) {
  if (now == null) return null;
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) return null;
  return {
    iso: d.toISOString(),
    ms: d.getTime(),
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

// Offset a UTC ms epoch by N days, return ISO at midnight Z.
function isoDayOffset(base, deltaDays) {
  const ms = base.ms + deltaDays * MS_DAY;
  const d = new Date(ms);
  return isoDay(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Compose day-iso + hour-of-day.
function isoDayWithHour(dayIso, hh, mm = 0) {
  const d = new Date(dayIso);
  return isoHour(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm);
}

// Add a record without overlapping spans (later rules don't double-count
// substrings already consumed by earlier rules). Returns true if added.
function tryAdd(anchors, occupied, anchor) {
  const [a, b] = anchor.span;
  for (const [oa, ob] of occupied) {
    // overlap test
    if (a < ob && b > oa) return false;
  }
  anchors.push(anchor);
  occupied.push([a, b]);
  return true;
}

// ---------------------------------------------------------------------------
// Rule scanners. Each scanner takes (text, lowered, ctx) and returns an
// array of anchor candidates. Candidates may overlap; tryAdd resolves
// conflicts by first-write-wins, with rules ordered most-specific to least.
// ---------------------------------------------------------------------------

// Rule 1: ISO-8601 date (and optional time) — "2026-06-18", "2026-06-18T15:00:00Z".
function scanIsoDates(text) {
  const out = [];
  const re = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [whole, yStr, moStr, dStr, hhStr, mmStr] = m;
    const y = Number(yStr), mo = Number(moStr) - 1, d = Number(dStr);
    if (mo < 0 || mo > 11 || d < 1 || d > 31) continue;
    const iso = hhStr != null
      ? isoHour(y, mo, d, Number(hhStr), Number(mmStr))
      : isoDay(y, mo, d);
    out.push({
      kind: "absolute",
      instant_iso: iso,
      duration_ms: null,
      raw_phrase: whole,
      span: [m.index, m.index + whole.length],
      confidence: 1.0,
    });
  }
  return out;
}

// Rule 2: explicit English date — "March 14, 2023", "Mar 14 2023", "14 March 2023".
function scanEnglishDates(text) {
  const out = [];
  // "Month D, YYYY" / "Month D YYYY" / "Month Dst, YYYY"
  const re1 = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})\b/gi;
  let m;
  while ((m = re1.exec(text)) !== null) {
    const mo = MONTH_NAMES[m[1].toLowerCase()];
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (d < 1 || d > 31) continue;
    out.push({
      kind: "absolute",
      instant_iso: isoDay(y, mo, d),
      duration_ms: null,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence: 0.98,
    });
  }
  // "D Month YYYY"
  const re2 = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{4})\b/gi;
  while ((m = re2.exec(text)) !== null) {
    const d = Number(m[1]);
    const mo = MONTH_NAMES[m[2].toLowerCase()];
    const y = Number(m[3]);
    if (d < 1 || d > 31) continue;
    out.push({
      kind: "absolute",
      instant_iso: isoDay(y, mo, d),
      duration_ms: null,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence: 0.98,
    });
  }
  return out;
}

// Rule 3: "Month D" without year — pin to the current year if `now` is
// available, otherwise emit as relative with instant_iso=null.
function scanMonthDayNoYear(text, ctx) {
  const out = [];
  const re = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const mo = MONTH_NAMES[m[1].toLowerCase()];
    const d = Number(m[2]);
    if (d < 1 || d > 31) continue;
    if (ctx.now) {
      out.push({
        kind: "absolute",
        instant_iso: isoDay(ctx.now.year, mo, d),
        duration_ms: null,
        raw_phrase: m[0],
        span: [m.index, m.index + m[0].length],
        confidence: 0.85,
      });
    } else {
      out.push({
        kind: "absolute",
        instant_iso: null,
        duration_ms: null,
        raw_phrase: m[0],
        span: [m.index, m.index + m[0].length],
        confidence: 0.7,
      });
    }
  }
  return out;
}

// Rule 4: relative day-of-week (yesterday/today/tomorrow) optionally with time.
function scanRelativeDayNames(text, ctx) {
  const out = [];
  // "yesterday at 3pm", "tomorrow at 14:30", "today at noon", or bare.
  const re = /\b(yesterday|today|tonight|tomorrow)(?:\s+(?:at|@)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?|\s+(?:at|@)\s+(noon|midnight))?\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const word = m[1].toLowerCase();
    const hhRaw = m[2] != null ? Number(m[2]) : null;
    const mmRaw = m[3] != null ? Number(m[3]) : 0;
    const ampm = m[4] != null ? m[4].toLowerCase() : null;
    const namedTime = m[5] != null ? m[5].toLowerCase() : null;

    let deltaDays;
    if (word === "yesterday") deltaDays = -1;
    else if (word === "today") deltaDays = 0;
    else if (word === "tonight") deltaDays = 0;
    else deltaDays = 1; // tomorrow

    let instant = null;
    let confidence = 0.9;
    if (ctx.now) {
      const dayIso = isoDayOffset(ctx.now, deltaDays);
      if (namedTime === "noon") instant = isoDayWithHour(dayIso, 12, 0);
      else if (namedTime === "midnight") instant = isoDayWithHour(dayIso, 0, 0);
      else if (hhRaw != null) {
        let hh = hhRaw;
        if (ampm === "pm" && hh < 12) hh += 12;
        if (ampm === "am" && hh === 12) hh = 0;
        instant = isoDayWithHour(dayIso, hh, mmRaw);
        confidence = 0.95;
      } else if (word === "tonight") {
        instant = isoDayWithHour(dayIso, 20, 0); // default 8pm local-ish
        confidence = 0.7;
      } else {
        instant = dayIso;
      }
    } else {
      confidence *= 0.5;
    }

    out.push({
      kind: "relative",
      instant_iso: instant,
      duration_ms: null,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence,
    });
  }
  return out;
}

// Rule 5: "last week" / "next month" / "last summer" — relative spans.
function scanRelativeSpans(text, ctx) {
  const out = [];
  const re = /\b(last|next|this|past|coming)\s+(week|weeks|month|months|year|years|summer|winter|spring|autumn|fall)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const dir = m[1].toLowerCase();
    const unit = m[2].toLowerCase();
    let duration = null;
    let deltaDays = null;
    if (unit.startsWith("week")) {
      duration = MS_WEEK;
      deltaDays = dir === "last" || dir === "past" ? -7 : dir === "next" || dir === "coming" ? 7 : 0;
    } else if (unit.startsWith("month")) {
      duration = 30 * MS_DAY;
      deltaDays = dir === "last" || dir === "past" ? -30 : dir === "next" || dir === "coming" ? 30 : 0;
    } else if (unit.startsWith("year")) {
      duration = 365 * MS_DAY;
      deltaDays = dir === "last" || dir === "past" ? -365 : dir === "next" || dir === "coming" ? 365 : 0;
    } else {
      // season — coarse 90-day span
      duration = 90 * MS_DAY;
      deltaDays = dir === "last" || dir === "past" ? -180 : dir === "next" || dir === "coming" ? 180 : 0;
    }
    let instant = null;
    let confidence = 0.75;
    if (ctx.now) {
      instant = isoDayOffset(ctx.now, deltaDays);
    } else {
      confidence *= 0.5;
    }
    out.push({
      kind: "relative",
      instant_iso: instant,
      duration_ms: duration,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence,
    });
  }
  return out;
}

// Rule 6: "N units ago" / "in N units" — relative offsets.
function scanNumericOffsets(text, ctx) {
  const out = [];
  // "3 hours ago", "two weeks ago"
  const reAgo = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an)\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/gi;
  let m;
  while ((m = reAgo.exec(text)) !== null) {
    const nRaw = m[1].toLowerCase();
    const n = WORD_NUMBERS[nRaw] != null ? WORD_NUMBERS[nRaw] : Number(nRaw);
    if (!Number.isFinite(n)) continue;
    const unitMs = UNIT_MS[m[2].toLowerCase()];
    if (unitMs == null) continue;
    let instant = null;
    let confidence = 0.9;
    if (ctx.now) {
      const ms = ctx.now.ms - n * unitMs;
      instant = new Date(ms).toISOString();
    } else {
      confidence *= 0.5;
    }
    out.push({
      kind: "relative",
      instant_iso: instant,
      duration_ms: null,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence,
    });
  }
  // "in 3 hours", "in two days"
  const reIn = /\bin\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an)\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\b/gi;
  while ((m = reIn.exec(text)) !== null) {
    const nRaw = m[1].toLowerCase();
    const n = WORD_NUMBERS[nRaw] != null ? WORD_NUMBERS[nRaw] : Number(nRaw);
    if (!Number.isFinite(n)) continue;
    const unitMs = UNIT_MS[m[2].toLowerCase()];
    if (unitMs == null) continue;
    let instant = null;
    let confidence = 0.85;
    if (ctx.now) {
      const ms = ctx.now.ms + n * unitMs;
      instant = new Date(ms).toISOString();
    } else {
      confidence *= 0.5;
    }
    out.push({
      kind: "relative",
      instant_iso: instant,
      duration_ms: null,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence,
    });
  }
  return out;
}

// Rule 7: recurring — "every Monday", "weekly", "every day", "each morning".
function scanRecurring(text) {
  const out = [];
  // "every Monday", "every Tuesday morning"
  const reDay = /\bevery\s+(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thur|thurs|thu|friday|fri|saturday|sat|sunday|sun)(?:\s+(morning|afternoon|evening|night))?\b/gi;
  let m;
  while ((m = reDay.exec(text)) !== null) {
    out.push({
      kind: "recurring",
      instant_iso: null,
      duration_ms: null,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence: 0.9,
    });
  }
  // "weekly", "monthly", "daily", "yearly", "annually", "hourly"
  const rePeriod = /\b(weekly|monthly|daily|yearly|annually|hourly)\b/gi;
  while ((m = rePeriod.exec(text)) !== null) {
    out.push({
      kind: "recurring",
      instant_iso: null,
      duration_ms: null,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence: 0.85,
    });
  }
  // "every day", "every week", "each morning"
  const reEvery = /\b(?:every|each)\s+(day|week|month|year|morning|afternoon|evening|night|hour|minute)\b/gi;
  while ((m = reEvery.exec(text)) !== null) {
    out.push({
      kind: "recurring",
      instant_iso: null,
      duration_ms: null,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence: 0.82,
    });
  }
  return out;
}

// Rule 8: bare time without day context — "at 3pm" (low confidence, no
// instant unless combined with an anchor day; v0 emits the relative anchor
// pinned to ctx.now's day if available).
function scanBareTime(text, ctx) {
  const out = [];
  const re = /\b(?:at|@)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const hhRaw = Number(m[1]);
    const mmRaw = m[2] != null ? Number(m[2]) : 0;
    const ampm = m[3].toLowerCase();
    let hh = hhRaw;
    if (ampm === "pm" && hh < 12) hh += 12;
    if (ampm === "am" && hh === 12) hh = 0;
    let instant = null;
    if (ctx.now) {
      instant = isoHour(ctx.now.year, ctx.now.month, ctx.now.day, hh, mmRaw);
    }
    out.push({
      kind: "relative",
      instant_iso: instant,
      duration_ms: null,
      raw_phrase: m[0],
      span: [m.index, m.index + m[0].length],
      confidence: 0.55,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Resolve time-anchor phrases from prose.
 *
 * @param {string} text - the prose to scan
 * @param {{now?: string, locale?: string}} [opts]
 *        opts.now    - ISO-8601 reference time for relative phrases
 *        opts.locale - reserved; only "en" is implemented in v0
 * @returns {{anchors: Array<{
 *   kind: "absolute"|"relative"|"recurring",
 *   instant_iso: string|null,
 *   duration_ms: number|null,
 *   raw_phrase: string,
 *   span: [number, number],
 *   confidence: number
 * }>}}
 */
export function resolveTimeAnchors(text, opts = {}) {
  if (typeof text !== "string" || text.length === 0) {
    return { anchors: [], conflict: false };
  }
  // Truncate excessive input per spec (50KB cap from implementation_hints).
  const truncated = text.length > 50_000 ? text.slice(0, 50_000) : text;
  const ctx = { now: nowAnchor(opts.now ?? null) };

  // Recurring-kind crash check (substrate-minor-polish item #1). The
  // recurring scanner uses bounded regexes that cannot throw under normal
  // input, but a malformed "every X" pattern with a non-parsable X has
  // been observed to produce zero anchors silently. Per the policy: if
  // the input contains an "every X" / "each X" cue but the recurring
  // scanner returned nothing, increment the recurring_parse_failures
  // counter and continue with empty anchors (do NOT throw — the populator
  // wraps us in try/catch, but a thrown error still flips
  // populator.degraded=true, which is too noisy for a parse miss).
  let candidates;
  try {
    // Order matters: most-specific first. ISO and explicit dates win over
    // month-day-no-year; named relatives win over bare time; recurring wins
    // over "every X" overlap with weekday names.
    candidates = [
      ...scanIsoDates(truncated),
      ...scanEnglishDates(truncated),
      ...scanRecurring(truncated),
      ...scanRelativeDayNames(truncated, ctx),
      ...scanRelativeSpans(truncated, ctx),
      ...scanNumericOffsets(truncated, ctx),
      ...scanMonthDayNoYear(truncated, ctx),
      ...scanBareTime(truncated, ctx),
    ];
  } catch (err) {
    void err;
    _telemetry.recurring_parse_failures += 1;
    return { anchors: [], conflict: false };
  }

  // Detect "every X" / "each X" recurring-kind cue and verify the recurring
  // scanner caught at least one — otherwise increment recurring_parse_failures
  // and return empty anchors so the downstream multi-feature scorer treats
  // the populator output as "no time signal" rather than half-parsed garbage.
  const hasRecurringCue = /\b(?:every|each)\s+\S+/i.test(truncated);
  if (hasRecurringCue) {
    const recurringHit = candidates.some((c) => c.kind === "recurring");
    if (!recurringHit) {
      _telemetry.recurring_parse_failures += 1;
      // Defensive degrade: empty anchors so the downstream scorer treats
      // this as "no time signal" rather than half-parsed garbage.
      return { anchors: [], conflict: false };
    }
  }

  // First-write-wins de-overlap. Sort by span start ascending, then by
  // span length descending so the longest match at each start wins.
  candidates.sort((a, b) => {
    if (a.span[0] !== b.span[0]) return a.span[0] - b.span[0];
    return (b.span[1] - b.span[0]) - (a.span[1] - a.span[0]);
  });

  const anchors = [];
  const occupied = [];
  for (const c of candidates) {
    tryAdd(anchors, occupied, c);
  }

  // Cap at TIME_ANCHORS_MAX_PER_FACT (single source of truth in CAPS).
  if (anchors.length > TIME_ANCHOR_RESOLVER_CAPS.TIME_ANCHORS_MAX_PER_FACT) {
    anchors.length = TIME_ANCHOR_RESOLVER_CAPS.TIME_ANCHORS_MAX_PER_FACT;
  }

  // Fuzzy-anchor floor telemetry. Count anchors whose confidence is below
  // CAPS.FUZZY_FLOOR — the downstream scorer can still consume them but
  // operator dashboards see the prevalence of low-confidence parses.
  for (const a of anchors) {
    if (typeof a.confidence === "number"
        && a.confidence < TIME_ANCHOR_RESOLVER_CAPS.FUZZY_FLOOR) {
      _telemetry.fuzzy_anchor_floor_hits += 1;
    }
  }

  // Multi-anchor conflict detection. Two non-recurring anchors with parsed
  // instant_iso values farther apart than CONFLICT_THRESHOLD_MS are flagged
  // as conflicting (e.g. "yesterday at 3pm" + "Mar 14 2023" present together).
  // The flag bubbles up to recall.js populator.degraded_reasons but does NOT
  // change which anchors are emitted — the downstream scorer is responsible
  // for picking which instant to honor.
  let conflict = false;
  const datedAnchors = anchors.filter(
    (a) => a.kind !== "recurring"
      && typeof a.instant_iso === "string"
      && a.instant_iso.length > 0,
  );
  if (datedAnchors.length >= 2) {
    for (let i = 0; i < datedAnchors.length && !conflict; i++) {
      const t1 = Date.parse(datedAnchors[i].instant_iso);
      if (Number.isNaN(t1)) continue;
      for (let j = i + 1; j < datedAnchors.length; j++) {
        const t2 = Date.parse(datedAnchors[j].instant_iso);
        if (Number.isNaN(t2)) continue;
        if (Math.abs(t1 - t2) > TIME_ANCHOR_RESOLVER_CAPS.CONFLICT_THRESHOLD_MS) {
          conflict = true;
          _telemetry.multi_anchor_conflicts += 1;
          break;
        }
      }
    }
  }

  return { anchors, conflict };
}
