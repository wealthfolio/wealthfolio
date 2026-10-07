"""Validate Connect release settings without printing their values."""

import json
import os
from pathlib import Path
import sys

if os.environ.get("CONNECT_AUTH_URL") and os.environ.get("CONNECT_AUTH_PUBLISHABLE_KEY"):
    defaults = json.loads(
        (Path(__file__).resolve().parents[2] / "config/connect.defaults.json").read_text()
    )
    hosts = os.environ.get("CONNECT_STORAGE_ALLOWED_HOSTS")
    if hosts is None:
        hosts = ",".join(defaults["storageAllowedHosts"])
    if not any(host.strip() for host in hosts.split(",")):
        sys.exit("CONNECT_STORAGE_ALLOWED_HOSTS must contain approved hosts when explicitly set.")
