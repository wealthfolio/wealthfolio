import unittest
import subprocess
import tempfile
import os
import textwrap
from pathlib import Path

from ci_changes import classify


class ChangeDetectionTests(unittest.TestCase):
    def assert_jobs(self, paths, *expected):
        self.assertEqual({name for name, enabled in classify(paths).items() if enabled}, set(expected))

    def test_frontend_paths(self):
        for path in ["apps/frontend/src/app.tsx", "packages/ui/src/button.tsx"]:
            with self.subTest(path=path):
                self.assert_jobs([path], "frontend", "formatting")

    def test_docs_only(self):
        self.assert_jobs(["docs/design.md", "AGENTS.md"], "formatting")

    def test_native_paths(self):
        for path in ["apps/tauri/src/lib.rs", "Cargo.lock", "Cargo.toml", ".cargo/config.toml"]:
            with self.subTest(path=path):
                self.assert_jobs([path], "rust", "android", "ios")

    def test_server_only(self):
        self.assert_jobs(["apps/server/src/main.rs"], "rust")

    def test_shared_workflows(self):
        self.assert_jobs([".github/workflows/pr-check.yml"], "frontend", "rust", "formatting", "android", "ios")

    def test_tauri_configuration(self):
        self.assert_jobs(["apps/tauri/tauri.conf.json"], "frontend", "rust", "android", "ios")

    def test_dependency_manifests(self):
        self.assert_jobs(["pnpm-lock.yaml"], "frontend", "formatting", "android", "ios")

    def test_docker(self):
        self.assert_jobs(["Dockerfile"], "frontend", "rust", "formatting")

    def test_mixed_changes(self):
        self.assert_jobs(["apps/frontend/src/app.tsx", "crates/core/src/lib.rs"], "frontend", "rust", "formatting", "android", "ios")

    def test_cross_area_rename_includes_both_paths(self):
        with tempfile.TemporaryDirectory() as root:
            def git(*args):
                return subprocess.check_output(["git", "-C", root, *args])
            git("init", "-q")
            source = Path(root) / "apps/frontend/example.ts"
            source.parent.mkdir(parents=True)
            source.write_text("export const example = 1;\n")
            git("add", ".")
            git("-c", "user.name=CI test", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
            destination = Path(root) / "crates/example/example.ts"
            destination.parent.mkdir(parents=True)
            source.rename(destination)
            git("add", "-A")
            paths = git("diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD").decode().strip("\0").split("\0")
            self.assert_jobs(paths, "frontend", "rust", "formatting", "android", "ios")

    def test_shared_rust_only_checks_mobile(self):
        for path in ["crates/core/src/addons/network.rs", "crates/core/src/addons/tests.rs",
                     "crates/market-data/src/lib.rs", "crates/new-crate/src/lib.rs"]:
            with self.subTest(path=path):
                self.assert_jobs([path], "rust", "android", "ios")

    def test_native_dependencies_and_http_require_mobile_checks(self):
        for path in ["crates/core/Cargo.toml", "crates/new-crate/build.rs", "crates/http/src/lib.rs"]:
            with self.subTest(path=path):
                self.assert_jobs([path], "rust", "android", "ios")

    def test_platform_specific_files(self):
        for platform, paths in {
            "android": ["apps/tauri/gen/android/app/build.gradle.kts", "apps/tauri/icons/android/icon.png",
                        "apps/tauri/tauri.android.conf.json", "apps/tauri/capabilities/android.json"],
            "ios": ["apps/tauri/gen/apple/project.yml", "apps/tauri/Info.ios.plist",
                    "apps/tauri/icons/ios/icon.png", "apps/tauri/tauri.ios.conf.json",
                    "apps/tauri/capabilities/ios.json", "apps/tauri/scripts/sync-ios-composer-icon.mjs"],
        }.items():
            for path in paths:
                with self.subTest(path=path):
                    self.assert_jobs([path], "rust", platform)

    def test_mixed_native_and_shared_code_is_order_independent(self):
        paths = ["Cargo.lock", "crates/core/src/lib.rs"]
        for ordered in [paths, list(reversed(paths))]:
            self.assert_jobs(ordered, "rust", "android", "ios")

    def test_server_manifest_does_not_trigger_mobile(self):
        self.assert_jobs(["apps/server/Cargo.toml"], "rust")

    def test_docs_inside_native_directories(self):
        self.assert_jobs(["crates/http/README.md", "apps/tauri/gen/android/README.md"], "formatting")

    def test_no_changes(self):
        self.assert_jobs([])


class BuildStatusTests(unittest.TestCase):
    def run_gate(self, **overrides):
        workflow = (Path(__file__).parents[1] / "workflows/pr-check.yml").read_text()
        script = textwrap.dedent(workflow.split('      - name: Check build status\n')[1].split('        run: |\n')[1])
        env = dict(os.environ, CHANGES_RESULT="success")
        for job in ["FRONTEND", "RUST", "FORMATTING", "ANDROID", "IOS"]:
            env[job + "_REQUIRED"] = "false"
            env[job + "_RESULT"] = "skipped"
        env["TRANSLATION_RESULT"] = "skipped"
        env.update(overrides)
        return subprocess.run(["bash", "-e", "-c", script], env=env, capture_output=True).returncode

    def test_unrequested_mobile_jobs_may_skip(self):
        self.assertEqual(self.run_gate(), 0)

    def test_required_mobile_jobs_must_succeed(self):
        for platform in ["ANDROID", "IOS"]:
            for result in ["failure", "cancelled", "skipped"]:
                with self.subTest(platform=platform, result=result):
                    self.assertNotEqual(self.run_gate(**{platform + "_REQUIRED": "true", platform + "_RESULT": result}), 0)
            self.assertEqual(self.run_gate(**{platform + "_REQUIRED": "true", platform + "_RESULT": "success"}), 0)

    def test_failed_detection_blocks_merge(self):
        self.assertNotEqual(self.run_gate(CHANGES_RESULT="failure"), 0)


if __name__ == "__main__":
    unittest.main()
