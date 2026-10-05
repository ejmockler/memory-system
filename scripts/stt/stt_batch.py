#!/usr/bin/env python3
"""One-shot on-device speech-to-text worker (mlx-whisper).

Contract (see whatsapp-voice.js defaultPythonRunner):
  stdin : JSON list [{"id": str, "path": str}, ...]
  stdout: one JSON line per job:
          {"id", "text", "language", "avg_logprob", "no_speech_prob",
           "compression_ratio", "duration_s", "speech_s"}
          or {"id", "error": "<ExceptionClassName>"} on a per-job failure.
          duration_s = decoded samples / 16000 (the real clip length, not
          Whisper's padded segment end); speech_s = seconds of 30 ms frames
          whose RMS exceeds max(0.01, 4 x 10th-percentile frame RMS)
          (energy VAD against the clip's own noise floor).
  env   : if ffmpeg is not on PATH (after prepending /opt/homebrew/bin and
          /usr/local/bin) the worker prints exactly ONE line
          {"env_error":"ffmpeg_missing"} and exits 4, before any job runs.

Nothing is resident: the process transcribes the batch and exits.
The pause check runs only when GAMEPAUSE_FLAG is set (a path; unset or empty
means no check). When set it is checked FIRST, before mlx_whisper is imported,
so a paused machine never loads the model. stderr never carries audio paths or
transcript text.
"""
import json
import os
import shutil
import sys
import threading
import time

_DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"
_SAMPLE_RATE = 16000
_FRAME = 480  # 30 ms at 16 kHz
_EXTRA_PATH = ("/opt/homebrew/bin", "/usr/local/bin")


def _paused():
    flag = os.environ.get("GAMEPAUSE_FLAG")
    return bool(flag) and os.path.exists(flag)


def _ensure_ffmpeg():
    """True when ffmpeg is reachable, prepending the Homebrew dirs if needed.

    launchd's PATH (/usr/local/bin:/usr/bin:/bin:...) has no Apple-silicon
    Homebrew, and mlx_whisper.audio execs a bare "ffmpeg".
    """
    if shutil.which("ffmpeg") is not None:
        return True
    os.environ["PATH"] = os.pathsep.join(list(_EXTRA_PATH) + [os.environ.get("PATH", "")])
    return shutil.which("ffmpeg") is not None


def _speech_seconds(audio):
    """Seconds of 30 ms frames above max(0.01, 4 x noise-floor frame RMS).

    The noise floor is the 10th-percentile frame RMS, not the median: in a
    real voice note most frames ARE speech, so 4 x median only counts peaks
    (measured: a 78 s note scored 0.57 s). Digital silence and stationary
    noise (white/brown) have a flat RMS profile and score ~0.
    """
    import numpy as np

    a = np.asarray(audio, dtype=np.float32)
    n = len(a) // _FRAME
    if n == 0:
        return 0.0
    frames = a[: n * _FRAME].reshape(n, _FRAME)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    thresh = max(0.01, 4.0 * float(np.percentile(rms, 10)))
    return round(0.03 * int(np.count_nonzero(rms > thresh)), 2)


def _mean(values):
    return sum(values) / len(values) if values else None


def _summarise(job_id, result, duration_s=None, speech_s=None):
    segments = result.get("segments") or []
    avg_lp = [s["avg_logprob"] for s in segments if isinstance(s.get("avg_logprob"), (int, float))]
    nsp = [s["no_speech_prob"] for s in segments if isinstance(s.get("no_speech_prob"), (int, float))]
    cr = [s["compression_ratio"] for s in segments if isinstance(s.get("compression_ratio"), (int, float))]
    duration = duration_s
    if duration is None and segments and isinstance(segments[-1].get("end"), (int, float)):
        duration = float(segments[-1]["end"])
    text = result.get("text")
    return {
        "id": job_id,
        "text": text.strip() if isinstance(text, str) else "",
        "language": result.get("language"),
        "avg_logprob": _mean(avg_lp),
        "no_speech_prob": _mean(nsp),
        "compression_ratio": max(cr) if cr else None,
        "duration_s": duration,
        "speech_s": speech_s,
    }


def main():
    if _paused():
        return 0
    # Parent-death watchdog (invariant 6), started before any mlx_whisper
    # import: if the Node parent dies we get reparented, so exit hard rather
    # than linger as an orphan holding the model / tmp audio. Silent.
    parent_pid = os.getppid()

    def _watch_parent():
        while True:
            time.sleep(1.0)
            if os.getppid() != parent_pid:
                os._exit(3)

    threading.Thread(target=_watch_parent, name="stt-parent-watchdog", daemon=True).start()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    try:
        jobs = json.loads(sys.stdin.read() or "[]")
    except ValueError:
        return 2
    if not isinstance(jobs, list) or not jobs:
        return 0

    if not _ensure_ffmpeg():
        sys.stdout.write(json.dumps({"env_error": "ffmpeg_missing"}, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        return 4

    import mlx_whisper  # lazy: only after the pause check
    import mlx_whisper.audio

    model = os.environ.get("STT_MODEL") or _DEFAULT_MODEL
    for job in jobs:
        job_id = job.get("id") if isinstance(job, dict) else None
        if job_id is None:
            continue
        try:
            audio = mlx_whisper.audio.load_audio(job["path"])  # 16 kHz float
            duration_s = round(len(audio) / _SAMPLE_RATE, 2)
            speech_s = _speech_seconds(audio)
            result = mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=model,
                language=None,
                condition_on_previous_text=False,
            )
            line = _summarise(job_id, result, duration_s, speech_s)
        except Exception as e:  # per-job isolation; report class name only
            line = {"id": job_id, "error": type(e).__name__}
        sys.stdout.write(json.dumps(line, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
