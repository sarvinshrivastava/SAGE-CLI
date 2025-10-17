"""Configuration helpers for the AI shell assistant."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class PlannerConfig:
    backend: str
    model: Optional[str]
    timeout: Optional[float]
    providers: Optional[List[str]]

    def to_kwargs(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        if self.model:
            payload["model"] = self.model
        if self.timeout is not None:
            payload["timeout"] = self.timeout
        if self.providers:
            payload["providers"] = self.providers
        return payload


@dataclass
class AppConfig:
    planner: PlannerConfig
    session_dir: Optional[str]
    session_persist: bool

    @classmethod
    def load(cls, path: Optional[str] = None) -> "AppConfig":
        candidate = Path(path or os.getenv("AGENT_CONFIG", "config.json"))
        if not candidate.exists():
            return cls.default()

        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return cls.default()

        planner_data = data.get("planner", {})
        planner = PlannerConfig(
            backend=planner_data.get("backend", "ollama"),
            model=planner_data.get("model"),
            timeout=planner_data.get("timeout"),
            providers=planner_data.get("providers"),
        )

        session_opts = data.get("session", {})
        persist = session_opts.get("persist", True)
        session_dir = session_opts.get("directory")

        return cls(planner=planner, session_dir=session_dir, session_persist=persist)

    @classmethod
    def default(cls) -> "AppConfig":
        return cls(
            planner=PlannerConfig(backend="ollama", model=None, timeout=None, providers=None),
            session_dir=None,
            session_persist=True,
        )