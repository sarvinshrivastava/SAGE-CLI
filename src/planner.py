"""Command planners for the shell assistant."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence, Literal

import httpx


class PlannerError(RuntimeError):
    """Raised when the planner cannot produce a valid command."""


@dataclass
class PlannerTurn:
    """Represents one command execution cycle for planner feedback."""

    suggested_command: str
    executed_command: str
    stdout: str
    stderr: str
    exit_code: int


@dataclass
class PlannerSuggestion:
    """Structured planner response indicating the chosen interaction mode."""

    mode: Literal["command", "chat"]
    command: Optional[str] = None
    message: Optional[str] = None


def parse_planner_reply(content: str) -> PlannerSuggestion:
    """Parse the planner's response into a structured suggestion."""

    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", content, flags=re.IGNORECASE)
    cleaned = cleaned.strip()

    data = _parse_first_json(cleaned)
    if data is None:
        raise PlannerError(f"Could not parse JSON command from response: {cleaned[:200]}")

    suggestion = _build_suggestion_from_dict(data)
    if suggestion is not None:
        return suggestion

    raise PlannerError(f"Planner response missing required fields: {data}")


def _parse_first_json(cleaned: str) -> Optional[dict]:
    candidates: List[str] = []

    if cleaned.startswith("{") and cleaned.endswith("}"):
        candidates.append(cleaned)

    fence_blocks = re.findall(r"```(?:json)?\s*([\s\S]*?)```", cleaned)
    candidates.extend(block.strip() for block in fence_blocks if block.strip())

    for match in re.finditer(r"\{[\s\S]*?\}", cleaned):
        snippet = match.group(0).strip()
        if snippet not in candidates:
            candidates.append(snippet)

    if not candidates:
        candidates.append(cleaned)

    for candidate in candidates:
        normalized = candidate
        if normalized.lower().startswith("json"):
            normalized = normalized[4:].strip()
        try:
            data = json.loads(normalized)
        except json.JSONDecodeError:
            repaired = _repair_simple_command_json(normalized)
            if repaired is None:
                continue
            try:
                data = json.loads(repaired)
            except json.JSONDecodeError:
                continue

        if isinstance(data, dict):
            return data

    return None


def _build_suggestion_from_dict(data: dict) -> Optional[PlannerSuggestion]:
    mode_value = data.get("mode")
    if isinstance(mode_value, str):
        mode = mode_value.strip().lower()
    else:
        mode = None

    if mode == "command" or (mode is None and "command" in data):
        command_value = data.get("command")
        if isinstance(command_value, str) and command_value.strip():
            return PlannerSuggestion(mode="command", command=command_value.strip())
        return None

    if mode == "chat":
        message_value = data.get("message") or data.get("response") or data.get("answer")
        if isinstance(message_value, str) and message_value.strip():
            return PlannerSuggestion(mode="chat", message=message_value.strip())
        return None

    return None


def _repair_simple_command_json(fragment: str) -> Optional[str]:
    match = re.search(r'"command"\s*:\s*([^\s"}][^}\n]*)', fragment)
    if not match:
        return None
    value = match.group(1).strip().rstrip('"').rstrip(',')
    if not value:
        return None
    repaired = re.sub(
        r'"command"\s*:\s*([^\s"}][^}\n]*)', f'"command": "{value}"', fragment, count=1
    )
    return repaired


def normalize_command_text(command: Optional[str]) -> Optional[str]:
    if not isinstance(command, str):
        return None
    normalized = re.sub(r"\s+", " ", command).strip()
    return normalized or None


def is_repeated_failure(candidate: Optional[str], history: Sequence[PlannerTurn]) -> bool:
    if len(history) < 2 or not candidate:
        return False

    last = history[-1]
    prev = history[-2]
    if last.exit_code == 0 or prev.exit_code == 0:
        return False

    normalized_candidate = normalize_command_text(candidate)
    if normalized_candidate is None:
        return False

    last_exec = normalize_command_text(last.executed_command)
    prev_exec = normalize_command_text(prev.executed_command)
    if last_exec is None or prev_exec is None:
        return False

    if normalized_candidate != last_exec or last_exec != prev_exec:
        return False

    return True


def build_repeat_feedback(history: Sequence[PlannerTurn]) -> dict:
    last = history[-1]
    prev = history[-2]
    command_display = normalize_command_text(last.executed_command) or last.executed_command
    note = (
        "AGENT_NOTE: The command '{cmd}' failed twice consecutively with exit codes "
        "{prev_code} and {last_code}. Provide a different next command that diagnoses the "
        "failure or prepares any missing prerequisites. Do not repeat the same command."
    ).format(
        cmd=command_display,
        prev_code=prev.exit_code,
        last_code=last.exit_code,
    )
    return {"role": "user", "content": json.dumps({"agent_note": note})}


class CommandPlanner:
    """Base interface all planners must implement."""

    def suggest(self, goal: str, history: Optional[Iterable[PlannerTurn]] = None) -> PlannerSuggestion:
        raise NotImplementedError


class MockCommandPlanner(CommandPlanner):
    """Fallback planner mirroring Phase 1 behavior."""

    def suggest(self, goal: str, history: Optional[Iterable[PlannerTurn]] = None) -> PlannerSuggestion:
        return PlannerSuggestion(mode="command", command=f"echo Mock planner received goal: {goal}")


class OpenRouterPlanner(CommandPlanner):
    """Command planner powered by OpenRouter-hosted models."""

    def __init__(
        self,
        model: Optional[str] = None,
        timeout: Optional[float] = None,
        api_key: Optional[str] = None,
        referer: Optional[str] = None,
        title: Optional[str] = None,
        base_url: Optional[str] = None,
    ) -> None:
        self.model = model or os.getenv(
            "OPENROUTER_MODEL", "deepseek/deepseek-r1-0528-qwen3-8b:free"
        )
        self.timeout = self._resolve_timeout(timeout)
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        if not self.api_key:
            raise PlannerError(
                "OpenRouter API key missing; set OPENROUTER_API_KEY or use --planner-api-key"
            )
        self.base_url = base_url or os.getenv(
            "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1/chat/completions"
        )
        self.referer = referer or os.getenv("OPENROUTER_SITE_URL")
        self.title = title or os.getenv("OPENROUTER_SITE_NAME")

    def suggest(self, goal: str, history: Optional[Iterable[PlannerTurn]] = None) -> str:
        history_list: List[PlannerTurn] = list(history) if history else []
        base_messages = self._build_messages(goal, history_list)
        messages = list(base_messages)

        for attempt in range(2):
            payload = self._chat(messages)
            content = self._extract_content(payload)
            suggestion = parse_planner_reply(content)
            if suggestion.mode != "command":
                return suggestion
            if not is_repeated_failure(suggestion.command, history_list):
                return suggestion

            if attempt == 0:
                guard_feedback = build_repeat_feedback(history_list)
                messages = list(base_messages) + [guard_feedback]
                continue

            raise PlannerError("Planner suggested a command that already failed twice consecutively")

        raise PlannerError("Planner could not provide a non-repeated command")

    def _chat(self, messages: List[dict]) -> dict:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self.referer:
            headers["HTTP-Referer"] = self.referer
        if self.title:
            headers["X-Title"] = self.title

        body = {
            "model": self.model,
            "messages": messages,
        }

        try:
            response = httpx.post(
                self.base_url,
                headers=headers,
                json=body,
                timeout=self.timeout,
            )
        except httpx.HTTPError as exc:
            raise PlannerError(f"Failed to contact OpenRouter service: {exc}") from exc

        if response.status_code != 200:
            raise PlannerError(
                f"OpenRouter returned status {response.status_code}: {response.text}"
            )

        try:
            data = response.json()
        except ValueError as exc:
            raise PlannerError(
                f"Invalid JSON response from OpenRouter: {response.text[:200]}"
            ) from exc

        return data

    def _extract_content(self, payload: dict) -> str:
        if "error" in payload:
            raise PlannerError(f"OpenRouter error: {payload['error']}")

        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise PlannerError("OpenRouter response missing choices array")

        first_choice = choices[0]
        if not isinstance(first_choice, dict):
            raise PlannerError("OpenRouter response contained unexpected choice format")

        message = first_choice.get("message")
        if not isinstance(message, dict):
            raise PlannerError("OpenRouter response missing message content")

        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise PlannerError("OpenRouter message content was empty")

        return content

    def _build_messages(self, goal: str, history: Optional[Iterable[PlannerTurn]]) -> List[dict]:
        system_prompt = (
            "You are an expert Linux system administrator. The user provides a high-level goal. "
            "Your task is to help user in achieveing its high-level goal. "
            "Reply with ONLY JSON using one of the schemas: "
            "{\"mode\": \"command\", \"command\": \"...\"} or {\"mode\": \"chat\", \"message\": \"...\"}. "
            "Use chat mode for informational answers or clarifications; use command mode to provide the next shell command to execute. "
            "When returning commands prefer stable tooling such as apt-get over apt to avoid CLI warnings. "
            "If the previous command failed (exit_code != 0) you must suggest a follow-up diagnostic or remediation command, must NOT return DONE, and must avoid repeating an identical command that already failed. "
            "Only respond with {\"mode\": \"command\", \"command\": \"DONE\"} after confirming the goal is satisfied."
        )
        messages: List[dict] = [
            {"role": "system", "content": system_prompt},
        ]

        if history:
            for turn in history:
                messages.append(
                    {
                        "role": "assistant",
                        "content": json.dumps({"command": turn.suggested_command}),
                    }
                )
                messages.append(
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "executed_command": turn.executed_command,
                                "stdout": turn.stdout,
                                "stderr": turn.stderr,
                                "exit_code": turn.exit_code,
                            }
                        ),
                    }
                )

        messages.append({"role": "user", "content": goal})
        return messages

    @staticmethod
    def _resolve_timeout(provided: Optional[float]) -> float:
        if provided is not None:
            return provided
        env_timeout = os.getenv("OPENROUTER_TIMEOUT")
        if env_timeout:
            try:
                return float(env_timeout)
            except ValueError:
                pass
        return 120.0

def create_planner(name: Optional[str] = None, **kwargs) -> CommandPlanner:
    """Factory for planners, parametrized via CLI/env."""

    selected = (name or os.getenv("AGENT_PLANNER", "openrouter")).lower()
    if selected == "mock":
        return MockCommandPlanner()
    if selected in {"openrouter", "open-router"}:
        return OpenRouterPlanner(**kwargs)
    raise PlannerError(f"Unknown planner: {selected}")
