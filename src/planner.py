"""Command planners for the shell assistant.

Phase 2 introduces an Ollama-backed planner with a shared interface so we
can swap implementations later (e.g., OpenAI, Anthropic).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence

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


class CommandPlanner:
    """Base interface all planners must implement."""

    def suggest(self, goal: str, history: Optional[Iterable[PlannerTurn]] = None) -> str:
        raise NotImplementedError


class MockCommandPlanner(CommandPlanner):
    """Fallback planner mirroring Phase 1 behavior."""

    def suggest(self, goal: str, history: Optional[Iterable[PlannerTurn]] = None) -> str:
        return f"echo Mock planner received goal: {goal}"


class OllamaPlanner(CommandPlanner):
    """Command planner powered by a local Ollama model."""

    def __init__(
        self,
        model: Optional[str] = None,
        api_url: Optional[str] = None,
        timeout: Optional[float] = None,
        providers: Optional[List[str]] = None,
    ) -> None:
        self.model = model or os.getenv("OLLAMA_MODEL", "qwen2.5vl:3b")  # Default to a capable model if none specified
        base_url = api_url or os.getenv("OLLAMA_API_URL", "http://localhost:11434")
        self.url = f"{base_url.rstrip('/')}/api/chat"
        self.timeout = self._resolve_timeout(timeout)
        self.providers = providers or self._resolve_providers()

    def suggest(self, goal: str, history: Optional[Iterable[PlannerTurn]] = None) -> str:
        history_list: List[PlannerTurn] = list(history) if history else []
        base_messages = self._build_messages(goal, history_list)
        messages = list(base_messages)

        for attempt in range(2):
            payload = self._chat(messages)
            content: Optional[str] = None
            if isinstance(payload, dict):
                if "message" in payload:
                    message = payload.get("message")
                    if isinstance(message, dict):
                        content = message.get("content")
                if content is None and "messages" in payload:
                    messages_payload = payload.get("messages")
                    if isinstance(messages_payload, list) and messages_payload:
                        last_message = messages_payload[-1]
                        if isinstance(last_message, dict):
                            content = last_message.get("content")
            if not isinstance(content, str):
                raise PlannerError("Ollama response missing textual content")

            command = self._extract_command(content)
            if not self._is_repeated_failure(command, history_list):
                return command

            if attempt == 0:
                guard_feedback = self._build_repeat_feedback(history_list)
                messages = list(base_messages) + [guard_feedback]
                continue

            raise PlannerError("Planner suggested a command that already failed twice consecutively")

        raise PlannerError("Planner could not provide a non-repeated command")

    def _chat(self, messages: List[dict]) -> dict:
        body = {
            "model": self.model,
            "messages": messages,
            "stream": False,
        }
        if self.providers:
            body["providers"] = self.providers
        options = self._build_options()
        if options:
            body["options"] = options

        try:
            response = httpx.post(
                self.url,
                json=body,
                timeout=self.timeout,
            )
        except httpx.HTTPError as exc:
            raise PlannerError(f"Failed to contact Ollama server: {exc}") from exc

        if response.status_code != 200:
            raise PlannerError(f"Ollama returned status {response.status_code}: {response.text}")

        try:
            return response.json()
        except ValueError as exc:
            raise PlannerError(f"Invalid JSON response from Ollama: {response.text[:200]}") from exc

    def _build_messages(self, goal: str, history: Optional[Iterable[PlannerTurn]]) -> List[dict]:
        system_prompt = (
            "You are an expert Linux system administrator. The user provides a high-level goal. "
            "Your task is to help user in achieveing its high-level goal. "
            "Reply with ONLY JSON using the schema {\"command\": \"...\"}. "
            "Return a single executable command per response. Prefer stable tooling such as apt-get over apt when managing packages to avoid CLI warnings. "
            "If the previous command failed (exit_code != 0) you must suggest a follow-up diagnostic or remediation command, must NOT return DONE, and must avoid repeating an identical command that already failed. "
            "Only respond with {\"command\": \"DONE\"} after confirming the goal is satisfied."
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

    def _extract_command(self, content: str) -> str:
        """Parse the command string from the model response."""

        cleaned = re.sub(r"<think>[\s\S]*?</think>", "", content, flags=re.IGNORECASE)
        cleaned = cleaned.strip()

        direct_match = re.search(r'"command"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"', cleaned)
        if direct_match:
            return direct_match.group(1).strip()

        fallback_match = re.search(r'"command"\s*:\s*([^\s"}][^}\n]*)', cleaned)
        if fallback_match:
            value = fallback_match.group(1).strip().rstrip('"').rstrip(',')
            if value:
                return value

        candidates = []

        fence_blocks = re.findall(r"```(?:json)?\s*([\s\S]*?)```", cleaned)
        candidates.extend(block.strip() for block in fence_blocks if block.strip())

        if not candidates:
            candidates.append(cleaned)

        for match in re.finditer(r"\{[\s\S]*?\}", cleaned):
            snippet = match.group(0).strip()
            if snippet not in candidates:
                candidates.append(snippet)

        for candidate in candidates:
            normalized = candidate
            if normalized.lower().startswith("json"):
                normalized = normalized[4:].strip()
            try:
                data = json.loads(normalized)
            except json.JSONDecodeError:
                repaired = self._repair_simple_json(normalized)
                if repaired is None:
                    continue
                try:
                    data = json.loads(repaired)
                except json.JSONDecodeError:
                    continue

            command = data.get("command")
            if isinstance(command, str) and command.strip():
                return command.strip()

        raise PlannerError(f"Could not parse JSON command from response: {cleaned[:200]}")

    @staticmethod
    def _repair_simple_json(fragment: str) -> Optional[str]:
        match = re.search(r'"command"\s*:\s*([^\s"}][^}\n]*)', fragment)
        if not match:
            return None
        value = match.group(1).strip().rstrip('"').rstrip(',')
        if not value:
            return None
        repaired = re.sub(r'"command"\s*:\s*([^\s"}][^}\n]*)', f'"command": "{value}"', fragment, count=1)
        return repaired

    @staticmethod
    def _resolve_timeout(provided: Optional[float]) -> float:
        if provided is not None:
            return provided
        env_timeout = os.getenv("OLLAMA_TIMEOUT")
        if env_timeout:
            try:
                return float(env_timeout)
            except ValueError:
                pass
        return 120.0

    @staticmethod
    def _resolve_providers() -> Optional[List[str]]:
        env_value = os.getenv("OLLAMA_PROVIDERS")
        if not env_value:
            return None
        providers = [item.strip() for item in env_value.split(",") if item.strip()]
        return providers or None

    def _build_options(self) -> dict:
        options = {}
        if os.getenv("OLLAMA_TEMPERATURE") is not None:
            try:
                options["temperature"] = float(os.getenv("OLLAMA_TEMPERATURE"))
            except ValueError:
                pass
        if os.getenv("OLLAMA_SEED") is not None:
            try:
                options["seed"] = int(os.getenv("OLLAMA_SEED"))
            except ValueError:
                pass
        return options

    @staticmethod
    def _normalize_command_text(command: Optional[str]) -> Optional[str]:
        if not isinstance(command, str):
            return None
        normalized = re.sub(r"\s+", " ", command).strip()
        return normalized or None

    def _is_repeated_failure(self, candidate: str, history: Sequence[PlannerTurn]) -> bool:
        if len(history) < 2:
            return False

        last = history[-1]
        prev = history[-2]
        if last.exit_code == 0 or prev.exit_code == 0:
            return False

        normalized_candidate = self._normalize_command_text(candidate)
        if normalized_candidate is None:
            return False

        last_exec = self._normalize_command_text(last.executed_command)
        prev_exec = self._normalize_command_text(prev.executed_command)
        if last_exec is None or prev_exec is None:
            return False

        if normalized_candidate != last_exec or last_exec != prev_exec:
            return False

        return True

    def _build_repeat_feedback(self, history: Sequence[PlannerTurn]) -> dict:
        last = history[-1]
        prev = history[-2]
        command_display = self._normalize_command_text(last.executed_command) or last.executed_command
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


def create_planner(name: Optional[str] = None, **kwargs) -> CommandPlanner:
    """Factory for planners, parametrized via CLI/env."""

    selected = (name or os.getenv("AGENT_PLANNER", "ollama")).lower()
    if selected == "mock":
        return MockCommandPlanner()
    if selected == "ollama":
        return OllamaPlanner(**kwargs)
    raise PlannerError(f"Unknown planner: {selected}")
