#!/usr/bin/env python3
"""telegram_login.py — One-time interactive Telethon login.

Prompts the operator for phone + verification code + (optional) 2FA password,
then writes a Telethon StringSession to ~/.config/memory-system/telegram.session
with 0600 permissions.

Key/secret discipline:
- The session string is written to disk only; NEVER printed to stdout.
- API id/hash come from env (TELEGRAM_API_ID, TELEGRAM_API_HASH).
- This script is interactive by design; run it once from the operator's
  terminal, not from the launchd-managed daemon.

Async note: Telethon's TelegramClient methods (connect / is_user_authorized /
send_code_request / sign_in / disconnect) are COROUTINES. They MUST be awaited
inside an asyncio loop — calling them bare returns an un-awaited coroutine, which
is truthy, so `if not client.is_user_authorized()` silently skips the whole sign-
in flow and saves an UNAUTHENTICATED session. We run the flow under asyncio.run()
and only write the session after confirming is_user_authorized() is truly True.
"""

import asyncio
import getpass
import os
import sys


SESSION_PATH_DEFAULT = os.path.expanduser("~/.config/memory-system/telegram.session")


async def _authenticate(api_id, api_hash, phone):
    """Run the interactive auth flow; return the session string ONLY if the
    client ends up genuinely authorized, else raise."""
    from telethon import TelegramClient  # type: ignore
    from telethon.sessions import StringSession  # type: ignore
    from telethon.errors import SessionPasswordNeededError  # type: ignore

    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            await client.send_code_request(phone)
            code = input("Verification code: ").strip()
            try:
                await client.sign_in(phone=phone, code=code)
            except SessionPasswordNeededError:
                password = getpass.getpass("2FA password: ")
                await client.sign_in(password=password)
        # HARD guard: never persist a session that is not actually authorized.
        if not await client.is_user_authorized():
            raise RuntimeError("authentication did not complete (not authorized)")
        return client.session.save()
    finally:
        await client.disconnect()


def main():
    try:
        import telethon  # type: ignore  # noqa: F401
    except ImportError:
        sys.stderr.write(
            "telegram_login: Telethon is not installed. Install with:\n"
            "    python3 -m pip install --user telethon\n"
        )
        return 3

    api_id_env = os.environ.get("TELEGRAM_API_ID")
    api_hash_env = os.environ.get("TELEGRAM_API_HASH")
    if not api_id_env or not api_hash_env:
        sys.stderr.write(
            "telegram_login: set TELEGRAM_API_ID and TELEGRAM_API_HASH in env.\n"
            "Create credentials at https://my.telegram.org -> API development tools.\n"
        )
        return 2
    try:
        api_id = int(api_id_env)
    except ValueError:
        sys.stderr.write("telegram_login: TELEGRAM_API_ID must be an integer.\n")
        return 2
    api_hash = api_hash_env

    session_path = os.environ.get("TELEGRAM_SESSION_FILE", SESSION_PATH_DEFAULT)
    session_dir = os.path.dirname(session_path)
    if session_dir and not os.path.isdir(session_dir):
        os.makedirs(session_dir, mode=0o700, exist_ok=True)

    phone = input("Phone number (international, e.g. +15555550123): ").strip()
    if not phone:
        sys.stderr.write("telegram_login: phone is required.\n")
        return 2

    try:
        session_string = asyncio.run(_authenticate(api_id, api_hash, phone))
    except Exception as e:  # noqa: BLE001 — surface the real failure, write nothing
        sys.stderr.write(f"telegram_login: login FAILED ({e}); no session written.\n")
        return 1

    # Write at 0600 atomically: write-tmp + rename.
    tmp = session_path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, session_string.encode("utf-8"))
        try:
            os.fsync(fd)
        except OSError:
            pass
    finally:
        os.close(fd)
    os.replace(tmp, session_path)

    sys.stderr.write(f"telegram_login: session written to {session_path} (0600)\n")
    sys.stderr.write("telegram_login: do NOT share or commit this file.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
