"""Validate Connect release settings without printing their values."""

import os
import sys

if os.environ.get("CONNECT_AUTH_URL") and os.environ.get("CONNECT_AUTH_PUBLISHABLE_KEY"):
    if not os.environ.get("CONNECT_STORAGE_ALLOWED_HOSTS", "").strip():
        sys.exit("Connect builds require CONNECT_STORAGE_ALLOWED_HOSTS in the build environment.")
