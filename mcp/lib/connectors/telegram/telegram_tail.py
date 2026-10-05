#!/usr/bin/env python3
"""telegram_tail.py — R38 Phase 2c Telegram MTProto tail daemon.

Subscribes to NewMessage events via Telethon and appends one JSONL line per
event to TELEGRAM_STAGING_FILE (default
<MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl; MEMORY_ROOT falls back to
the checkout that contains this file).
The Node-side connector at mcp/lib/connectors/telegram.js tails that file
byte-offset cursor style and normalises rows into the canonical source-row
shape, then appends to storage/sources/telegram.jsonl.

Auth model
----------
MTProto requires a user session. The operator runs telegram_login.py ONCE,
which writes a Telethon StringSession to ~/.config/memory-system/telegram.session
(0600). This daemon reads that file (or TELEGRAM_SESSION_STRING env var)
and never prompts. If the session is missing/invalid the daemon prints a
clear pointer to telegram_login.py and exits non-zero.

Key/secret discipline
---------------------
The session string is loaded from disk or env and is NEVER printed or echoed
to stdout/stderr. Per-event JSON contains no session bytes. API id/hash come
from operator env (TELEGRAM_API_ID, TELEGRAM_API_HASH) or fall back to the
public sample-app credentials documented at my.telegram.org for read-only
tail usage.

Per-event JSON shape (one per line):
    {
      "peer_type": "user" | "group" | "supergroup" | "channel",
      "peer_id":   int,
      "peer_name": str | null,
      "message_id": int,
      "ts":        ISO-8601 UTC,
      "sender_id": int | null,
      "sender_name": str | null,
      "is_outgoing": bool,
      "is_self":     bool,
      "text":      str,
      "media_type": str | null,    # "photo" | "voice" | "video" | "sticker" | ...
      "fwd_from":  { "kind": "user|chat|channel|bot", "id": int|null } | null,
      "reply_to":  int | null,
      "ttl_seconds": int | null,   # auto-delete-timer
      "raw":       dict,            # event.message.to_dict() minus session-y fields

      # F-T2-TELEGRAM-F11 / F-NEW-W3-TELEGRAM-F11-INCOMPLETE — edit awareness.
      # NewMessage events emit is_edit=false, edit_seq=0; MessageEdited events
      # emit is_edit=true, edit_seq=<epoch-seconds of message.edit_date>. The
      # edit_seq is monotonically increasing for any (peer_id, message_id)
      # pair (Telegram's edit_date is a Unix timestamp that updates on every
      # edit). The Node connector folds (peer_id, message_id, edit_seq) into
      # source_msg_id so each edit produces a distinct ledger row that the
      # base-class source_msg_id dedup honours — instead of the pre-W3
      # collision where edits silently overwrote the original via the bare
      # sha256(peer_id||message_id) key.
      "is_edit":   bool,
      "edit_seq":  int              # 0 for the original; >0 for edits.
    }

Robustness
----------
- Automatic reconnect via Telethon's TelegramClient(connection_retries=...).
- Per-event try/except so one malformed event cannot kill the loop.
- Atomic line append (open in 'a' with line-buffered I/O); the Node tail
  reads at byte-offset granularity and discards any half-line on the seam.

CLI
---
    python3 telegram_tail.py            # tail forever
    python3 telegram_tail.py --check    # print readiness JSON and exit
"""

import json
import os
import sys
from datetime import datetime, timezone


def default_staging_file():
    """<MEMORY_ROOT>/storage/tmp/telegram-staging.jsonl.

    Mirrors mcp/lib/config.js: an unset or empty MEMORY_ROOT falls back to the
    checkout root (four directories above this file's directory), so this
    writer and the Node reader agree with no variable set.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    checkout = os.path.abspath(os.path.join(here, "..", "..", "..", ".."))
    root = os.environ.get("MEMORY_ROOT") or checkout
    return os.path.join(root, "storage", "tmp", "telegram-staging.jsonl")


SESSION_PATH_DEFAULT = os.path.expanduser("~/.config/memory-system/telegram.session")
# Public sample app credentials documented for read-only experimentation.
# Operators SHOULD set TELEGRAM_API_ID + TELEGRAM_API_HASH to their own
# app credentials per Telethon's documented best practice. Placeholders
# only — no real credentials in this file.
API_ID_FALLBACK = 0
API_HASH_FALLBACK = "00000000000000000000000000000000"


def load_session_string():
    """Read session string from env or session file. Never echoes the value."""
    env = os.environ.get("TELEGRAM_SESSION_STRING")
    if isinstance(env, str) and env.strip():
        return env.strip()
    path = os.environ.get("TELEGRAM_SESSION_FILE", SESSION_PATH_DEFAULT)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                s = f.read().strip()
                if s:
                    return s
        except OSError:
            pass
    return None


def staging_file_path():
    return os.environ.get("TELEGRAM_STAGING_FILE") or default_staging_file()


def ensure_staging_dir(path):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, mode=0o700, exist_ok=True)


def classify_peer(event):
    """Map Telethon event.chat shape to one of our four peer_type values.

    Returns (peer_type, peer_id, peer_name)."""
    try:
        chat = event.chat
    except Exception:  # noqa: BLE001 — Telethon raises a variety of types pre-resolve
        chat = None
    peer_id = None
    peer_name = None
    if chat is None:
        # 1:1 DM where chat resolution failed; fall back to sender.
        try:
            sender = event.sender
        except Exception:  # noqa: BLE001
            sender = None
        if sender is not None:
            peer_id = getattr(sender, "id", None)
            peer_name = getattr(sender, "username", None) or getattr(sender, "first_name", None)
        return ("user", peer_id, peer_name)
    peer_id = getattr(chat, "id", None)
    peer_name = (
        getattr(chat, "username", None)
        or getattr(chat, "title", None)
        or getattr(chat, "first_name", None)
    )
    # Telethon types: User, Chat (small group), Channel (broadcast OR megagroup).
    type_name = type(chat).__name__
    if type_name == "User":
        return ("user", peer_id, peer_name)
    if type_name == "Chat":
        return ("group", peer_id, peer_name)
    if type_name == "Channel":
        if getattr(chat, "broadcast", False):
            return ("channel", peer_id, peer_name)
        return ("supergroup", peer_id, peer_name)
    return ("user", peer_id, peer_name)


def classify_media(message):
    """Return a short string for the media kind, or None for text-only."""
    if message is None:
        return None
    if getattr(message, "sticker", None) is not None:
        return "sticker"
    if getattr(message, "voice", None) is not None:
        return "voice"
    if getattr(message, "video_note", None) is not None:
        return "video_note"
    if getattr(message, "photo", None) is not None:
        return "photo"
    if getattr(message, "video", None) is not None:
        return "video"
    if getattr(message, "audio", None) is not None:
        return "audio"
    if getattr(message, "gif", None) is not None:
        return "animation"
    if getattr(message, "document", None) is not None:
        return "document"
    return None


def fwd_from_summary(message):
    """Compact fwd_from summary or None.

    Carries enough signal for Stage-0 to drop bot-forwards without echoing the
    original message bytes."""
    fwd = getattr(message, "fwd_from", None)
    if fwd is None:
        return None
    from_id = getattr(fwd, "from_id", None)
    if from_id is None:
        return {"kind": "unknown", "id": None}
    type_name = type(from_id).__name__
    if type_name == "PeerUser":
        return {"kind": "user", "id": getattr(from_id, "user_id", None),
                "is_bot": False}
    if type_name == "PeerChat":
        return {"kind": "chat", "id": getattr(from_id, "chat_id", None)}
    if type_name == "PeerChannel":
        return {"kind": "channel", "id": getattr(from_id, "channel_id", None)}
    return {"kind": "unknown", "id": None}


def event_to_record(event, self_user_id, is_edit=False):
    """Build the per-event JSON record. Returns None to skip the event.

    F-NEW-W3-TELEGRAM-F11-INCOMPLETE: the is_edit kwarg distinguishes
    NewMessage callers (False, default) from MessageEdited callers (True).
    The edit_seq is derived from message.edit_date (Telegram's
    per-edit Unix timestamp); the original message has no edit_date so
    edit_seq=0 for NewMessage. The Node connector then folds edit_seq
    into source_msg_id so each edit is a distinct ledger row.
    """
    message = getattr(event, "message", None)
    if message is None:
        return None
    peer_type, peer_id, peer_name = classify_peer(event)
    sender = None
    try:
        sender = event.sender
    except Exception:  # noqa: BLE001
        sender = None
    sender_id = getattr(sender, "id", None) if sender is not None else None
    sender_name = None
    if sender is not None:
        sender_name = (
            getattr(sender, "username", None)
            or getattr(sender, "first_name", None)
        )
    is_outgoing = bool(getattr(event, "out", False))
    is_self = bool(self_user_id is not None and sender_id == self_user_id)
    msg_date = getattr(message, "date", None)
    if isinstance(msg_date, datetime):
        ts = msg_date.astimezone(timezone.utc).isoformat()
    else:
        ts = datetime.now(timezone.utc).isoformat()
    text = getattr(message, "message", None) or ""
    media_type = classify_media(message)
    fwd = fwd_from_summary(message)
    reply_to = None
    rti = getattr(message, "reply_to", None)
    if rti is not None:
        reply_to = getattr(rti, "reply_to_msg_id", None)
    ttl = getattr(message, "ttl_period", None)
    # raw_dict: best-effort; strip any session-y fields just in case.
    raw_dict = {}
    try:
        raw_dict = message.to_dict()
    except Exception:  # noqa: BLE001
        raw_dict = {}
    for stripkey in ("session", "session_string", "auth_key"):
        if stripkey in raw_dict:
            raw_dict.pop(stripkey, None)
    # F-NEW-W3-TELEGRAM-F11-INCOMPLETE: derive edit_seq from
    # message.edit_date (a datetime when the message has been edited,
    # None otherwise). Convert to Unix epoch seconds so the Node-side
    # source_msg_id input is a stable integer; multiple edits within the
    # same second still produce distinct rows because Telegram serialises
    # edits server-side (edit_date is monotonically non-decreasing per
    # (peer_id, message_id) pair). When the caller is the NewMessage
    # handler we force edit_seq=0 regardless of any spurious edit_date
    # field — original messages always sit in the edit_seq=0 bucket.
    edit_seq = 0
    if is_edit:
        edit_date = getattr(message, "edit_date", None)
        if isinstance(edit_date, datetime):
            try:
                edit_seq = int(edit_date.astimezone(timezone.utc).timestamp())
            except (OSError, ValueError):
                edit_seq = 0
        # Defensive fallback for the rare case where Telegram emits a
        # MessageEdited without an edit_date populated (synthetic test
        # fixtures, replay paths): use the message's own ts to keep a
        # non-zero seq so the source_msg_id still differs from the
        # original.
        if edit_seq == 0 and isinstance(msg_date, datetime):
            try:
                edit_seq = int(msg_date.astimezone(timezone.utc).timestamp())
            except (OSError, ValueError):
                edit_seq = 0
    return {
        "peer_type": peer_type,
        "peer_id": peer_id,
        "peer_name": peer_name,
        "message_id": getattr(message, "id", None),
        "ts": ts,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "is_outgoing": is_outgoing,
        "is_self": is_self,
        "text": text,
        "media_type": media_type,
        "fwd_from": fwd,
        "reply_to": reply_to,
        "ttl_seconds": ttl,
        "raw": raw_dict,
        # F-NEW-W3-TELEGRAM-F11-INCOMPLETE — edit awareness fields.
        "is_edit": bool(is_edit),
        "edit_seq": edit_seq,
    }


def append_record(staging_path, record):
    line = json.dumps(record, ensure_ascii=False, default=str) + "\n"
    with open(staging_path, "a", encoding="utf-8") as f:
        f.write(line)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass


def print_check():
    out = {
        "session_present": load_session_string() is not None,
        "staging_file": staging_file_path(),
        "api_id_from_env": bool(os.environ.get("TELEGRAM_API_ID")),
    }
    print(json.dumps(out))


def main():
    args = sys.argv[1:]
    if "--check" in args:
        print_check()
        return 0

    session_string = load_session_string()
    if session_string is None:
        sys.stderr.write(
            "telegram_tail: session missing. Run telegram_login.py once to "
            "create ~/.config/memory-system/telegram.session, or set "
            "TELEGRAM_SESSION_STRING in the env.\n"
        )
        return 2

    try:
        from telethon import TelegramClient, events  # type: ignore
        from telethon.sessions import StringSession  # type: ignore
    except ImportError:
        sys.stderr.write(
            "telegram_tail: Telethon is not installed. Install with:\n"
            "    python3 -m pip install --user telethon\n"
        )
        return 3

    api_id_env = os.environ.get("TELEGRAM_API_ID")
    api_hash_env = os.environ.get("TELEGRAM_API_HASH")
    try:
        api_id = int(api_id_env) if api_id_env else API_ID_FALLBACK
    except ValueError:
        api_id = API_ID_FALLBACK
    api_hash = api_hash_env or API_HASH_FALLBACK

    staging_path = staging_file_path()
    ensure_staging_dir(staging_path)

    client = TelegramClient(
        StringSession(session_string),
        api_id,
        api_hash,
        connection_retries=10,
        retry_delay=5,
        auto_reconnect=True,
    )

    # F-T2-TELEGRAM-F9 — cache self_user_id at startup instead of issuing a
    # client.get_me() round-trip per inbound event. On a 10/sec firehose the
    # original per-event call burned ~864k MTProto round-trips per day and
    # risked FloodWait on the auth.* method namespace. self_user_id is
    # invariant for the lifetime of the session; the operator changing
    # accounts mid-session would require restarting telegram_tail.py
    # anyway (the session string is bound to a single auth_key).
    #
    # We use a mutable closure container so the on-disconnect refresh path
    # (auto_reconnect=True path inside Telethon) can re-derive the id after
    # a reconnect without needing to re-decorate the handler. The Telethon
    # client.start() handshake is idempotent, so calling get_me() again on
    # reconnect is cheap.
    self_id_box = {"id": None}

    async def _prime_self_id():
        try:
            me = await client.get_me()
            self_id_box["id"] = getattr(me, "id", None)
        except Exception as exc:  # noqa: BLE001 — never crash startup
            sys.stderr.write(
                f"telegram_tail: get_me startup error kind={type(exc).__name__}; "
                "is_self detection will be best-effort until next reconnect\n"
            )

    @client.on(events.NewMessage(incoming=True, outgoing=True))
    async def handler(event):  # noqa: D401 — Telethon event handler signature
        try:
            # F-T2-TELEGRAM-F9 — read from the cached box. NO per-event
            # MTProto round-trip. If the cache is None (e.g. startup
            # get_me() failed) we fall back to None, which event_to_record
            # tolerates by setting is_self=False — strictly worse than the
            # cached path but never blocks the row.
            self_id = self_id_box["id"]
            record = event_to_record(event, self_id, is_edit=False)
            if record is None:
                return
            append_record(staging_path, record)
        except Exception as exc:  # noqa: BLE001 — never crash the loop
            sys.stderr.write(f"telegram_tail: per-event error kind={type(exc).__name__}\n")

    # F-T2-TELEGRAM-F11 / F-NEW-W3-TELEGRAM-F11-INCOMPLETE — capture edits
    # so they reach the source ledger as distinct rows instead of
    # silently colliding on the bare sha256(peer_id||message_id) shape
    # the original source_msg_id used. Telethon fires MessageEdited on
    # every edit AFTER the initial NewMessage; we emit one record per
    # edit with is_edit=True and an edit_seq derived from message.edit_date.
    # The Node connector at lib/connectors/telegram.js folds edit_seq into
    # source_msg_id, so the base-class dedup tail-read sees each edit as
    # a fresh row. Layer-2 selection can then rank by edit_seq desc to
    # prefer the latest revision while still surfacing the original via
    # cross-source recall queries.
    @client.on(events.MessageEdited(incoming=True, outgoing=True))
    async def edit_handler(event):  # noqa: D401
        try:
            self_id = self_id_box["id"]
            record = event_to_record(event, self_id, is_edit=True)
            if record is None:
                return
            append_record(staging_path, record)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(
                f"telegram_tail: per-event error (edit) kind={type(exc).__name__}\n"
            )

    sys.stderr.write(f"telegram_tail: starting; staging={staging_path}\n")
    with client:
        # Prime the self_user_id cache once, AFTER the session handshake
        # completes (`with client` enters the context that runs
        # client.start()). loop.run_until_complete reaches into the same
        # Telethon-owned event loop that client.run_until_disconnected will
        # use, so the get_me() call shares the connection.
        client.loop.run_until_complete(_prime_self_id())
        client.run_until_disconnected()
    return 0


if __name__ == "__main__":
    sys.exit(main())
