#!/bin/bash

# Setup Python virtual environment and install dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Test run the agent shell
python3 src/agent_shell.py --planner-timeout 90