"""Phase 4 shell assistant.

Provides a REPL that accepts a goal, retrieves command suggestions from
a planner, allows the user to edit each command before execution, and
streams results while buffering them for multi-step feedback loops until
the planner signals completion.
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import subprocess
import threading
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from prompt_toolkit import PromptSession
from rich.console import Console

from config import AppConfig
from planner import CommandPlanner, PlannerError, PlannerTurn, PlannerSuggestion, create_planner
from session import SessionManager

@dataclass
class CommandResult:
    """Captures suggested vs executed command details for history."""

    suggested_command: str
    executed_command: str
    stdout: List[str]
    stderr: List[str]
    returncode: int
    risk_level: str


def stream_process_output(process: subprocess.Popen, console: Console) -> tuple[List[str], List[str], int, str]:
    """Stream stdout/stderr to console while buffering them for later use."""

    stdout_buffer: List[str] = []
    stderr_buffer: List[str] = []

    def reader(stream, buffer, style: str) -> None:
        for line in iter(stream.readline, ""):
            buffer.append(line)
            console.print(line.rstrip("\n"), style=style)
        stream.close()

    threads = [
        threading.Thread(target=reader, args=(process.stdout, stdout_buffer, "green"), daemon=True),
        threading.Thread(target=reader, args=(process.stderr, stderr_buffer, "red"), daemon=True),
    ]

    for thread in threads:
        thread.start()

    process.wait()

    for thread in threads:
        thread.join()

    executed = " ".join(process.args) if isinstance(process.args, list) else str(process.args)
    return stdout_buffer, stderr_buffer, process.returncode, executed


def execute_command(command: str, suggested: str, risk_level: str, console: Console) -> CommandResult:
    """Execute a shell command with live output streaming."""

    console.print()
    console.print(f"[cyan]Executing:[/cyan] {command}")
    process = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    stdout_buffer, stderr_buffer, returncode, executed = stream_process_output(process, console)
    console.print(f"[magenta]Exit code:[/magenta] {returncode}")
    console.print()
    return CommandResult(
        suggested_command=suggested,
        executed_command=executed,
        stdout=stdout_buffer,
        stderr=stderr_buffer,
        returncode=returncode,
        risk_level=risk_level,
    )

def compress_output(lines: List[str], max_chars: int = 4000) -> str:
    """Join lines into a bounded string for planner feedback."""

    joined = "".join(lines)
    if len(joined) <= max_chars:
        return joined
    return joined[-max_chars:]


def prompt_for_command(session: PromptSession, suggestion: str, console: Console) -> Optional[str]:
    """Prompt the user to edit or accept the suggested command."""

    while True:
        try:
            user_input = session.prompt("Command> ", default=suggestion)
        except (KeyboardInterrupt, EOFError):
            console.print("Command entry cancelled.")
            return None

        if not user_input.strip():
            console.print("Command skipped.")
            return None

        return user_input


def setup_logging(log_path: Optional[str]) -> logging.Logger:
    """Configure a file-based logger for runtime telemetry."""

    logger = logging.getLogger("agent_shell")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)

    if log_path:
        target_path = Path(log_path)
    else:
        default_dir = Path(os.getenv("AGENT_LOG_DIR", "logs"))
        target_path = default_dir / "agent_shell.log"

    if not target_path.is_absolute():
        target_path = Path.cwd() / target_path

    target_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(str(target_path), encoding="utf-8")

    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.propagate = False
    return logger


def ensure_not_root(allow_root: bool, console: Console) -> None:
    """Exit if running as root unless explicitly allowed."""

    geteuid = getattr(os, "geteuid", None)
    if callable(geteuid):
        try:
            if geteuid() == 0 and not allow_root:
                console.print(
                    "[red]Refusing to run as root. Use --allow-root or AGENT_ALLOW_ROOT=1 if you understand the risk.[/red]"
                )
                sys.exit(1)
        except OSError:
            pass


HIGH_RISK_PATTERNS = [
    r"rm\s+-rf\s+/",
    r":\(\)\s*{",
    r"\bdd\s+if=",
    r"\bmkfs\.",
    r">\s*/dev/sd[0-9a-z]",
    r"\bwipefs\b",
    r"\b(poweroff|shutdown|reboot|halt)\b",
    r"\buserdel\b",
    r"\bmkpart\b",
]

MEDIUM_RISK_PATTERNS = [
    r"\bsudo\b",
    r"\bapt(-get)?\s+remove\b",
    r"\bchown\s+-R\b",
    r"\bchmod\s+777\b",
    r"\bsystemctl\s+(stop|restart)\s+",
    r"\bkill\s+-9\b",
]


def assess_command_risk(command: str) -> str:
    """Classify a command into low/medium/high risk buckets."""

    normalized = command.lower()
    for pattern in HIGH_RISK_PATTERNS:
        if re.search(pattern, normalized):
            return "high"
    for pattern in MEDIUM_RISK_PATTERNS:
        if re.search(pattern, normalized):
            return "medium"
    return "low"


def handle_command_risk(
    risk_level: str,
    command: str,
    session: PromptSession,
    console: Console,
    safety_disabled: bool,
) -> bool:
    """Warn or block execution based on assessed risk level."""

    if safety_disabled or risk_level == "low":
        return True

    if risk_level == "medium":
        console.print()
        console.print("[yellow]Medium-risk command detected. Review before executing.[/yellow]")
        return True

    console.print()
    console.print("[red]High-risk command requires explicit confirmation.[/red]")
    console.print(command)
    console.print("Type 'proceed' to run or anything else to cancel.")
    try:
        response = session.prompt("High-risk confirmation> ")
    except (KeyboardInterrupt, EOFError):
        console.print("[red]High-risk command cancelled.[/red]")
        return False

    if response.strip().lower() != "proceed":
        console.print("[red]Command aborted.[/red]")
        return False
    return True


def render_goal_summary(console: Console, goal: str, history: List[CommandResult], status: str) -> None:
    """Print a concise goal summary."""

    if not history:
        return

    console.print()
    console.print(f"Goal summary ({status}):")
    for idx, result in enumerate(history, start=1):
        outcome = "ok" if result.returncode == 0 else "fail"
        console.print(
            f"  {idx}. {truncate_command(result.suggested_command)}"
            f" | exit {result.returncode}"
            f" | risk {result.risk_level.upper()}"
            f" | {outcome}"
        )


def truncate_command(command: str, limit: int = 80) -> str:
    if len(command) <= limit:
        return command
    return command[: limit - 3] + "..."


def load_environment() -> None:
    """Load variables from a .env file if present."""

    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    env_path = os.path.abspath(env_path)
    if not os.path.exists(env_path):
        return

    try:
        with open(env_path, "r", encoding="utf-8") as env_file:
            for line in env_file:
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if "=" not in stripped:
                    continue
                key, value = stripped.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())
    except OSError as exc:
        # Non-fatal; just log to stderr via console later if needed.
        print(f"Warning: failed to read .env file: {exc}")


def main() -> None:
    load_environment()
    parser = argparse.ArgumentParser(description="Phase 4 AI shell assistant")
    parser.add_argument(
        "--planner",
        dest="planner_name",
        help="Planner backend to use (openrouter, mock)",
    )
    parser.add_argument(
        "--planner-timeout",
        dest="planner_timeout",
        type=float,
        help="Override planner request timeout in seconds",
    )
    parser.add_argument("--planner-model", dest="planner_model", help="Override planner model identifier")
    parser.add_argument("--planner-api-key", dest="planner_api_key", help="Override planner API key")
    parser.add_argument("--planner-referer", dest="planner_referer", help="HTTP referer for OpenRouter requests")
    parser.add_argument("--planner-title", dest="planner_title", help="X-Title header for OpenRouter requests")
    parser.add_argument(
        "--planner-base-url",
        dest="planner_base_url",
        help="Override planner base URL (useful for OpenRouter proxies)",
    )
    parser.add_argument("--config", dest="config_path", help="Path to JSON configuration file")
    parser.add_argument("--session-id", help="Override the session identifier used for persistence")
    parser.add_argument("--session-dir", help="Directory to store session logs (default: sessions)")
    parser.add_argument("--no-persist", action="store_true", help="Disable session persistence")
    parser.add_argument(
        "--persist",
        action="store_true",
        help="Force-enable session persistence even if disabled in config",
    )
    parser.add_argument("--allow-root", action="store_true", help="Allow running as root (unsafe)")
    parser.add_argument("--safety-off", action="store_true", help="Disable safety risk checks")
    parser.add_argument("--log-file", dest="log_file", help="Write runtime logs to the given file")
    args = parser.parse_args()

    config = AppConfig.load(args.config_path)

    console = Console()
    log_path = args.log_file or os.getenv("AGENT_LOG_FILE")
    logger = setup_logging(log_path)

    allow_root = args.allow_root or os.getenv("AGENT_ALLOW_ROOT", "0") == "1"
    ensure_not_root(allow_root, console)

    safety_disabled = args.safety_off or os.getenv("AGENT_DISABLE_SAFETY", "0") == "1"
    if safety_disabled:
        console.print("[yellow]Safety checks disabled for this run.[/yellow]")
        logger.warning("Safety checks disabled")

    session = PromptSession()

    session_dir = args.session_dir or os.getenv("AGENT_SESSION_DIR") or config.session_dir
    persist = config.session_persist
    if args.no_persist:
        persist = False
    if args.persist:
        persist = True

    session_manager = SessionManager.initialize(session_dir, args.session_id, persist)
    console.print(f"[cyan]{session_manager.describe()}[/cyan]")
    logger.info(
        "Session initialized id=%s persist=%s dir=%s",
        session_manager.session_id,
        session_manager.enabled,
        session_dir,
    )
    if session_manager.enabled:
        console.print("[cyan]Use ':new' to start a new session, ':session' to show info.[/cyan]")

    planner_name = args.planner_name or config.planner.backend
    planner_kwargs: Dict[str, object] = config.planner.to_kwargs()

    if args.planner_timeout is not None:
        planner_kwargs["timeout"] = args.planner_timeout
    if args.planner_model is not None:
        planner_kwargs["model"] = args.planner_model
    if args.planner_api_key is not None:
        planner_kwargs["api_key"] = args.planner_api_key
    if args.planner_referer is not None:
        planner_kwargs["referer"] = args.planner_referer
    if args.planner_title is not None:
        planner_kwargs["title"] = args.planner_title
    if args.planner_base_url is not None:
        planner_kwargs["base_url"] = args.planner_base_url

    try:
        planner: CommandPlanner = create_planner(planner_name, **planner_kwargs)
    except PlannerError as exc:
        console.print(f"[red]Failed to initialize planner: {exc}[/red]")
        logger.error("Planner initialization failed: %s", exc)
        return

    console.print("[bold green]Phase 4 AI Shell Assistant[/bold green]")
    console.print("Type a goal or 'exit' to quit.\n")
    logger.info("Planner ready backend=%s kwargs=%s", planner_name, planner_kwargs)

    while True:
        try:
            goal = session.prompt("Goal> ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\nGoodbye.")
            logger.info("User exited shell")
            break

        if not goal:
            continue

        if goal.lower() in {"exit", "quit", "e", "q"}:
            console.print("Exiting.")
            logger.info("User command exit")
            break

        if goal.startswith(":"):
            meta = goal[1:].strip().lower()
            if meta in {"new", "new-session", "newsession"}:
                session_manager = session_manager.start_new()
                console.print(f"[cyan]Started new session: {session_manager.session_id}[/cyan]")
                logger.info("Started new session id=%s", session_manager.session_id)
            elif meta in {"session", "info"}:
                console.print(f"[cyan]{session_manager.describe()}[/cyan]")
                logger.info("Session info requested")
            else:
                console.print(f"Unknown meta command: {meta}")
                logger.warning("Unknown meta command: %s", meta)
            continue

        logger.info("Goal started: %s", goal)
        goal_history: List[CommandResult] = []
        failure_counts: Dict[str, int] = {}
        planner_error_msg: Optional[str] = None
        user_cancelled = False
        planner_completed = False
        conversation_messages: List[str] = []

        while True:
            try:
                planner_history = build_planner_history(goal_history)
                planner_reply = planner.suggest(goal, planner_history)
            except PlannerError as exc:
                console.print(f"[red]Planner error:[/red] {exc}")
                planner_error_msg = str(exc)
                logger.error("Planner error during goal '%s': %s", goal, exc)
                break

            if planner_reply.mode == "chat":
                message = planner_reply.message or ""
                console.print()
                console.print(f"[green]Assistant:[/green] {message}")
                logger.info("Planner chat response: %s", message)
                conversation_messages.append(message)
                planner_completed = True
                break

            command_suggestion = (planner_reply.command or "").strip()
            if not command_suggestion:
                console.print("[red]Planner returned an empty command.")
                planner_error_msg = "empty command"
                logger.error("Planner returned empty command for goal '%s'", goal)
                break

            normalized = command_suggestion.upper()
            if normalized == "DONE":
                last_return_code = goal_history[-1].returncode if goal_history else 0
                if last_return_code == 0:
                    console.print("Planner indicated task completion.")
                    planner_completed = True
                    break
                console.print()
                console.print(
                    "[yellow]Planner attempted to finish despite a failing command. Requesting another command...[/yellow]"
                )
                continue

            suggestion_key = command_suggestion.strip()
            if failure_counts.get(suggestion_key):
                console.print()
                console.print(
                    f"[yellow]Command previously failed {failure_counts[suggestion_key]} time(s); edit before rerunning.[/yellow]"
                )
                logger.warning("Repeated failing command suggestion: %s", suggestion_key)

            console.print()
            console.print("[blue]Suggested command ready in prompt (blank to skip).[/blue]")

            final_command = prompt_for_command(session, command_suggestion, console)
            if final_command is None:
                user_cancelled = True
                logger.info("Command skipped by user")
                break

            risk_level = assess_command_risk(final_command)
            if not handle_command_risk(risk_level, final_command, session, console, safety_disabled):
                user_cancelled = True
                logger.warning("High-risk command aborted: %s", final_command)
                break

            logger.info("Executing command risk=%s: %s", risk_level, final_command)
            result = execute_command(final_command, command_suggestion, risk_level, console)
            goal_history.append(result)
            logger.info(
                "Command finished exit=%s risk=%s", result.returncode, result.risk_level
            )

            if result.returncode != 0:
                failure_counts[suggestion_key] = failure_counts.get(suggestion_key, 0) + 1
                logger.warning(
                    "Command failure exit=%s suggestion=%s", result.returncode, suggestion_key
                )

            continue

        if goal_history or planner_error_msg or user_cancelled or conversation_messages:
            status = determine_status(goal_history, planner_completed, planner_error_msg, user_cancelled)
            metadata: Dict[str, object] = {
                "planner_completed": planner_completed,
                "user_cancelled": user_cancelled,
            }
            if planner_error_msg:
                metadata["planner_error"] = planner_error_msg
            if failure_counts:
                metadata["failure_counts"] = failure_counts
            if goal_history:
                metadata["risk_levels"] = [res.risk_level for res in goal_history]
            if conversation_messages:
                metadata["conversation"] = conversation_messages
            if safety_disabled:
                metadata["safety_disabled"] = True

            serialized_steps = [serialize_result(result) for result in goal_history]
            session_manager.record_goal(goal, serialized_steps, status, metadata)
            render_goal_summary(console, goal, goal_history, status)
            logger.info("Goal completed status=%s", status)
        else:
            logger.info("No action taken for goal: %s", goal)


def build_planner_history(results: List[CommandResult]) -> List[PlannerTurn]:
    """Convert prior command results into planner-friendly history."""

    turns: List[PlannerTurn] = []
    failure_tally: Dict[str, int] = {}
    for result in results:
        notes: List[str] = []
        if result.returncode != 0:
            key = result.suggested_command.strip()
            failure_tally[key] = failure_tally.get(key, 0) + 1
            if failure_tally[key] > 1:
                notes.append(f"AGENT_NOTE: command has failed {failure_tally[key]} times.")
        if result.risk_level in {"medium", "high"}:
            notes.append(f"AGENT_NOTE: risk_level={result.risk_level.upper()}")

        stdout_text = compress_output(result.stdout)
        stderr_text = compress_output(result.stderr)
        if notes:
            note_block = "\n".join(notes)
            stderr_text = f"{stderr_text}\n{note_block}" if stderr_text else note_block

        turns.append(
            PlannerTurn(
                suggested_command=result.suggested_command,
                executed_command=result.executed_command,
                stdout=stdout_text,
                stderr=stderr_text,
                exit_code=result.returncode,
            )
        )
    return turns


def serialize_result(result: CommandResult) -> Dict[str, object]:
    """Convert a command result into a JSON-serializable dict."""

    return {
        "suggested_command": result.suggested_command,
        "executed_command": result.executed_command,
        "stdout": "".join(result.stdout),
        "stderr": "".join(result.stderr),
        "exit_code": result.returncode,
        "risk_level": result.risk_level,
    }


def determine_status(
    history: List[CommandResult],
    planner_completed: bool,
    planner_error: Optional[str],
    user_cancelled: bool,
) -> str:
    """Derive a human-readable status for a goal run."""

    if planner_error:
        return "planner_error"
    if user_cancelled and not history:
        return "cancelled"
    if planner_completed and history and history[-1].returncode == 0:
        return "completed"
    if history and history[-1].returncode != 0:
        return "failed"
    if user_cancelled:
        return "cancelled"
    if planner_completed:
        return "completed"
    if history:
        return "incomplete"
    return "no_action"


if __name__ == "__main__":
    main()
