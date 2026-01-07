#!/usr/bin/env python3
import argparse
import os
import shlex
import subprocess
import sys


def run_tmux(args, capture=False):
    result = subprocess.run(
        ["tmux"] + args,
        check=False,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        text=True,
    )
    if capture:
        return result.returncode, (result.stdout or "").strip()
    return result.returncode, ""


def tmux_get(option, default=""):
    code, value = run_tmux(["show", "-gv", option], capture=True)
    if code != 0:
        return default
    return value or default


def tmux_set(option, value):
    run_tmux(["set", "-g", option, value])


def build_log_cmd(script_dir, mode, log_path, source_pane, start_line, end_line, start_col, end_col, interval):
    script = os.path.join(script_dir, "codex_log_pane.py")
    args = [
        "python3",
        script,
        "--mode",
        mode,
    ]
    if mode in ("tail", "deep"):
        args += ["--log-path", log_path]
    else:
        args += [
            "--source-pane",
            source_pane,
            "--start-line",
            str(start_line),
            "--end-line",
            str(end_line),
            "--start-col",
            str(start_col),
            "--end-col",
            str(end_col),
            "--interval",
            str(interval),
        ]
    return " ".join(shlex.quote(a) for a in args)


def ensure_session(
    session,
    codex_cmd,
    log_path,
    log_mode,
    log_w,
    log_h,
    mirror_x,
    mirror_y,
    mirror_w,
    mirror_h,
    mirror_interval,
    restart,
    script_dir,
    no_popup,
):
    if restart:
        run_tmux(["kill-session", "-t", session])

    if run_tmux(["has-session", "-t", session])[0] == 0:
        run_tmux(["attach", "-t", session])
        return

    if log_mode == "deep":
        codex_run = f"CODEX_LOG_PATH={shlex.quote(log_path)} CODEX_CMD={shlex.quote(codex_cmd)} python3 {shlex.quote(os.path.join(script_dir, 'codex-pty-log.py'))}"
    else:
        codex_run = f"script -q -f -a {shlex.quote(log_path)} -c {shlex.quote(codex_cmd)}"

    run_tmux(["new-session", "-d", "-s", session, "-n", "main", "bash"])
    base_index = tmux_get("base-index", "0")
    win_target = f"{session}:{base_index}"
    run_tmux(["send-keys", "-t", win_target, codex_run, "C-m"])
    run_tmux(["set", "-g", "mouse", "on"])

    code, main_pane = run_tmux(["display-message", "-p", "-t", win_target, "#{pane_id}"], capture=True)
    if code != 0 or not main_pane:
        print("failed to detect main pane", file=sys.stderr)
        return

    tmux_set("@codex_session", session)
    tmux_set("@codex_window", win_target)
    tmux_set("@codex_main_pane", main_pane)
    tmux_set("@codex_log_w", str(log_w))
    tmux_set("@codex_log_h", str(log_h))
    tmux_set("@codex_log_mode", log_mode)
    tmux_set("@codex_log_path", log_path)
    tmux_set("@codex_mirror_x", str(mirror_x))
    tmux_set("@codex_mirror_y", str(mirror_y))
    tmux_set("@codex_mirror_w", str(mirror_w))
    tmux_set("@codex_mirror_h", str(mirror_h))
    tmux_set("@codex_mirror_interval", str(mirror_interval))

    popup_cmd = f"python3 {shlex.quote(os.path.join(script_dir, 'codex_tmux.py'))} --popup"
    run_tmux(["bind-key", "-T", "prefix", "L", "run-shell", popup_cmd])
    tmux_set("@codex_popup_cmd", popup_cmd)

    if not no_popup:
        hook_cmd = f"run-shell {shlex.quote(popup_cmd)}"
        run_tmux(["set-hook", "-g", "client-attached", hook_cmd])

    run_tmux(["attach", "-t", session])


def open_popup(script_dir):
    current_session = ""
    code, current_session = run_tmux(["display-message", "-p", "#{session_name}"], capture=True)
    codex_session = tmux_get("@codex_session", "")
    if code != 0 or not current_session or (codex_session and current_session != codex_session):
        return 0

    log_w = int(tmux_get("@codex_log_w", "60"))
    log_h = int(tmux_get("@codex_log_h", "20"))
    log_mode = tmux_get("@codex_log_mode", "deep")
    log_path = tmux_get("@codex_log_path", "")
    main_pane = tmux_get("@codex_main_pane", "")
    mirror_x = int(tmux_get("@codex_mirror_x", "0"))
    mirror_y = int(tmux_get("@codex_mirror_y", "0"))
    mirror_w = int(tmux_get("@codex_mirror_w", str(log_w)))
    mirror_h = int(tmux_get("@codex_mirror_h", str(log_h)))
    mirror_interval = float(tmux_get("@codex_mirror_interval", "0.1"))

    if log_mode == "mirror" and not main_pane:
        return 1

    log_cmd = build_log_cmd(
        script_dir,
        log_mode,
        log_path,
        main_pane,
        mirror_y + 1,
        mirror_y + mirror_h,
        mirror_x + 1,
        mirror_x + mirror_w,
        mirror_interval,
    )

    run_tmux(
        [
            "display-popup",
            "-E",
            "-w",
            str(log_w),
            "-h",
            str(log_h),
            log_cmd,
        ]
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", default=os.environ.get("CODEX_SESSION_NAME", "codex"))
    parser.add_argument("--cmd", dest="codex_cmd", default=os.environ.get("CODEX_CMD", "codex"))
    parser.add_argument("--log-path", default=os.environ.get("CODEX_LOG_PATH", "/mnt/c/Users/pichau/AppData/Roaming/mt5ide/logs/codex-live.txt"))
    parser.add_argument("--log-mode", default=os.environ.get("CODEX_LOG_MODE", "deep"), choices=["tail", "mirror", "deep"])
    parser.add_argument("--log-w", type=int, default=int(os.environ.get("CODEX_LOG_W", "60")))
    parser.add_argument("--log-h", type=int, default=int(os.environ.get("CODEX_LOG_H", "20")))
    parser.add_argument("--mirror-x", type=int, default=int(os.environ.get("CODEX_MIRROR_X", "0")))
    parser.add_argument("--mirror-y", type=int, default=int(os.environ.get("CODEX_MIRROR_Y", "0")))
    parser.add_argument("--mirror-w", type=int, default=int(os.environ.get("CODEX_MIRROR_W", "60")))
    parser.add_argument("--mirror-h", type=int, default=int(os.environ.get("CODEX_MIRROR_H", "20")))
    parser.add_argument("--mirror-interval", type=float, default=float(os.environ.get("CODEX_MIRROR_INTERVAL", "0.1")))
    parser.add_argument("--restart", action="store_true")
    parser.add_argument("--popup", action="store_true")
    parser.add_argument("--no-popup", action="store_true")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    if args.popup:
        return open_popup(script_dir)

    if run_tmux(["-V"], capture=True)[0] != 0:
        print("tmux not available.", file=sys.stderr)
        return 1

    return ensure_session(
        args.session,
        args.codex_cmd,
        args.log_path,
        args.log_mode,
        args.log_w,
        args.log_h,
        args.mirror_x,
        args.mirror_y,
        args.mirror_w,
        args.mirror_h,
        args.mirror_interval,
        args.restart,
        script_dir,
        args.no_popup,
    ) or 0


if __name__ == "__main__":
    raise SystemExit(main())
