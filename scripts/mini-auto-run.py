#!/usr/bin/env python3
"""Non-interactive mini-swe-agent entrypoint for Thrush Auto Runs."""

from __future__ import annotations

import argparse
from pathlib import Path

from minisweagent.agents import get_agent
from minisweagent.config import builtin_config_dir, get_config_from_spec
from minisweagent.environments import get_environment
from minisweagent.models import get_model
from minisweagent.utils.serialize import UNSET, recursive_merge


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run mini-swe-agent without the interactive CLI UI.",
    )
    parser.add_argument("-c", "--config", action="append", default=[])
    parser.add_argument("-m", "--model")
    parser.add_argument("-o", "--output", type=Path)
    parser.add_argument("-t", "--task", required=True)
    parser.add_argument("-y", "--yolo", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config_specs = args.config or [str(builtin_config_dir / "mini.yaml")]

    configs = [get_config_from_spec(spec) for spec in config_specs]
    configs.append(
        {
            "run": {
                "task": args.task,
            },
            "agent": {
                "agent_class": "default",
                "mode": "yolo" if args.yolo else UNSET,
                "output_path": args.output or UNSET,
            },
            "model": {
                "model_name": args.model or UNSET,
            },
        },
    )
    config = recursive_merge(*configs)

    model = get_model(config=config.get("model", {}))
    env = get_environment(config.get("environment", {}), default_type="local")
    agent = get_agent(model, env, config.get("agent", {}), default_type="default")
    result = agent.run(config.get("run", {}).get("task", args.task))
    return 0 if result.get("exit_status") == "Submitted" else 1


if __name__ == "__main__":
    raise SystemExit(main())
