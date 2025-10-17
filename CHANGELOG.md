## 🧩 ChangeLog — System Enhancement Sprint

**Version:** v2.5.0 (Planned)
**Owner:** Sarvin Shrivastava
**Purpose:** Architectural and functional upgrades to strengthen planner-executor flow, runtime robustness, and compliance traceability.

---

## 🧩 1. Planner Layer Improvements

### 🧠 a. Hierarchical Planning

Instead of a single-step “command generator,” make the planner capable of producing a plan tree:

Root goal → subgoals → commands.

Store subgoal metadata (goal_id, parent, dependencies).

Enables better recovery on partial failures — the agent resumes from a specific subgoal.

Example:

```
{
  "mode": "plan",
  "steps": [
    {"goal": "Install dependencies", "commands": ["sudo apt-get update", "sudo apt-get install -y nginx"]},
    {"goal": "Configure Nginx", "commands": ["sudo systemctl start nginx"]}
  ]
}
```

You’d still flatten this plan into a REPL loop, but it helps for more complex tasks like multi-service setups.

### 🧠 b. Adaptive Command Strategy

Add a planner feedback model that scores the success/failure ratio and tunes future suggestions:

Maintain a lightweight local store: {command_hash: {success_count, fail_count}}

If a command often fails, the planner receives a note like:

“Avoid using apt-get install without -y, it fails frequently.”

This allows on-device fine-tuning without full retraining.

## ⚙️ 2. Executor & Runtime Enhancements

### 🚦 a. Dynamic Safety Sandbox

Right now, you classify risks statically.
I’d extend this by using a policy-based evaluator:

A YAML/JSON config like:

```
rules:
  - pattern: "rm -rf"
    level: "high"
    require_confirmation: true
  - pattern: "apt-get"
    level: "medium"
    allowed_flags: ["-y"]
```

Lets users adjust or import safety policies.

### 📡 b. Command Context Tracking

Each command execution can maintain a context object:

```
{
  "command": "apt-get install -y nginx",
  "environment": {"cwd": "/usr/local", "user": "non-root"},
  "runtime": {"duration": 2.3, "exit_code": 0}
}
```

This enables richer logs and faster planner feedback loops (and easier debugging).

## 📊 3. Observability & Persistence

### 🧾 a. Structured Telemetry

Instead of flat JSONL logs, add a structured event schema:

```
{
  "event": "execution",
  "timestamp": "...",
  "goal": "Install Nginx",
  "command": "...",
  "risk_level": "medium",
  "duration": 3.2,
  "exit_code": 0
}
```

Then you can visualize these in dashboards (Grafana, Loki, etc.) or even run local summaries with jq.

## 🪄 4. UX & Interactivity

### 💬 a. Smart Confirmations

Use a diff view for modified commands before running.

Highlight risky flags (--force, --purge).

```
Offer [A]ccept / [E]dit / [S]kip keyboard shortcuts.
```

## 🔒 6. Safety & Compliance

### 🧾 b. Provenance Metadata

Attach a planner_model and planner_version field to session logs — critical for audit trails:

```
"planner_info": {"model": "mistral-large", "version": "2025.10"}
```

---
