import unittest
import subprocess
import tempfile
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
        for path in ["apps/tauri/src/lib.rs", "crates/core/src/lib.rs", "Cargo.lock", "Cargo.toml", ".cargo/config.toml", "apps/tauri/gen/android/app/build.gradle.kts"]:
            with self.subTest(path=path):
                self.assert_jobs([path], "rust", "android")

    def test_server_only(self):
        self.assert_jobs(["apps/server/src/main.rs"], "rust")

    def test_shared_workflows(self):
        self.assert_jobs([".github/workflows/pr-check.yml"], "frontend", "rust", "formatting", "android")

    def test_tauri_configuration(self):
        self.assert_jobs(["apps/tauri/tauri.conf.json"], "frontend", "rust", "android")

    def test_dependency_manifests(self):
        self.assert_jobs(["pnpm-lock.yaml"], "frontend", "formatting", "android")

    def test_docker(self):
        self.assert_jobs(["Dockerfile"], "frontend", "rust", "formatting")

    def test_mixed_changes(self):
        self.assert_jobs(["apps/frontend/src/app.tsx", "crates/core/src/lib.rs"], "frontend", "rust", "formatting", "android")

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
            self.assert_jobs(paths, "frontend", "rust", "formatting", "android")

    def test_no_changes(self):
        self.assert_jobs([])


if __name__ == "__main__":
    unittest.main()
