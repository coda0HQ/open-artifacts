#!/usr/bin/env python3
"""Idempotently patch skill-creator's run_eval.py across all local plugin copies.

Background
----------
The skill-creator eval tool (`run_eval.py`) decides whether a skill "triggered"
by checking if the temp command name `{skill_name}-skill-{unique_id}` appears in
the Skill tool_use input. But when the skill is ALSO installed normally (e.g.
under `~/.claude/skills/`), Claude calls it by its REAL registered name
(`using-open-artifacts`), not the temp command name. The temp name is never a
substring of the real name, so every correct trigger is recorded as a miss.
This silently breaks description-optimization: run_loop sees ~0 triggers and
collapses back to the original description, regardless of quality.

A second issue compounds it: the default `--timeout 30` is too short for skills
that take ~15-35s to trigger (the model reads the skill before calling it),
so slow-but-correct triggers are also recorded as misses.

This script patches both issues across every active (non-.bak) run_eval.py copy
under `~/.claude/plugins/`. It is idempotent: re-running on already-patched
copies is a no-op. Run it again after a plugin upgrade overwrites the copies.

Usage
-----
    python3 scripts/patch-skill-creator-eval.py          # patch all copies
    python3 scripts/patch-skill-creator-eval.py --check  # report drift, no writes
    python3 scripts/patch-skill-creator-eval.py --revert # restore unpatched

Not a substitute for the upstream fix — file or track the upstream PR at
https://github.com/anthropics/claude-plugins-official (path:
plugins/skill-creator/skills/skill-creator/scripts/run_eval.py).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

PLUGIN_ROOT = Path.home() / ".claude" / "plugins"

# Snippets to find (unpatched) and their patched replacements. Kept verbatim
# so the transform is a plain str.replace — no regex, no line-number drift.

HELPER_ANCHOR = (
    '    unique_id = uuid.uuid4().hex[:8]\n'
    '    clean_name = f"{skill_name}-skill-{unique_id}"\n'
    '    project_commands_dir = Path(project_root) / ".claude" / "commands"\n'
    '    command_file = project_commands_dir / f"{clean_name}.md"\n'
)
HELPER_NEW = HELPER_ANCHOR + '''
    def _matches_skill(value: str) -> bool:
        # Accept either the real registered skill name or the temp command
        # name. When the skill is also installed (e.g. ~/.claude/skills/),
        # the model calls it by its real name rather than the temp command
        # name, so requiring clean_name alone records every correct trigger
        # as a miss.
        if not isinstance(value, str) or not value:
            return False
        return value == skill_name or value == clean_name
'''

STREAM_OLD = '''                        elif se_type == "content_block_delta" and pending_tool_name:
                            delta = se.get("delta", {})
                            if delta.get("type") == "input_json_delta":
                                accumulated_json += delta.get("partial_json", "")
                                if clean_name in accumulated_json:
                                    return True

                        elif se_type in ("content_block_stop", "message_stop"):
                            if pending_tool_name:
                                return clean_name in accumulated_json
                            if se_type == "message_stop":
                                return False
'''
STREAM_NEW = '''                        elif se_type == "content_block_delta" and pending_tool_name:
                            delta = se.get("delta", {})
                            if delta.get("type") == "input_json_delta":
                                accumulated_json += delta.get("partial_json", "")
                                try:
                                    parsed = json.loads(accumulated_json)
                                    if _matches_skill(parsed.get("skill")):
                                        return True
                                except json.JSONDecodeError:
                                    if clean_name in accumulated_json:
                                        return True

                        elif se_type in ("content_block_stop", "message_stop"):
                            if pending_tool_name:
                                try:
                                    parsed = json.loads(accumulated_json)
                                    if _matches_skill(parsed.get("skill")):
                                        return True
                                except json.JSONDecodeError:
                                    pass
                                return clean_name in accumulated_json
                            if se_type == "message_stop":
                                return False
'''

FALLBACK_OLD = '''                            if tool_name == "Skill" and clean_name in tool_input.get("skill", ""):
                                triggered = True
                            elif tool_name == "Read" and clean_name in tool_input.get("file_path", ""):
                                triggered = True
                            return triggered
'''
FALLBACK_NEW = '''                            if tool_name == "Skill" and _matches_skill(tool_input.get("skill")):
                                triggered = True
                            elif tool_name == "Read" and clean_name in tool_input.get("file_path", ""):
                                triggered = True
                            return triggered
'''

# Match the default-timeout arg on a single line (not the run_loop copy).
TIMEOUT_OLD = 'default=30, help="Timeout per query in seconds"'
TIMEOUT_NEW = 'default=90, help="Timeout per query in seconds"'

TRANSFORMS = [
    (HELPER_ANCHOR, HELPER_NEW),
    (STREAM_OLD, STREAM_NEW),
    (FALLBACK_OLD, FALLBACK_NEW),
    (TIMEOUT_OLD, TIMEOUT_NEW),
]


def find_copies(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return [p for p in root.rglob("run_eval.py") if ".bak" not in str(p)]


def status_of(path: Path) -> str:
    """Return 'patched', 'unpatched', or 'unknown' for a copy."""
    try:
        s = path.read_text()
    except OSError:
        return "unknown"
    if "_matches_skill" in s:
        return "patched"
    if HELPER_ANCHOR in s and FALLBACK_OLD in s:
        return "unpatched"
    return "unknown"


def patch_copy(path: Path, check: bool) -> str:
    st = status_of(path)
    if st == "patched":
        return "already-patched"
    if st != "unpatched":
        return f"skip({st})"  # drifted from expected base; needs manual review
    if check:
        return "would-patch"
    s = path.read_text()
    orig = s
    for old, new in TRANSFORMS:
        if old not in s:
            return f"anchor-missing({old[:40]!r}) -- manual review"
        s = s.replace(old, new, 1)
    if s == orig:
        return "no-change"
    path.write_text(s)
    return "patched"


def revert_copy(path: Path, check: bool) -> str:
    st = status_of(path)
    if st != "patched":
        return f"skip({st})"
    if check:
        return "would-revert"
    s = path.read_text()
    orig = s
    for new, old in TRANSFORMS:  # swap direction
        if old not in s:
            return f"patched-anchor-missing({new[:40]!r})"
        s = s.replace(old, new, 1)
    if s == orig:
        return "no-change"
    path.write_text(s)
    return "reverted"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "")
    ap.add_argument("--check", action="store_true", help="report status only, no writes")
    ap.add_argument("--revert", action="store_true", help="restore unpatched versions")
    ap.add_argument(
        "--root", default=str(PLUGIN_ROOT),
        help=f"plugins root (default: {PLUGIN_ROOT})",
    )
    args = ap.parse_args(argv)

    root = Path(args.root)
    copies = find_copies(root)
    if not copies:
        print(f"no run_eval.py copies under {root}", file=sys.stderr)
        return 1

    rc = 0
    action = "revert" if args.revert else "patch"
    fn = revert_copy if args.revert else (lambda p, c: patch_copy(p, c))
    for p in copies:
        res = fn(p, args.check)
        print(f"{res:20} {p}")
        if "missing" in res or "skip(unknown)" in res:
            rc = 1
    print(f"\n{action} complete ({len(copies)} copies examined, check={args.check})")
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
