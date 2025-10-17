"""Session persistence utilities for the shell assistant."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


@dataclass
class SessionManager:
    """Handles optional persistence of goal runs to session logs."""

    root: Path
    session_id: str
    enabled: bool

    @property
    def path(self) -> Path:
        return self.root / f"{self.session_id}.jsonl"

    @classmethod
    def initialize(
        cls,
        directory: Optional[str],
        session_id: Optional[str],
        persist: bool,
    ) -> "SessionManager":
        if not persist:
            return cls(root=Path("."), session_id="ephemeral", enabled=False)

        base = Path(directory or "sessions").expanduser().resolve()
        base.mkdir(parents=True, exist_ok=True)
        sid = session_id or cls._generate_id()
        return cls(root=base, session_id=sid, enabled=True)

    def start_new(self, session_id: Optional[str] = None) -> "SessionManager":
        if not self.enabled:
            return self
        return SessionManager(self.root, session_id or self._generate_id(), True)

    def describe(self) -> str:
        if not self.enabled:
            return "Session persistence disabled."
        return f"Session {self.session_id} -> {self.path}"

    def record_goal(
        self,
        goal: str,
        steps: Iterable[Dict[str, Any]],
        status: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self.enabled:
            return

        entry = {
            "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "goal": goal,
            "status": status,
            "steps": list(steps),
            "metadata": metadata or {},
        }

        try:
            with self.path.open("a", encoding="utf-8") as handle:
                json.dump(entry, handle, ensure_ascii=True)
                handle.write("\n")
        except OSError as exc:
            # Logging to stdout is acceptable fallback for now.
            print(f"Warning: failed to persist session data: {exc}")

    @staticmethod
    def _generate_id() -> str:
        return datetime.utcnow().strftime("%Y%m%d-%H%M%S")
