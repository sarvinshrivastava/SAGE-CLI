"""Safety policy utilities for command risk evaluation."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

try:  # Optional dependency for YAML support
    import yaml  # type: ignore
except Exception:  # pragma: no cover - yaml is optional
    yaml = None  # type: ignore


@dataclass
class SafetyDecision:
    level: str
    require_confirmation: bool
    notes: Optional[str] = None


@dataclass
class SafetyRule:
    pattern: str
    level: str
    require_confirmation: bool = False
    allowed_flags: Optional[List[str]] = None
    description: Optional[str] = None

    def __post_init__(self) -> None:
        self._compiled = re.compile(self.pattern, re.IGNORECASE)

    def matches(self, command: str) -> bool:
        return bool(self._compiled.search(command))

    def evaluate(self, command: str) -> SafetyDecision:
        notes: List[str] = []
        require_confirmation = self.require_confirmation
        if self.allowed_flags:
            if not any(flag in command for flag in self.allowed_flags):
                notes.append(
                    "Expected one of the following flags: "
                    + ", ".join(self.allowed_flags)
                )
                require_confirmation = True
        if self.description:
            notes.append(self.description)
        return SafetyDecision(
            level=self.level,
            require_confirmation=require_confirmation,
            notes="\n".join(notes) if notes else None,
        )


class SafetyPolicy:
    def __init__(self, rules: Iterable[SafetyRule]):
        self.rules: List[SafetyRule] = list(rules)

    @classmethod
    def load(cls, policy_path: Optional[str]) -> "SafetyPolicy":
        candidates: List[str] = []
        if policy_path:
            candidates.append(policy_path)
        env_path = os.getenv("AGENT_SAFETY_POLICY")
        if env_path:
            candidates.append(env_path)
        candidates.append("safety_policy.json")

        for candidate in candidates:
            path = Path(candidate).expanduser()
            if not path.exists():
                continue
            data = cls._read_policy_file(path)
            if not data:
                continue
            rules = cls._rules_from_mapping(data)
            if rules:
                return cls(rules)

        return cls.default()

    @staticmethod
    def _read_policy_file(path: Path) -> Optional[Dict[str, Any]]:
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            return None

        if path.suffix.lower() in {".yaml", ".yml"}:
            if yaml is None:
                raise RuntimeError(
                    "PyYAML is required to load YAML safety policies. Install pyyaml or use JSON."
                )
            loaded = yaml.safe_load(content)  # type: ignore[arg-type]
        else:
            loaded = json.loads(content)

        if isinstance(loaded, dict):
            return loaded
        return None

    @staticmethod
    def _rules_from_mapping(mapping: Dict[str, Any]) -> List[SafetyRule]:
        raw_rules = mapping.get("rules")
        if not isinstance(raw_rules, list):
            return []
        rules: List[SafetyRule] = []
        for item in raw_rules:
            if not isinstance(item, dict):
                continue
            pattern = item.get("pattern")
            level = (item.get("level") or "low").lower()
            if not pattern or level not in {"low", "medium", "high"}:
                continue
            require_confirmation = bool(item.get("require_confirmation", False))
            allowed_flags = item.get("allowed_flags")
            if allowed_flags and isinstance(allowed_flags, list):
                allowed_flags = [str(flag) for flag in allowed_flags if flag]
            else:
                allowed_flags = None
            description = item.get("description")
            rules.append(
                SafetyRule(
                    pattern=str(pattern),
                    level=level,
                    require_confirmation=require_confirmation,
                    allowed_flags=allowed_flags,
                    description=str(description) if description else None,
                )
            )
        return rules

    @classmethod
    def default(cls) -> "SafetyPolicy":
        return cls(
            [
                SafetyRule(pattern=r"rm\s+-rf\s+/", level="high", require_confirmation=True),
                SafetyRule(pattern=r":\(\)\s*{", level="high", require_confirmation=True),
                SafetyRule(pattern=r"\bdd\s+if=", level="high", require_confirmation=True),
                SafetyRule(pattern=r"\bmkfs\.\w*", level="high", require_confirmation=True),
                SafetyRule(pattern=r">\s*/dev/sd[0-9a-z]", level="high", require_confirmation=True),
                SafetyRule(pattern=r"\bwipefs\b", level="high", require_confirmation=True),
                SafetyRule(pattern=r"\b(poweroff|shutdown|reboot|halt)\b", level="high", require_confirmation=True),
                SafetyRule(pattern=r"\buserdel\b", level="high", require_confirmation=True),
                SafetyRule(pattern=r"\bmkpart\b", level="high", require_confirmation=True),
                SafetyRule(pattern=r"\bsudo\b", level="medium"),
                SafetyRule(pattern=r"\bapt(-get)?\s+remove\b", level="medium"),
                SafetyRule(pattern=r"\bchown\s+-R\b", level="medium"),
                SafetyRule(pattern=r"\bchmod\s+777\b", level="medium"),
                SafetyRule(pattern=r"\bsystemctl\s+(stop|restart)\s+", level="medium"),
                SafetyRule(pattern=r"\bkill\s+-9\b", level="medium"),
                SafetyRule(
                    pattern=r"\bapt(-get)?\s+install\b",
                    level="medium",
                    allowed_flags=["-y"],
                    description="Apt installs should include -y for non-interactive mode.",
                ),
            ]
        )

    def evaluate(self, command: str) -> SafetyDecision:
        normalized = command.strip()
        if not normalized:
            return SafetyDecision(level="low", require_confirmation=False)
        for rule in self.rules:
            if rule.matches(normalized):
                return rule.evaluate(normalized)
        return SafetyDecision(level="low", require_confirmation=False)