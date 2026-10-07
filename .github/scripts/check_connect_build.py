"""Resolve Connect build settings without printing their values."""

import argparse
import json
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--github-env", action="store_true", help="Export effective hosts for later CI steps")
args = parser.parse_args()

if args.github_env or (os.environ.get("CONNECT_AUTH_URL") and os.environ.get("CONNECT_AUTH_PUBLISHABLE_KEY")):
    defaults = json.loads(
        (Path(__file__).resolve().parents[2] / "config/connect.defaults.json").read_text()
    )
    hosts = os.environ.get("CONNECT_STORAGE_ALLOWED_HOSTS")
    # GitHub substitutes an empty string for a missing secret. In CI that
    # means no override; explicitly blank local overrides still fail closed.
    if args.github_env and hosts is not None and not hosts.strip():
        hosts = None
    is_override = hosts is not None
    if hosts is None:
        hosts = ",".join(defaults["storageAllowedHosts"])
    entries = [host.strip() for host in hosts.split(",") if host.strip()]
    if any("\n" in host or "\r" in host for host in entries):
        sys.exit("Each Connect transfer hostname must be a single line.")
    if not entries:
        sys.exit("CONNECT_STORAGE_ALLOWED_HOSTS must contain approved hosts when explicitly set.")
    if args.github_env:
        output = os.environ.get("GITHUB_ENV")
        if not output:
            sys.exit("GITHUB_ENV is required when exporting CI configuration.")
        if is_override:
            # Normalization can change GitHub's original secret match. Mask both
            # the exported list and each host before subsequent step headers.
            for value in dict.fromkeys([",".join(entries), *entries]):
                print(f"::add-mask::{value.replace('%', '%25')}", flush=True)
        with Path(output).open("a", encoding="utf-8") as env_file:
            env_file.write(f"CONNECT_STORAGE_ALLOWED_HOSTS={','.join(entries)}\n")
