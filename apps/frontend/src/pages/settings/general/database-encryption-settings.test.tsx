import { render, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import settings from "@/i18n/locales/en/settings.json";
import { DatabaseEncryptionSettings } from "./database-encryption-settings";

const runtime = vi.hoisted(() => ({ web: false, enabled: false }));
vi.mock("@/adapters", () => ({
  get isWeb() {
    return runtime.web;
  },
  getDatabaseEncryptionStatus: vi.fn(),
  setDatabaseEncryptionEnabled: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { enabled: runtime.enabled, supported: !runtime.web } }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

describe("database encryption guidance", () => {
  it.each([false, true])(
    "web uses server backup guidance regardless of current encryption (%s)",
    (enabled) => {
      runtime.web = true;
      runtime.enabled = enabled;
      render(<DatabaseEncryptionSettings />);
      expect(screen.getByText(settings.database_encryption_server_backup_warning)).toBeVisible();
      expect(screen.queryByText(settings.backup_portable_help)).not.toBeInTheDocument();
      expect(screen.getByRole("switch")).toBeDisabled();
    },
  );

  it("native apps expose the switch and explain portable backup passwords", () => {
    runtime.web = false;
    runtime.enabled = true;
    render(<DatabaseEncryptionSettings />);
    expect(screen.getByText(settings.backup_portable_help)).toBeVisible();
    expect(screen.queryByText(settings.database_encryption_server_managed)).not.toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeEnabled();
    expect(screen.getByRole("switch")).toBeChecked();
  });
});
