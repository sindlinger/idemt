#!/usr/bin/env python3
import os
import pty
import shlex
import sys
import time


def now_ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def write_log(log_file, tag: str, data: str) -> None:
    log_file.write(f"[{now_ts()}] {tag} {data}")
    log_file.flush()


def main() -> int:
    log_path = os.environ.get(
        "CODEX_LOG_PATH",
        "/mnt/c/Users/pichau/AppData/Roaming/mt5ide/logs/codex-live.txt",
    )
    cmd = os.environ.get("CODEX_CMD", "codex")
    argv = shlex.split(cmd)
    if not argv:
        print("CODEX_CMD is empty.", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    log_file = open(log_path, "a", buffering=1, encoding="utf-8", errors="replace")
    write_log(log_file, "SYS", f"START cmd={cmd} cwd={os.getcwd()}\n")

    def read_master(fd):
        data = os.read(fd, 1024)
        if data:
            write_log(log_file, "OUT", data.decode("utf-8", errors="replace"))
        return data

    def read_stdin(fd):
        data = os.read(fd, 1024)
        if data:
            write_log(log_file, "IN", data.decode("utf-8", errors="replace"))
        return data

    try:
        return pty.spawn(argv, master_read=read_master, stdin_read=read_stdin)
    finally:
        write_log(log_file, "SYS", "END\n")
        log_file.close()


if __name__ == "__main__":
    raise SystemExit(main())
