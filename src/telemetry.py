"""Structured telemetry utilities for the shell assistant."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional


@dataclass
class TelemetryEmitter:
    """Writes structured telemetry events as line-delimited JSON."""

    path: Path
    enabled: bool

    @classmethod
    def initialize(cls, file_path: Optional[str]) -> "TelemetryEmitter":
        if file_path == "":
            return cls(path=Path("."), enabled=False)

        candidate = file_path or os.getenv("AGENT_TELEMETRY_FILE") or "logs/telemetry.jsonl"
        path = Path(candidate).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        path.parent.mkdir(parents=True, exist_ok=True)
        return cls(path=path, enabled=True)

    def emit(self, payload: Dict[str, Any]) -> None:
        if not self.enabled:
            return
        record = dict(payload)
        record.setdefault("timestamp", datetime.utcnow().isoformat(timespec="seconds") + "Z")
        try:
            with self.path.open("a", encoding="utf-8") as handle:
                json.dump(record, handle, ensure_ascii=True)
                handle.write("\n")
        except OSError:
            # Telemetry is best-effort; ignore write failures silently for now.
            return

    def emit_execution(
        self,
        goal: str,
        session_id: Optional[str],
        planner_info: Dict[str, Any],
        command_event: Dict[str, Any],
    ) -> None:
        if not self.enabled:
            return
        event = {
            "event": "execution",
            "goal": goal,
            "session_id": session_id,
            "planner_info": planner_info,
            **command_event,
        }
        self.emit(event)

    def emit_plan_created(
        self,
        goal: str,
        session_id: Optional[str],
        planner_info: Dict[str, Any],
        plan: Dict[str, Any],
    ) -> None:
        if not self.enabled:
            return
        event = {
            "event": "plan_created",
            "goal": goal,
            "session_id": session_id,
            "planner_info": planner_info,
            "plan": plan,
        }
        self.emit(event)

    def emit_plan_update(
        self,
        goal: str,
        session_id: Optional[str],
        planner_info: Dict[str, Any],
        plan: Dict[str, Any],
        step_id: Optional[str],
        status: Optional[str],
    ) -> None:
        if not self.enabled:
            return
        event = {
            "event": "plan_updated",
            "goal": goal,
            "session_id": session_id,
            "planner_info": planner_info,
            "plan": plan,
            "step_id": step_id,
            "status": status,
        }
        self.emit(event)
