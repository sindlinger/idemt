#!/usr/bin/env python3
import argparse
import os
import re
import subprocess
import sys
import time


def tmux_capture(pane: str) -> str:
    result = subprocess.run(
        ["tmux", "capture-pane", "-pt", pane, "-J"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return result.stdout


def follow_file(path: str):
    while True:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                while True:
                    line = f.readline()
                    if line:
                        yield line
                    else:
                        time.sleep(0.1)
        except FileNotFoundError:
            time.sleep(0.2)


def colorize(line: str) -> str:
    if "] SYS " in line:
        return f"\x1b[38;5;244m{line}\x1b[0m"
    if "] IN " in line:
        return f"\x1b[38;5;75m{line}\x1b[0m"
    if "] OUT " in line:
        return f"\x1b[38;5;214m{line}\x1b[0m"
    if re.search(r"ERROR|Error|error", line):
        return f"\x1b[38;5;196m{line}\x1b[0m"
    return line


def run_tail(path: str, deep: bool) -> int:
    for line in follow_file(path):
        sys.stdout.write(colorize(line) if deep else line)
        sys.stdout.flush()
    return 0


def run_mirror(
    pane: str,
    start_line: int,
    end_line: int,
    start_col: int,
    end_col: int,
    interval: float,
) -> int:
    try:
        sys.stdout.write("\x1b[?25l")
        sys.stdout.flush()
        while True:
            content = tmux_capture(pane).splitlines()
            slice_lines = content[start_line - 1 : end_line]
            output_lines = []
            for line in slice_lines:
                if len(line) < start_col - 1:
                    output_lines.append("")
                else:
                    output_lines.append(line[start_col - 1 : end_col])
            sys.stdout.write("\x1b[H\x1b[J")
            sys.stdout.write("\n".join(output_lines))
            sys.stdout.flush()
            time.sleep(interval)
    finally:
        sys.stdout.write("\x1b[?25h")
        sys.stdout.flush()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["tail", "deep", "mirror"], default="tail")
    parser.add_argument("--log-path", required=False, default="")
    parser.add_argument("--source-pane", required=False, default="")
    parser.add_argument("--start-line", type=int, default=1)
    parser.add_argument("--end-line", type=int, default=24)
    parser.add_argument("--start-col", type=int, default=1)
    parser.add_argument("--end-col", type=int, default=80)
    parser.add_argument("--interval", type=float, default=0.1)
    args = parser.parse_args()

    if args.mode == "mirror":
        if not args.source_pane:
            print("mirror mode requires --source-pane", file=sys.stderr)
            return 1
        return run_mirror(
            args.source_pane,
            args.start_line,
            args.end_line,
            args.start_col,
            args.end_col,
            args.interval,
        )

    if not args.log_path:
        print("tail/deep mode requires --log-path", file=sys.stderr)
        return 1
    return run_tail(args.log_path, deep=args.mode == "deep")


if __name__ == "__main__":
    raise SystemExit(main())
