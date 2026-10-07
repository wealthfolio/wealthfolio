"""Connect packages must validate their transfer destinations before building."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import json


class ConnectBuildTests(unittest.TestCase):
    def run_check(self, cli_args=(), **settings):
        env = os.environ.copy()
        for name in (
            "CONNECT_AUTH_URL",
            "CONNECT_AUTH_PUBLISHABLE_KEY",
            "CONNECT_STORAGE_ALLOWED_HOSTS",
        ):
            env.pop(name, None)
        env.update(settings)
        return subprocess.run(
            [sys.executable, str(Path(__file__).with_name("check_connect_build.py")), *cli_args],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_build_without_connect_does_not_require_transfer_configuration(self):
        self.assertEqual(self.run_check().returncode, 0)

    def test_connect_build_uses_public_defaults_without_transfer_override(self):
        result = self.run_check(
            CONNECT_AUTH_URL="https://auth.test",
            CONNECT_AUTH_PUBLISHABLE_KEY="synthetic-public-key",
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout + result.stderr, "")

    def test_connect_build_rejects_explicitly_blank_transfer_configuration(self):
        for hosts in ("", "  ", " , "):
            with self.subTest(hosts=hosts):
                result = self.run_check(
                    CONNECT_AUTH_URL="https://auth.test",
                    CONNECT_AUTH_PUBLISHABLE_KEY="synthetic-public-key",
                    CONNECT_STORAGE_ALLOWED_HOSTS=hosts,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("CONNECT_STORAGE_ALLOWED_HOSTS", result.stderr)
                self.assertNotIn("synthetic-public-key", result.stderr)

    def test_connect_build_accepts_configured_hosts_without_printing_values(self):
        result = self.run_check(
            CONNECT_AUTH_URL="https://auth.test",
            CONNECT_AUTH_PUBLISHABLE_KEY="synthetic-public-key",
            CONNECT_STORAGE_ALLOWED_HOSTS="storage.test",
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout + result.stderr, "")

    def test_ci_exports_defaults_for_missing_secrets_and_preserves_nonempty_overrides(self):
        defaults = json.loads((Path(__file__).resolve().parents[2] / "config/connect.defaults.json").read_text())
        for override in (None, "", "custom.test, second.test", "\n custom.test, second.test \n"):
            with self.subTest(override=override), tempfile.TemporaryDirectory() as root:
                output = Path(root) / "github-env"
                settings = {"GITHUB_ENV": str(output)}
                if override is not None:
                    settings["CONNECT_STORAGE_ALLOWED_HOSTS"] = override
                result = self.run_check(cli_args=("--github-env",), **settings)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout + result.stderr, "")
                expected = "custom.test,second.test" if override else ",".join(defaults["storageAllowedHosts"])
                self.assertEqual(output.read_text(), f"CONNECT_STORAGE_ALLOWED_HOSTS={expected}\n")

    def test_ci_cannot_inject_other_environment_values_through_the_override(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "github-env"
            result = self.run_check(
                cli_args=("--github-env",), GITHUB_ENV=str(output),
                CONNECT_STORAGE_ALLOWED_HOSTS="custom.test\nOTHER_SETTING=injected",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())
            self.assertNotIn("injected", result.stderr)


if __name__ == "__main__":
    unittest.main()
