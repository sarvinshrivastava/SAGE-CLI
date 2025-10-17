from __future__ import annotations

import argparse
import difflib
import getpass
import logging
import os
import shlex
import subprocess
import threading
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from prompt_toolkit import PromptSession
from rich.console import Console

from config import AppConfig
from planner import CommandPlanner, PlannerError, PlannerPlan, PlannerTurn, create_planner
from session import SessionManager
from telemetry import TelemetryEmitter
from safety import SafetyDecision, SafetyPolicy

@dataclass
class CommandResult:
    """Captures suggested vs executed command details for history."""

    suggested_command: str
    executed_command: str
    stdout: List[str]
    stderr: List[str]
    returncode: int
    risk_level: str
    context: Dict[str, object]
    safety_notes: Optional[str] = None
    normalized_command: Optional[str] = None
    score: Optional[Dict[str, int]] = None
    plan_step_id: Optional[str] = None
    plan_step_status: Optional[str] = None


@dataclass
class CommandStats:
    successes: int = 0
    failures: int = 0

    def record(self, success: bool) -> None:
        if success:
            self.successes += 1
        else:
            self.failures += 1

    @property
    def score(self) -> int:
        return self.successes - self.failures

    @property
    def total(self) -> int:
        return self.successes + self.failures

    def to_dict(self) -> Dict[str, int]:
        return {
            "successes": self.successes,
            "failures": self.failures,
            "score": self.score,
        }


class CommandScoreboard:
    """Tracks command success/failure balance across the session."""

    def __init__(self) -> None:
        self._scores: Dict[str, CommandStats] = {}

    @staticmethod
    def _normalize(command: str) -> str:
        try:
            parts = shlex.split(command)
        except ValueError:
            parts = command.strip().split()
        normalized = " ".join(parts).strip()
        return normalized or command.strip()

    def analyze(self, command: str) -> tuple[str, Optional[CommandStats]]:
        key = self._normalize(command)
        stats = self._scores.get(key)
        if stats is None:
            return key, None
        return key, CommandStats(successes=stats.successes, failures=stats.failures)

    def record(self, command: str, success: bool) -> tuple[str, CommandStats]:
        key = self._normalize(command)
        stats = self._scores.setdefault(key, CommandStats())
        stats.record(success)
        return key, CommandStats(successes=stats.successes, failures=stats.failures)

    def stats_for_key(self, key: str) -> Optional[CommandStats]:
        stats = self._scores.get(key)
        if stats is None:
            return None
        return CommandStats(successes=stats.successes, failures=stats.failures)


@dataclass
class PlanStepState:
    id: str
    title: Optional[str]
    command: Optional[str]
    description: Optional[str]
    status: str = "pending"
    history_indices: List[int] = field(default_factory=list)

    def label(self) -> str:
        if self.title:
            return self.title
        if self.command:
            return self.command
        return f"Step {self.id}"


@dataclass
class PlanState:
    summary: Optional[str]
    steps: List[PlanStepState]

    def current_step(self) -> Optional[PlanStepState]:
        for step in self.steps:
            if step.status not in {"completed"}:
                return step
        return None

    def get_step(self, step_id: str) -> Optional[PlanStepState]:
        for step in self.steps:
            if step.id == step_id:
                return step
        return None

    def mark_running(self, step_id: str) -> None:
        step = self.get_step(step_id)
        if not step or step.status == "completed":
            return
        step.status = "in_progress"

    def record_result(self, step_id: str, success: bool, history_index: Optional[int]) -> None:
        step = self.get_step(step_id)
        if not step:
            return
        if history_index is not None:
            step.history_indices.append(history_index)
        step.status = "completed" if success else "failed"

    def to_dict(self) -> Dict[str, object]:
        return {
            "summary": self.summary,
            "steps": [
                {
                    "id": step.id,
                    "title": step.title,
                    "command": step.command,
                    "label": step.label(),
                    "description": step.description,
                    "status": step.status,
                    "history": step.history_indices,
                }
                for step in self.steps
            ],
        }
def convert_planner_plan(plan: Optional[PlannerPlan]) -> Optional[PlanState]:
    if plan is None:
        return None
    steps: List[PlanStepState] = []
    for raw in plan.steps:
        status_value = raw.status if isinstance(raw.status, str) else None
        status_clean = status_value.strip().lower() if status_value else "pending"
        steps.append(
            PlanStepState(
                id=raw.id,
                title=raw.title,
                command=raw.command,
                description=raw.description,
                status=status_clean or "pending",
            )
        )
    if not steps:
        return None
    return PlanState(summary=plan.summary, steps=steps)


def render_plan(console: Console, plan: PlanState, header: str = "New plan received") -> None:
    console.print()
    console.print(f"[bold cyan]{header}[/bold cyan]")
    if plan.summary:
        console.print(f"[cyan]Summary:[/cyan] {plan.summary}")
    for step in plan.steps:
        status_color = {
            "pending": "white",
            "in_progress": "yellow",
            "completed": "green",
            "failed": "red",
        }.get(step.status, "white")
        console.print(f"  [{status_color}]{step.id} - {step.label()}[/{status_color}]")
        if step.description:
            console.print(f"     {step.description}")
        if step.command:
            console.print(f"     command: {step.command}")


def render_plan_progress(console: Console, plan: PlanState) -> None:
    render_plan(console, plan, header="Plan progress update")


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


def execute_command(
    command: str,
    suggested: str,
    risk_level: str,
    console: Console,
    risk_notes: Optional[str] = None,
) -> CommandResult:
    """Execute a shell command with live output streaming."""

    console.print()
    console.print(f"[cyan]Executing:[/cyan] {command}")
    started_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    start_time = time.perf_counter()
    process = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    stdout_buffer, stderr_buffer, returncode, executed = stream_process_output(process, console)
    duration = time.perf_counter() - start_time
    console.print(f"[magenta]Exit code:[/magenta] {returncode}")
    console.print()
    context: Dict[str, object] = {
        "command": command,
        "environment": {
            "cwd": os.getcwd(),
            "user": getpass.getuser(),
        },
        "runtime": {
            "started_at": started_at,
            "duration_seconds": round(duration, 4),
            "exit_code": returncode,
        },
    }
    return CommandResult(
        suggested_command=suggested,
        executed_command=executed,
        stdout=stdout_buffer,
        stderr=stderr_buffer,
        returncode=returncode,
        risk_level=risk_level,
        context=context,
        safety_notes=risk_notes,
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


def render_command_review(
    console: Console,
    original: str,
    edited: str,
    decision: SafetyDecision,
    safety_disabled: bool,
    scoreboard: CommandScoreboard,
    plan_step: Optional[PlanStepState],
) -> None:
    """Display diff and risk details for command confirmation."""

    console.print()
    if plan_step:
        console.print(
            f"[cyan]Plan step {plan_step.id}:[/cyan] {plan_step.label()}"
        )
        if plan_step.description:
            console.print(f"[cyan]Description:[/cyan] {plan_step.description}")
        if plan_step.command and plan_step.command != original:
            console.print(f"[cyan]Planned command:[/cyan] {plan_step.command}")

    if original == edited:
        console.print("[green]No changes from planner suggestion.[/green]")
    else:
        console.print("[blue]Diff vs suggestion (green=added, red=removed):[/blue]")
        diff_tokens = difflib.ndiff(original.split(), edited.split())
        formatted: List[str] = []
        for token in diff_tokens:
            if token.startswith("- "):
                formatted.append(f"[red]{token[2:]}[/red]")
            elif token.startswith("+ "):
                formatted.append(f"[green]{token[2:]}[/green]")
            elif token.startswith("? "):
                continue
            else:
                formatted.append(token[2:])
        console.print(" ".join(formatted))

    level = decision.level.lower()
    color = {"high": "red", "medium": "yellow"}.get(level, "green")
    console.print(f"[{color}]Risk level:[/{color}] {decision.level.upper()}")
    if decision.notes:
        note_color = "yellow" if level != "high" else "red"
        console.print(f"[{note_color}]Notes:[/{note_color}] {decision.notes}")
    if safety_disabled:
        console.print("[yellow]Safety checks disabled — risk assessment is informational only.[/yellow]")

    _, prior_stats = scoreboard.analyze(edited)
    if prior_stats and prior_stats.total:
        history_color = "green"
        if prior_stats.failures > prior_stats.successes:
            history_color = "red"
        elif prior_stats.failures == prior_stats.successes:
            history_color = "yellow"
        console.print(
            f"[{history_color}]History:[/{history_color}] {prior_stats.successes} success / {prior_stats.failures} failure"
            f" (score {prior_stats.score})"
        )
        if prior_stats.failures > prior_stats.successes:
            console.print("[yellow]Planner has struggled with this command; consider editing further.[/yellow]")


def prompt_for_action(session: PromptSession, console: Console) -> str:
    """Prompt for accept/edit/skip quick action."""

    console.print("[cyan]Actions:[/cyan] (A)ccept  (E)dit  (S)kip")
    while True:
        try:
            response = session.prompt("Action [A/E/S]> ")
        except (KeyboardInterrupt, EOFError):
            console.print("[red]Command confirmation cancelled.[/red]")
            return "s"
        normalized = response.strip().lower()
        if not normalized:
            return "a"
        if normalized in {"a", "accept"}:
            return "a"
        if normalized in {"e", "edit"}:
            return "e"
        if normalized in {"s", "skip"}:
            return "s"
        console.print("[yellow]Enter A to accept, E to edit, or S to skip.[/yellow]")


def review_command_flow(
    session: PromptSession,
    console: Console,
    suggested: str,
    policy: SafetyPolicy,
    safety_disabled: bool,
    scoreboard: CommandScoreboard,
    plan_step: Optional[PlanStepState],
) -> tuple[Optional[str], Optional[SafetyDecision]]:
    """Interactive confirmation loop with diff display and quick actions."""

    current = suggested
    while True:
        console.print()
        console.print("[blue]Suggested command ready in prompt (blank to skip).[/blue]")
        edited = prompt_for_command(session, current, console)
        if edited is None:
            return None, None
        decision = assess_command_risk(edited, policy)
        render_command_review(
            console,
            suggested,
            edited,
            decision,
            safety_disabled,
            scoreboard,
            plan_step,
        )
        action = prompt_for_action(session, console)
        if action == "a":
            return edited, decision
        if action == "s":
            console.print("[yellow]Command skipped.[/yellow]")
            return None, None
        current = edited


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


OUTPUT_WHITELIST = {"pwd", "ls", "whoami", "cat", "grep", "echo"}


def assess_command_risk(command: str, policy: SafetyPolicy) -> SafetyDecision:
    """Evaluate a command against the active safety policy."""

    return policy.evaluate(command)


def handle_command_risk(
    decision: SafetyDecision,
    command: str,
    session: PromptSession,
    console: Console,
    safety_disabled: bool,
) -> bool:
    """Warn or block execution based on assessed risk level."""

    if safety_disabled:
        return True

    level = decision.level.lower()

    if decision.notes:
        console.print()
        note_color = "yellow" if level != "high" else "red"
        console.print(f"[{note_color}]Safety note:[/{note_color}] {decision.notes}")

    if level == "low" and not decision.require_confirmation:
        return True

    if level == "medium" and not decision.require_confirmation:
        console.print()
        console.print("[yellow]Medium-risk command detected. Review before executing.[/yellow]")
        return True

    console.print()
    if level == "high":
        console.print("[red]High-risk command requires explicit confirmation.[/red]")
    else:
        console.print("[yellow]Safety policy requires explicit confirmation.[/yellow]")
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
    parser.add_argument("--planner-version", dest="planner_version", help="Override planner version string")
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
    parser.add_argument(
        "--safety-policy",
        dest="safety_policy_path",
        help="Path to a JSON or YAML safety policy file",
    )
    parser.add_argument("--log-file", dest="log_file", help="Write runtime logs to the given file")
    parser.add_argument("--telemetry-file", dest="telemetry_file", help="Write structured telemetry events to the given file")
    args = parser.parse_args()

    config = AppConfig.load(args.config_path)

    console = Console()
    log_path = args.log_file or os.getenv("AGENT_LOG_FILE")
    logger = setup_logging(log_path)
    telemetry = TelemetryEmitter.initialize(args.telemetry_file)

    allow_root = args.allow_root or os.getenv("AGENT_ALLOW_ROOT", "0") == "1"
    ensure_not_root(allow_root, console)

    policy_path_override = args.safety_policy_path or os.getenv("AGENT_SAFETY_POLICY")
    try:
        policy = SafetyPolicy.load(policy_path_override or config.safety_policy_path)
    except RuntimeError as exc:
        console.print(f"[yellow]Warning: {exc} Using built-in safety policy instead.[/yellow]")
        logger.warning("Safety policy load failed, using default: %s", exc)
        policy = SafetyPolicy.default()

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
    if args.planner_version is not None:
        planner_kwargs["version"] = args.planner_version
    elif "version" not in planner_kwargs or planner_kwargs.get("version") is None:
        env_version = os.getenv("AGENT_PLANNER_VERSION")
        if env_version:
            planner_kwargs["version"] = env_version
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
    planner_info: Dict[str, Optional[str]] = {
        "backend": planner_name,
        "model": getattr(planner, "model", planner_kwargs.get("model")),
        "version": getattr(planner, "version", planner_kwargs.get("version")),
    }
    planner_info = {key: value for key, value in planner_info.items() if value}

    scoreboard = CommandScoreboard()

    console.print("Type a goal or 'exit' to quit.\n")
    logger.info("Planner ready backend=%s kwargs=%s", planner_name, planner_kwargs)

    while True:
        try:
            goal = session.prompt("User> ").strip()
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
        planner_error_msg: Optional[str] = None
        user_cancelled = False
        planner_completed = False
        conversation_messages: List[str] = []
        active_plan: Optional[PlanState] = None

        while True:
            try:
                planner_history = build_planner_history(goal_history, active_plan)
                planner_reply = planner.suggest(goal, planner_history)
            except PlannerError as exc:
                console.print(f"[red]Planner error:[/red] {exc}")
                planner_error_msg = str(exc)
                logger.error("Planner error during goal '%s': %s", goal, exc)
                break

            if planner_reply.mode == "plan":
                new_plan = convert_planner_plan(planner_reply.plan)
                if new_plan is None:
                    console.print("[yellow]Planner provided a plan without actionable steps. Ignoring.[/yellow]")
                    logger.warning("Planner returned invalid plan payload: %s", planner_reply.plan)
                else:
                    active_plan = new_plan
                    render_plan(console, active_plan)
                    telemetry.emit_plan_created(
                        goal=goal,
                        session_id=session_manager.session_id if session_manager.enabled else None,
                        planner_info=planner_info,
                        plan=active_plan.to_dict(),
                    )
                    logger.info("Planner provided plan with %s steps", len(active_plan.steps))
                continue

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

            normalized_key, prior_stats = scoreboard.analyze(command_suggestion)
            if prior_stats and prior_stats.failures >= max(1, prior_stats.successes):
                console.print()
                console.print(
                    "[yellow]Command history warning:[/yellow] "
                    f"{prior_stats.successes} success / {prior_stats.failures} failure"
                    f" (score {prior_stats.score}). Consider editing before running."
                )
                logger.warning(
                    "Command history negative normalized=%s successes=%s failures=%s",
                    normalized_key,
                    prior_stats.successes,
                    prior_stats.failures,
                )

            active_step = active_plan.current_step() if active_plan else None
            final_command, decision = review_command_flow(
                session,
                console,
                command_suggestion,
                policy,
                safety_disabled,
                scoreboard,
                active_step,
            )
            if final_command is None or decision is None:
                user_cancelled = True
                logger.info("Command skipped by user")
                break

            if not handle_command_risk(decision, final_command, session, console, safety_disabled):
                user_cancelled = True
                logger.warning("Command aborted by safety policy: %s", final_command)
                break

            if active_plan and active_step:
                active_plan.mark_running(active_step.id)

            logger.info("Executing command risk=%s: %s", decision.level, final_command)
            result = execute_command(
                final_command,
                command_suggestion,
                decision.level,
                console,
                risk_notes=decision.notes,
            )
            success = result.returncode == 0
            normalized_command, stats = scoreboard.record(result.executed_command or final_command, success)
            result.normalized_command = normalized_command or (result.executed_command or final_command)
            result.score = stats.to_dict()
            if active_step:
                result.plan_step_id = active_step.id
            goal_history.append(result)
            if active_plan and active_step:
                history_index = len(goal_history) - 1
                active_plan.record_result(active_step.id, success, history_index)
                result.plan_step_status = active_step.status
                render_plan_progress(console, active_plan)
                telemetry.emit_plan_update(
                    goal=goal,
                    session_id=session_manager.session_id if session_manager.enabled else None,
                    planner_info=planner_info,
                    plan=active_plan.to_dict(),
                    step_id=active_step.id,
                    status=active_step.status,
                )
            telemetry.emit_execution(
                goal=goal,
                session_id=session_manager.session_id if session_manager.enabled else None,
                planner_info=planner_info,
                command_event={
                    "command": result.context.get("command", final_command),
                    "suggested_command": result.suggested_command,
                    "executed_command": result.executed_command,
                    "risk_level": result.risk_level,
                    "exit_code": result.returncode,
                    "duration_seconds": result.context.get("runtime", {}).get("duration_seconds"),
                    "started_at": result.context.get("runtime", {}).get("started_at"),
                    "runtime": result.context.get("runtime"),
                    "environment": result.context.get("environment"),
                    "risk_notes": result.safety_notes,
                    "normalized_command": result.normalized_command,
                    "command_score": result.score,
                    "plan_step_id": result.plan_step_id,
                    "plan_step_status": result.plan_step_status,
                },
            )
            logger.info(
                "Command finished exit=%s risk=%s", result.returncode, result.risk_level
            )

            if result.returncode != 0:
                logger.warning(
                    "Command failure exit=%s normalized=%s score=%s",
                    result.returncode,
                    result.normalized_command,
                    result.score,
                )

            continue

        if goal_history or planner_error_msg or user_cancelled or conversation_messages or active_plan:
            status = determine_status(goal_history, planner_completed, planner_error_msg, user_cancelled)
            metadata: Dict[str, object] = {
                "planner_completed": planner_completed,
                "user_cancelled": user_cancelled,
                "planner_info": planner_info,
            }
            if planner_error_msg:
                metadata["planner_error"] = planner_error_msg
            if goal_history:
                metadata["risk_levels"] = [res.risk_level for res in goal_history]
                safety_notes = [res.safety_notes for res in goal_history if res.safety_notes]
                if safety_notes:
                    metadata["safety_notes"] = safety_notes
                score_map = {
                    res.normalized_command: res.score
                    for res in goal_history
                    if res.normalized_command and res.score
                }
                if score_map:
                    metadata["command_scores"] = score_map
            if conversation_messages:
                metadata["conversation"] = conversation_messages
            if safety_disabled:
                metadata["safety_disabled"] = True
            if active_plan:
                metadata["plan"] = active_plan.to_dict()

            serialized_steps = [serialize_result(result) for result in goal_history]
            session_manager.record_goal(goal, serialized_steps, status, metadata)
            render_goal_summary(console, goal, goal_history, status)
            logger.info("Goal completed status=%s", status)
        else:
            logger.info("No action taken for goal: %s", goal)


def build_planner_history(results: List[CommandResult], plan: Optional[PlanState] = None) -> List[PlannerTurn]:
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
        if result.safety_notes:
            notes.append(f"AGENT_NOTE: safety_policy={result.safety_notes}")
        if result.plan_step_id:
            status_label = result.plan_step_status or ("completed" if result.returncode == 0 else "failed")
            notes.append(
                "AGENT_NOTE: plan_step="
                f"{result.plan_step_id} status={status_label}"
            )
        if result.score:
            successes = int(result.score.get("successes", 0))
            failures = int(result.score.get("failures", 0))
            score_value = int(result.score.get("score", successes - failures))
            if failures and failures >= successes:
                notes.append(
                    "AGENT_NOTE: command_history="
                    f"{successes} success/{failures} failure (score {score_value})."
                )

        include_output = should_send_full_output(result)
        if include_output:
            stdout_text = compress_output(result.stdout)
            stderr_text = compress_output(result.stderr)
        else:
            stdout_text = f"Command exit code {result.returncode} (output omitted)."
            stderr_text = ""

        if notes:
            note_block = "\n".join(notes)
            if include_output:
                stderr_text = f"{stderr_text}\n{note_block}" if stderr_text else note_block
            else:
                stdout_text = f"{stdout_text}\n{note_block}" if stdout_text else note_block

        turns.append(
            PlannerTurn(
                suggested_command=result.suggested_command,
                executed_command=result.executed_command,
                stdout=stdout_text,
                stderr=stderr_text,
                exit_code=result.returncode,
            )
        )
    if plan and turns:
        next_step = plan.current_step()
        if next_step:
            pending_label = next_step.label()
            pending_note = (
                "AGENT_NOTE: plan_next="
                f"{next_step.id} status={next_step.status} label={pending_label}"
            )
            last_turn = turns[-1]
            if last_turn.stderr:
                last_turn.stderr = f"{last_turn.stderr}\n{pending_note}"
            else:
                last_turn.stderr = pending_note
    return turns
    


def should_send_full_output(result: CommandResult) -> bool:
    if result.returncode != 0:
        return True
    command = result.executed_command or result.suggested_command
    return is_whitelisted_command(command)


def is_whitelisted_command(command: str) -> bool:
    if not command:
        return False
    try:
        parts = shlex.split(command)
    except ValueError:
        parts = command.strip().split()
    if not parts:
        return False
    base = os.path.basename(parts[0])
    return base in OUTPUT_WHITELIST


def serialize_result(result: CommandResult) -> Dict[str, object]:
    """Convert a command result into a JSON-serializable dict."""

    return {
        "suggested_command": result.suggested_command,
        "executed_command": result.executed_command,
        "stdout": "".join(result.stdout),
        "stderr": "".join(result.stderr),
        "exit_code": result.returncode,
        "risk_level": result.risk_level,
        "context": result.context,
        "safety_notes": result.safety_notes,
        "normalized_command": result.normalized_command,
        "command_score": result.score,
        "plan_step_id": result.plan_step_id,
        "plan_step_status": result.plan_step_status,
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
