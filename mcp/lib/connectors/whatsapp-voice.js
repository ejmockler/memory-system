// whatsapp-voice.js — on-device voice-note transcription core for WhatsApp 1:1.
//
// Pure-ish ESM, node stdlib only. Selects voice candidates (message_type 3,
// 1:1 consent only), copies audio into a private tmp dir, runs a one-shot
// python worker (scripts/stt/stt_batch.py) under a bounded process group,
// applies a quality gate, and shapes transcripts either in-band (into the
// voice row) or as a derived enrichment row.
//
// Consent is NEVER re-derived here: buildEnrichmentRow cross-checks against
// the connector's own classifyRow (invariant 3). Group / broadcast / any
// consent outside TRANSCRIBE_CONSENT is never selected, copied or transcribed
// (invariant 1). Tmp copies are unlinked on every path and a timeout kills
// the whole worker process group (invariant 6). Nothing is resident.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { sttBatchScriptPath, sttVenvPythonPath } from "../config.js";
import { classifyRow } from "./whatsapp.js";

export const TRANSCRIBE_CONSENT = Object.freeze(["first_party", "second_party_dm"]);

export const MAX_JOB_AUDIO_S = 900;
export const MAX_BATCH_AUDIO_S = 1800;
// Opus voice notes run ~2000 bytes/s; used when duration is unknown so a
// missing/0 duration can never bypass the caps (fail closed).
const OPUS_BYTES_PER_S = 2000;
const STALE_TMP_MS = 60 * 60 * 1000;
export const STT_ENGINE = "mlx-whisper";
export const DEFAULT_STT_MODEL = "mlx-community/whisper-large-v3-turbo";

function defaultMediaRoot() {
  return path.join(
    homedir(), "Library", "Group Containers",
    "group.net.whatsapp.WhatsApp.shared", "Message",
  );
}

// No built-in pause flag: the pause check is opt-in. GAMEPAUSE_FLAG (a path)
// enables it; unset or empty means no path is read and nothing is passed to
// the worker. An explicit flagPath option always wins over the environment.
export function defaultPauseFlag() {
  const v = process.env.GAMEPAUSE_FLAG;
  return typeof v === "string" && v !== "" ? v : null;
}

function allowedSet(opts) {
  const a = opts && Array.isArray(opts.allowedConsent) ? opts.allowedConsent : TRANSCRIBE_CONSENT;
  return a;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// 1:1 means the SESSION, not the speaker: classifyRow labels the operator's
// own notes in groups/broadcasts first_party, but only 1:1 chats are
// transcribable (invariant 1). Fails CLOSED: session_type must be the integer
// 0 (or the strict numeric string "0"); null/''/false/[]/undefined are NOT 0.
// The jid is an allowlist (1:1 suffixes only), never a denylist.
const ONE_ON_ONE_JID_SUFFIXES = Object.freeze(["@lid", "@s.whatsapp.net"]);
function isOneOnOneSession(rc) {
  if (!rc || typeof rc !== "object") return false;
  const raw = rc.session_type;
  let st = null;
  if (Number.isInteger(raw)) st = raw;
  else if (typeof raw === "string" && /^\d+$/.test(raw)) st = parseInt(raw, 10);
  if (st !== 0) return false;
  const jid = rc.session_jid;
  return typeof jid === "string"
    && jid !== ""
    && ONE_ON_ONE_JID_SUFFIXES.some((suf) => jid.endsWith(suf));
}

export function isVoiceCandidate(rc, consentBasis, opts = {}) {
  const allowed = allowedSet(opts);
  return (
    Number(rc?.message_type) === 3
    && isOneOnOneSession(rc)
    && typeof rc.media_local_path === "string"
    && rc.media_local_path !== ""
    && allowed.includes(consentBasis)
    && !(typeof rc.text === "string" && rc.text.trim() !== "")
  );
}

export function resolveMediaPath(rel, { mediaRoot } = {}) {
  if (typeof rel !== "string" || rel === "") return null;
  if (path.isAbsolute(rel)) return null;
  if (rel.split(/[\\/]/).some((seg) => seg === "..")) return null;
  return path.join(mediaRoot ?? defaultMediaRoot(), rel);
}

export function isGamePaused({ flagPath } = {}) {
  const p = flagPath ?? defaultPauseFlag();
  if (typeof p !== "string" || p === "") return false;
  return existsSync(p);
}

// ---------------------------------------------------------------------------
// Quality gate + row shaping
// ---------------------------------------------------------------------------

// Whisper's stock hallucinations on silence / noise, normalized (lowercase,
// Unicode punctuation and whitespace stripped). Only rejected when the clip
// carries under HALLUCINATION_SPEECH_S of energy-VAD speech, so a real "Thank
// you." spoken in a longer note still passes.
export const HALLUCINATION_DENYLIST = Object.freeze(new Set([
  "thankyou", "thanksforwatching", "thankyouforwatching", "you", "bye",
  "eaí", "eai", "subtitlesbytheamaraorgcommunity", "",
  "obrigado", "obrigada", "legendasdacomunidadeamaraorg",
  "gracias", "subtítulosrealizadosporlacomunidaddeamaraorg",
]));
export const MIN_SPEECH_S = 0.5;
export const HALLUCINATION_SPEECH_S = 3;

function normText(t) {
  return String(t).toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, "");
}

// One token repeated >= 3 times making up >= 80% of the words ("E aí E aí E aí"),
// or a short (2..4 word) text that is one denylisted phrase repeated k >= 2
// times ("Thank you. Thank you.", "Obrigado obrigado") -- the latter only
// under HALLUCINATION_SPEECH_S of speech, like the plain denylist rule.
function isRepeatedDenylisted(words) {
  if (words.length < 2 || words.length > 4) return false;
  const norm = words.join("");
  for (let k = 2; k <= words.length; k += 1) {
    if (norm.length % k !== 0) continue;
    const len = norm.length / k;
    const unit = norm.slice(0, len);
    if (unit === "" || !HALLUCINATION_DENYLIST.has(unit)) continue;
    let same = true;
    for (let i = 1; i < k; i += 1) {
      if (norm.slice(i * len, (i + 1) * len) !== unit) { same = false; break; }
    }
    if (same) return true;
  }
  return false;
}

function isRepeatedToken(text, speech) {
  const words = String(text).toLowerCase().split(/[\p{P}\p{Z}\s]+/u).filter(Boolean);
  if (typeof speech === "number" && speech < HALLUCINATION_SPEECH_S
      && isRepeatedDenylisted(words)) return true;
  if (words.length < 3) return false;
  const counts = new Map();
  let top = 0;
  for (const w of words) {
    const c = (counts.get(w) || 0) + 1;
    counts.set(w, c);
    if (c > top) top = c;
  }
  return top >= 3 && top / words.length >= 0.8;
}

export function passesQualityGate(r) {
  if (!(
    !!r
    && typeof r.text === "string"
    && r.text.trim() !== ""
    && !(r.compression_ratio > 2.4)
    && !(r.no_speech_prob > 0.6 && r.avg_logprob < -1)
  )) return false;
  const speech = r.speech_s;
  // The energy floor only binds notes >= 2 s long (or of unknown length):
  // a short real note can score little p10 speech; it is judged by text alone.
  const longEnough = typeof r.duration_s !== "number" || r.duration_s >= 2;
  if (longEnough && typeof speech === "number" && speech < MIN_SPEECH_S) return false;
  if (typeof speech === "number" && speech < HALLUCINATION_SPEECH_S
      && HALLUCINATION_DENYLIST.has(normText(r.text))) return false;
  if (isRepeatedToken(r.text, speech)) return false;
  return true;
}

function sttMeta(r) {
  const s = r?.stt ?? r ?? {};
  return {
    engine: STT_ENGINE,
    model: s.model ?? DEFAULT_STT_MODEL,
    language: s.language ?? null,
    avg_logprob: s.avg_logprob ?? null,
    no_speech_prob: s.no_speech_prob ?? null,
    compression_ratio: s.compression_ratio ?? null,
    duration_s: s.duration_s ?? null,
    speech_s: s.speech_s ?? null,
  };
}

export function applyTranscriptInBand(row, r) {
  if (!isOneOnOneSession(row?.raw_content)) {
    throw new Error("whatsapp-voice: in-band transcript refused for non-1:1 session");
  }
  const out = structuredClone(row);
  out.raw_content = {
    ...(out.raw_content || {}),
    text: r.text,
    text_origin: "stt",
    stt: sttMeta(r),
  };
  return out;
}

export function buildEnrichmentRow(parent, r, { consentBasis, allowedConsent } = {}) {
  const allowed = allowedSet({ allowedConsent });
  if (!allowed.includes(consentBasis)) {
    throw new Error(`whatsapp-voice: consent ${String(consentBasis)} not transcribable`);
  }
  const rc = parent?.raw_content || {};
  if (!isOneOnOneSession(rc)) {
    throw new Error("whatsapp-voice: enrichment refused for non-1:1 session");
  }
  const parentConsent = classifyRow({
    is_from_me: rc.is_from_me,
    session_type: rc.session_type,
  }).consent_basis;
  if (parentConsent !== consentBasis) {
    throw new Error("whatsapp-voice: consentBasis disagrees with parent classification");
  }
  return {
    ts: parent.ts,
    source_msg_id: `${parent.source_msg_id}#stt`,
    kind: "voice_transcript",
    derived_from: [parent.source_msg_id],
    parties: [...(parent.parties || [])],
    raw_content: {
      ...structuredClone(rc),
      text: r.text,
      text_origin: "stt",
      stt: sttMeta(r),
    },
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// Batch transcription
// ---------------------------------------------------------------------------

function copyName(id, absPath) {
  const h = createHash("sha256").update(String(id)).digest("hex").slice(0, 16);
  return h + path.extname(absPath || "");
}

// Re-derive eligibility per job BEFORE any copy (invariant 1). A job is
// {id, rawContent, durationS?}. Consent comes ONLY from the connector's
// classifyRow over rawContent (invariant 3); a caller-supplied consentBasis
// may only agree with it. No rawContent object -> fail closed.
function jobEligible(j, opts) {
  const rc = j?.rawContent;
  if (!rc || typeof rc !== "object" || Array.isArray(rc)) return false;
  const consent = classifyRow({ is_from_me: rc.is_from_me, session_type: rc.session_type }).consent_basis;
  if (j.consentBasis != null && j.consentBasis !== consent) return false;
  return isVoiceCandidate(rc, consent, opts);
}

function sweepStaleTmp(tmpDir, nowMs) {
  let names;
  try { names = readdirSync(tmpDir); } catch { return; }
  for (const name of names) {
    const p = path.join(tmpDir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && nowMs - st.mtimeMs > STALE_TMP_MS) unlinkSync(p);
    } catch { /* raced / best effort */ }
  }
}

function audioSeconds(j, absPath) {
  const d = Number(j.durationS);
  if (Number.isFinite(d) && d > 0) return d;
  try {
    return Math.max(1, statSync(absPath).size / OPUS_BYTES_PER_S);
  } catch {
    return null;
  }
}

// Mid-batch pause is handled EXTERNALLY: gamepause.sh PAUSE_PKILL and
// PAUSED_PKILL_EACH_POLL kill stt_batch.py when a game starts. The runner then
// rejects/returns short, copies are still unlinked in finally below, and any
// orphan left by a harder crash is swept after 1h on the next batch.
export async function transcribeBatch(jobs, opts = {}) {
  const { runner, tmpDir } = opts;
  if (typeof runner !== "function") throw new TypeError("transcribeBatch: runner required");
  if (typeof tmpDir !== "string" || tmpDir === "") throw new TypeError("transcribeBatch: tmpDir required");

  const out = jobs.map((j) => ({ id: j.id, ok: false, text: null, stt: null, reason: null }));

  // (a) paused is not a failure: nothing copied, nothing run.
  if (isGamePaused({ flagPath: opts.flagPath })) {
    for (const o of out) o.reason = "paused";
    return out;
  }

  const pending = []; // indexes selected for this batch
  const audioS = new Map(); // index -> seconds (reported or size-estimated)
  const absPaths = new Map(); // index -> path derived from the CHECKED row
  const seenIds = new Set();
  let total = 0;
  jobs.forEach((j, i) => {
    // (b) dedupe by id — first wins.
    const key = String(j.id);
    if (seenIds.has(key)) { out[i].reason = "duplicate"; return; }
    seenIds.add(key);
    // (c) eligibility before any copy.
    if (!jobEligible(j, opts)) { out[i].reason = "not_eligible"; return; }
    // Bind the copied file to the checked row: the path is derived here from
    // rawContent.media_local_path under mediaRoot. A caller absPath is ignored.
    const absPath = resolveMediaPath(j.rawContent.media_local_path, { mediaRoot: opts.mediaRoot });
    if (absPath == null) { out[i].reason = "not_eligible"; return; }
    // (e) duration, estimated from size when unknown.
    const d = audioSeconds(j, absPath);
    if (d == null) { out[i].reason = "unreadable"; return; }
    if (d > MAX_JOB_AUDIO_S) { out[i].reason = "too_long"; return; }
    if (total + d > MAX_BATCH_AUDIO_S) { out[i].reason = "batch_cap"; return; }
    total += d;
    audioS.set(i, d);
    absPaths.set(i, absPath);
    pending.push(i);
  });

  if (pending.length === 0) return out;

  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  chmodSync(tmpDir, 0o700);
  // (d) sweep copies orphaned by a crashed earlier run (invariant 6).
  const nowMs = typeof opts.now === "function" ? Number(opts.now()) : Date.now();
  sweepStaleTmp(tmpDir, nowMs);

  const copies = [];
  const inputJobs = [];
  let submittedAudio = 0;
  try {
    for (const i of pending) {
      const j = jobs[i];
      const src = absPaths.get(i);
      const dest = path.join(tmpDir, copyName(j.id, src));
      try {
        accessSync(src, fsConstants.R_OK);
        copies.push(dest);
        copyFileSync(src, dest);
        chmodSync(dest, 0o600);
      } catch {
        out[i].reason = "unreadable";
        continue;
      }
      inputJobs.push({ id: j.id, path: dest, _i: i });
      submittedAudio += audioS.get(i);
    }

    if (inputJobs.length === 0) return out;

    // (f) cold model load + generous per-second budget.
    const timeoutMs = 60000 + 150 * submittedAudio;
    let results;
    try {
      results = await runner(inputJobs.map(({ id, path: p }) => ({ id, path: p })), { timeoutMs });
    } catch {
      for (const ij of inputJobs) out[ij._i].reason = "stt_error";
      return out;
    }

    const byId = new Map();
    for (const r of Array.isArray(results) ? results : []) {
      if (r && typeof r === "object" && r.id != null && !byId.has(String(r.id))) byId.set(String(r.id), r);
    }
    for (const ij of inputJobs) {
      const r = byId.get(String(ij.id));
      const slot = out[ij._i];
      if (!r) { slot.reason = "no_result"; continue; }
      if (r.error) {
        // Runner-level failures (see defaultPythonRunner) keep their own
        // retryable reason; a per-job exception class name is stt_error.
        slot.reason = RUNNER_ERRORS.has(r.error) ? r.error : "stt_error";
        continue;
      }
      if (!passesQualityGate(r)) { slot.reason = "quality_gate"; continue; }
      slot.ok = true;
      slot.text = r.text.trim();
      slot.stt = sttMeta({ ...r, model: r.model ?? opts.model });
    }
    return out;
  } finally {
    for (const c of copies) {
      try { unlinkSync(c); } catch { /* ENOENT (never copied) or best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Default runner — one-shot python worker, bounded by a process-group kill.
// ---------------------------------------------------------------------------

// Runner contract: resolves an ARRAY OF JOB LINES, one per job the worker
// reported ({id, text, ..., speech_s} or {id, error:"<ExceptionClass>"}).
// Two worker-level failures are mapped onto EVERY submitted job instead of
// returning a bare marker, so the array-of-lines contract holds:
//   {id, error:"env_error"}    the worker printed an {"env_error": ...} line
//                              (e.g. ffmpeg_missing, exit 4);
//   {id, error:"env_error"}    the interpreter/script could not be spawned
//                              (spawn 'error' ENOENT/EACCES: dangling venv,
//                              non-executable script);
//   {id, error:"worker_crash"} it exited non-zero (a numeric code, not a
//                              timeout/pause kill) with zero job lines, OR it
//                              died by a signal the runner did NOT send
//                              (SIGSEGV, jetsam SIGKILL) with zero job lines.
// The runner's own timeout kill still REJECTS (-> stt_error, an attempt; the
// connector relabels it to paused when the pause flag is present). Any other
// spawn error also rejects.
// Only the reason code is surfaced; stderr stays ignored and is never read.
export const RUNNER_ERRORS = Object.freeze(new Set(["env_error", "worker_crash"]));

export function defaultPythonRunner({
  venvPython = sttVenvPythonPath(),
  scriptPath = sttBatchScriptPath(),
  flagPath,
} = {}) {
  return (jobs, { timeoutMs } = {}) => new Promise((resolve, reject) => {
    // launchd's PATH has no /opt/homebrew/bin, where ffmpeg lives.
    const env = {
      ...process.env,
      PATH: "/opt/homebrew/bin:/usr/local/bin:" + (process.env.PATH || "/usr/bin:/bin"),
      HF_HUB_OFFLINE: "1",
    };
    // The worker's pause check is opt-in: an explicit flagPath wins, else an
    // ambient GAMEPAUSE_FLAG passes through, else the key is absent (an empty
    // ambient value is dropped rather than forwarded).
    const flag = flagPath ?? defaultPauseFlag();
    if (typeof flag === "string" && flag !== "") env.GAMEPAUSE_FLAG = flag;
    else delete env.GAMEPAUSE_FLAG;
    const child = spawn(venvPython, [scriptPath], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env,
    });
    let stdout = "";
    let timer = null;
    let timedOut = false;
    let settled = false; // 'close' can follow 'error'; settle once.
    const all = (error) => (Array.isArray(jobs) ? jobs : []).map((j) => ({ id: j.id, error }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (e && (e.code === "ENOENT" || e.code === "EACCES")) resolve(all("env_error"));
      else reject(e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      const lines = [];
      let envError = false;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (!o || typeof o !== "object" || Array.isArray(o)) continue;
          if (Object.prototype.hasOwnProperty.call(o, "env_error")) envError = true;
          else if (o.id != null) lines.push(o);
        } catch { /* ignore unparsable */ }
      }
      if (envError) resolve(all("env_error"));
      else if (timedOut) reject(new Error("timeout"));
      else if (signal && code === null && lines.length === 0) resolve(all("worker_crash"));
      else if (Number.isInteger(code) && code !== 0 && lines.length === 0) resolve(all("worker_crash"));
      else resolve(lines);
    });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }, timeoutMs);
    }
    child.stdin.end(JSON.stringify(jobs));
  });
}
