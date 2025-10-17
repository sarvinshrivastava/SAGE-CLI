"""Configuration helpers for the AI shell assistant."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional


@dataclass
class PlannerConfig:
    backend: str
    model: Optional[str]
    timeout: Optional[float]
    api_key: Optional[str]
    referer: Optional[str]
    title: Optional[str]
    base_url: Optional[str]

    def to_kwargs(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        if self.model:
            payload["model"] = self.model
        if self.timeout is not None:
            payload["timeout"] = self.timeout
        if self.api_key:
            payload["api_key"] = self.api_key
        if self.referer:
            payload["referer"] = self.referer
        if self.title:
            payload["title"] = self.title
        if self.base_url:
            payload["base_url"] = self.base_url
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
            backend=planner_data.get("backend", "openrouter"),
            model=planner_data.get("model"),
            timeout=planner_data.get("timeout"),
            api_key=planner_data.get("api_key"),
            referer=planner_data.get("referer"),
            title=planner_data.get("title"),
            base_url=planner_data.get("base_url"),
        )

        session_opts = data.get("session", {})
        persist = session_opts.get("persist", True)
        session_dir = session_opts.get("directory")

        return cls(planner=planner, session_dir=session_dir, session_persist=persist)

    @classmethod
    def default(cls) -> "AppConfig":
        return cls(
            planner=PlannerConfig(
                backend="openrouter",
                model="deepseek/deepseek-r1-0528-qwen3-8b:free",
                timeout=None,
                api_key=None,
                referer=None,
                title=None,
                base_url=None,
            ),
            session_dir=None,
            session_persist=True,
        )