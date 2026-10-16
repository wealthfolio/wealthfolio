import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { AnimatedToggleGroup } from "@wealthfolio/ui/components/ui/animated-toggle-group";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { buildClientConfig, DEFAULT_PRESET_ID, TOKEN_ENV_VAR } from "../mcp-client-config";

/** Icon button that copies `value` and briefly shows a check. */
export function CopyIconButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast({
        title: t("settings:agentAccess.copy_failed_title"),
        description: t("settings:agentAccess.copy_failed_generic", { label: label.toLowerCase() }),
        variant: "destructive",
      });
      console.error("Failed to copy to clipboard:", error);
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7 shrink-0", className)}
      onClick={() => void handleCopy()}
    >
      {copied ? (
        <Icons.Check className="text-success h-3.5 w-3.5" />
      ) : (
        <Icons.Copy className="h-3.5 w-3.5" />
      )}
      <span className="sr-only">{t("settings:agentAccess.copy_aria", { label })}</span>
    </Button>
  );
}

interface ClientOption {
  id: string;
  presetId: string;
  /** Brand name shown as is; otherwise `labelKey` is translated. */
  label?: string;
  labelKey?: string;
  /** One-line "where it goes" hint (i18n key), with `path` as its value. */
  location: string;
  path?: string;
}

interface ClientTab {
  id: "claude" | "codex" | "other";
  label?: string;
  labelKey?: string;
  options: ClientOption[];
  note?: string;
}

const FILE = "settings:agentAccess.client_location_file";
const MENU = "settings:agentAccess.client_location_menu";

const CLIENT_TABS: ClientTab[] = [
  {
    id: "claude",
    label: "Claude Code",
    note: "settings:agentAccess.client_note_claude_desktop_chat",
    options: [
      {
        id: "claude-command",
        presetId: DEFAULT_PRESET_ID,
        labelKey: "settings:agentAccess.client_option_command",
        location: "settings:agentAccess.client_location_terminal",
      },
      {
        id: "claude-project",
        presetId: "claude-code-project",
        labelKey: "settings:agentAccess.client_option_project",
        location: "settings:agentAccess.client_location_claude_project",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex / ChatGPT",
    options: [{ id: "codex", presetId: "codex", location: FILE, path: "~/.codex/config.toml" }],
  },
  {
    id: "other",
    labelKey: "settings:agentAccess.client_other",
    options: [
      {
        id: "cursor",
        presetId: "cursor",
        label: "Cursor",
        location: FILE,
        path: "~/.cursor/mcp.json",
      },
      {
        id: "windsurf",
        presetId: "cursor",
        label: "Windsurf",
        location: FILE,
        path: "~/.codeium/windsurf/mcp_config.json",
      },
      {
        id: "cline",
        presetId: "cursor",
        label: "Cline",
        location: MENU,
        path: "MCP Servers → Configure",
      },
      {
        id: "vscode",
        presetId: "vscode",
        label: "VS Code",
        location: FILE,
        path: ".vscode/mcp.json",
      },
      {
        id: "opencode",
        presetId: "opencode",
        label: "OpenCode",
        location: FILE,
        path: "opencode.json",
      },
      {
        id: "jan",
        presetId: "jan",
        label: "Jan",
        location: MENU,
        path: "Settings → MCP Servers → Add",
      },
      {
        id: "lmstudio",
        presetId: "lmstudio",
        label: "LM Studio",
        location: MENU,
        path: "Program → Install → Edit mcp.json",
      },
      {
        id: "unsloth",
        presetId: "cursor",
        label: "Unsloth Studio",
        location: MENU,
        path: "Chat → + → MCP servers",
      },
      {
        id: "generic",
        presetId: "generic",
        labelKey: "settings:agentAccess.client_option_any_http",
        location: "settings:agentAccess.client_location_http",
      },
    ],
  },
];

const hintParts = {
  code: <span className="text-foreground font-mono" />,
  ui: <span className="text-foreground" />,
};

/**
 * Client picker with the setup snippet for the chosen agent. Renders the
 * `YOUR_TOKEN` placeholder unless a freshly created `token` is passed.
 */
export function ClientSetup({ serverUrl, token }: { serverUrl: string; token?: string }) {
  const { t } = useTranslation();
  const [tabId, setTabId] = useState<ClientTab["id"]>("claude");
  const [optionId, setOptionId] = useState<string>();
  const tab = CLIENT_TABS.find((entry) => entry.id === tabId) ?? CLIENT_TABS[0];
  const option = tab.options.find((entry) => entry.id === optionId) ?? tab.options[0];
  const snippet = buildClientConfig(option.presetId, serverUrl, token);
  const labelOf = (entry: { label?: string; labelKey?: string }) =>
    entry.labelKey ? t(entry.labelKey) : (entry.label ?? "");

  return (
    <div className="space-y-2">
      <AnimatedToggleGroup<ClientTab["id"]>
        value={tabId}
        onValueChange={(id) => {
          setTabId(id);
          setOptionId(undefined);
        }}
        items={CLIENT_TABS.map((entry) => ({ value: entry.id, label: labelOf(entry) }))}
        size="xs"
        rounded="md"
        aria-label={t("settings:agentAccess.client_picker_aria")}
        className="bg-muted/30 w-full border [&>button]:flex-1"
      />
      <div className="flex min-h-7 items-center gap-2">
        {tab.options.length > 1 && (
          <Select value={option.id} onValueChange={(value) => setOptionId(value ?? undefined)}>
            <SelectTrigger
              aria-label={t("settings:agentAccess.client_option_aria")}
              className="bg-muted/60 !h-7 w-auto shrink-0 gap-1 border-0 px-2 py-0 text-xs font-medium shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tab.options.map((entry) => (
                <SelectItem key={entry.id} value={entry.id} className="text-xs">
                  {labelOf(entry)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-muted-foreground min-w-0 text-xs">
          <Trans
            i18nKey={option.location}
            values={{ path: option.path, envVar: TOKEN_ENV_VAR }}
            components={hintParts}
          />
        </p>
      </div>
      <div className="bg-muted relative rounded-md">
        <pre className="text-muted-foreground max-h-56 overflow-y-auto whitespace-pre-wrap break-words py-2 pl-3 pr-10 font-mono text-xs leading-relaxed">
          {snippet}
        </pre>
        <CopyIconButton
          value={snippet}
          label={t("settings:agentAccess.dialog_client_config")}
          className="absolute right-1.5 top-1.5"
        />
      </div>
      {tab.note && <p className="text-muted-foreground text-xs">{t(tab.note)}</p>}
    </div>
  );
}
