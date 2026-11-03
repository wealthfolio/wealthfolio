import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantApi,
  useAssistantState,
} from "@assistant-ui/react";

import { Component, type ClipboardEvent, type ErrorInfo, type FC, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { statusSurfaceVariants } from "@wealthfolio/ui/components/ui/status-surface";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { ComposerAddAttachment, ComposerAttachments, UserMessageAttachments } from "./attachment";
import { MarkdownText } from "./markdown-text";
import { isPastedCsvTable, pastedCsvFileName } from "./pasted-csv";
import { ToolCallPart } from "./tool-fallback";
import { TooltipIconButton } from "./tooltip-icon-button";

import { cn } from "@/lib/utils";
import { Reasoning, ReasoningGroup } from "./reasoning";

export interface ThreadProps {
  composerActions?: ReactNode;
}

export const Thread: FC<ThreadProps> = ({ composerActions }) => {
  const { t } = useTranslation();
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full min-h-0 flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
      }}
    >
      <ThreadPrimitive.Viewport
        autoScroll
        turnAnchor="top"
        scrollToBottomOnRunStart
        scrollToBottomOnInitialize
        scrollToBottomOnThreadSwitch
        className="aui-thread-viewport relative flex min-h-0 flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth px-4 pt-4"
      >
        <div className="flex min-h-full flex-col">
          <ThreadPrimitive.Empty>
            <ThreadWelcome />
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Messages
            components={{
              UserMessage,
              EditComposer,
              AssistantMessage,
            }}
          />
          {/* Spacer to prevent last message from being hidden behind sticky composer + mobile nav */}
          <div className="h-[var(--mobile-nav-total-offset)] shrink-0 md:h-0" />
          <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer bg-background sticky bottom-[var(--mobile-nav-total-offset)] z-10 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible rounded-t-3xl pb-4 md:bottom-0 md:pb-6">
            <ThreadScrollToBottom />
            <Composer composerActions={composerActions} />
            <p className="text-muted-foreground/70 text-center text-xs">
              {t("ai:thread.disclaimer")}
            </p>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadScrollToBottom: FC = () => {
  const { t } = useTranslation();
  return (
    <ThreadPrimitive.ScrollToBottom behavior="smooth" asChild>
      <TooltipIconButton
        tooltip={t("ai:thread.scrollToBottom")}
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <Icons.ArrowDown />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  const { t } = useTranslation();
  return (
    <div className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
      <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
        <div className="aui-thread-welcome-message flex size-full flex-col justify-center px-8">
          <div className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-2 animate-in text-2xl font-semibold duration-300 ease-out">
            {t("ai:thread.welcomeHello")}
          </div>
          <div className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-2 animate-in text-muted-foreground/65 text-2xl delay-100 duration-300 ease-out">
            {t("ai:thread.welcomeHelp")}
          </div>
        </div>
      </div>
      <ThreadSuggestions />
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  const { t } = useTranslation();
  return (
    <div className="aui-thread-welcome-suggestions flex flex-col items-stretch gap-2 pb-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
      {[
        {
          icon: "TrendingUp" as const,
          text: t("ai:thread.suggestions.performance"),
        },
        {
          icon: "BarChart" as const,
          text: t("ai:thread.suggestions.topHoldings"),
        },
        {
          icon: "FileText" as const,
          text: t("ai:thread.suggestions.dividendIncome"),
        },
        {
          icon: "PieChart" as const,
          text: t("ai:thread.suggestions.assetAllocation"),
        },
      ].map((suggestion, index) => {
        const Icon = Icons[suggestion.icon];
        return (
          <div
            key={`suggested-action-${index}`}
            className="fade-in slide-in-from-bottom-4 animate-in fill-mode-both w-full duration-300 ease-out sm:w-auto"
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <ThreadPrimitive.Suggestion prompt={suggestion.text} asChild>
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground dark:hover:bg-accent/60 h-auto w-full max-w-full justify-start gap-2 rounded-full border px-4 py-2.5 text-start text-sm font-normal whitespace-normal sm:w-auto sm:justify-center sm:text-center sm:whitespace-nowrap"
                aria-label={suggestion.text}
              >
                <Icon className="size-4 shrink-0 opacity-60" />
                {suggestion.text}
              </Button>
            </ThreadPrimitive.Suggestion>
          </div>
        );
      })}
    </div>
  );
};

interface ComposerProps {
  composerActions?: ReactNode;
}

const Composer: FC<ComposerProps> = ({ composerActions }) => {
  const { t } = useTranslation();
  const api = useAssistantApi();

  // A pasted table becomes a CSV attachment, so an import reads the pasted
  // text itself rather than a copy the model writes out.
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.files.length > 0) return;
    const text = event.clipboardData.getData("text/plain");
    if (!isPastedCsvTable(text)) return;

    event.preventDefault();
    const composer = api.composer();
    const name = pastedCsvFileName(
      composer.getState().attachments.map((attachment) => attachment.name),
    );
    composer.addAttachment(new File([text], name, { type: "text/csv" })).catch((error) => {
      console.error("Error adding pasted table as an attachment:", error);
    });
  };

  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone className="aui-composer-attachment-dropzone border-input bg-background has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-ring/50 data-[dragging=true]:border-ring data-[dragging=true]:bg-accent/50 dark:bg-background flex w-full flex-col rounded-3xl border px-1 pt-2 shadow-xs transition-[color,box-shadow] outline-none has-[textarea:focus-visible]:ring-[3px] data-[dragging=true]:border-dashed">
        <ComposerAttachments />
        <ComposerPrimitive.Input
          placeholder={t("ai:thread.composerPlaceholder")}
          className="aui-composer-input placeholder:text-muted-foreground mb-1 max-h-32 min-h-16 w-full resize-none bg-transparent px-3.5 pt-1.5 pb-3 text-base outline-none focus-visible:ring-0"
          rows={1}
          autoFocus
          aria-label={t("ai:thread.messageInput")}
          onPaste={handlePaste}
        />
        <ComposerAction composerActions={composerActions} />
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

interface ComposerActionProps {
  composerActions?: ReactNode;
}

const ComposerAction: FC<ComposerActionProps> = ({ composerActions }) => {
  const { t } = useTranslation();
  return (
    <div className="aui-composer-action-wrapper relative mx-1 mt-2 mb-2 flex items-center justify-between">
      <div className="flex items-center gap-1">
        <ComposerAddAttachment />
        {composerActions}
      </div>

      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            tooltip={t("ai:thread.sendMessage")}
            side="bottom"
            type="submit"
            variant="default"
            size="icon"
            className="aui-composer-send size-8.5 rounded-full p-1"
            aria-label={t("ai:thread.sendMessage")}
          >
            <Icons.ArrowUp className="aui-composer-send-icon size-5" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>

      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel asChild>
          <Button
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-cancel border-muted-foreground/60 hover:bg-primary/75 dark:border-muted-foreground/90 size-8.5 rounded-full border"
            aria-label={t("ai:thread.stopGenerating")}
          >
            <Icons.Square className="aui-composer-cancel-icon size-3.5 fill-white dark:fill-black" />
          </Button>
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root
        className={cn(
          "aui-message-error-root text-destructive-subtle-foreground mt-2 rounded-md p-3 text-sm",
          statusSurfaceVariants({ status: "destructive" }),
        )}
      >
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

interface MessagePartWithResult {
  type?: string;
  result?: unknown;
}

interface ToolRenderErrorBoundaryState {
  error: Error | null;
}

class ToolRenderErrorBoundary extends Component<
  { children: ReactNode },
  ToolRenderErrorBoundaryState
> {
  override state: ToolRenderErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ToolRenderErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Tool UI render failed", {
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  override render() {
    if (this.state.error) {
      return <ToolRenderErrorFallback />;
    }

    return this.props.children;
  }
}

const ToolRenderErrorFallback: FC = () => {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive" className="px-3 py-2 text-xs">
      <Icons.AlertCircle />
      <AlertDescription>{t("ai:thread.toolDisplayFailed")}</AlertDescription>
    </Alert>
  );
};

interface TypingIndicatorProps {
  position: "initial" | "continuation";
}

const TypingIndicator: FC<TypingIndicatorProps> = ({ position }) => {
  const showIndicator = useAssistantState(({ message }) => {
    if (message.status?.type !== "running") return false;

    if (position === "initial") {
      return message.parts.length === 0;
    }

    const lastPart = message.parts[message.parts.length - 1] as MessagePartWithResult | undefined;
    return (
      lastPart?.type === "tool-call" &&
      Object.prototype.hasOwnProperty.call(lastPart, "result") &&
      lastPart.result !== undefined
    );
  });

  if (!showIndicator) return null;

  return (
    <div className="bg-muted mb-2 inline-flex items-end gap-1 rounded-2xl px-3.5 pt-3 pb-2.5">
      <span className="bg-foreground/50 size-2 animate-bounce rounded-full [animation-delay:-0.3s]" />
      <span className="bg-foreground/50 size-2 animate-bounce rounded-full [animation-delay:-0.15s]" />
      <span className="bg-foreground/50 size-2 animate-bounce rounded-full" />
    </div>
  );
};

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root fade-in slide-in-from-bottom-1 animate-in relative mx-auto w-full max-w-(--thread-max-width) py-4 duration-150 ease-out"
      data-role="assistant"
    >
      <div className="aui-assistant-message-content text-foreground mx-2 text-sm leading-6 wrap-break-word">
        <TypingIndicator position="initial" />
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Reasoning: Reasoning,
            ReasoningGroup: ReasoningGroup,
            ToolGroup: ({ children }) => (
              <ToolRenderErrorBoundary>
                <div className="mb-6 space-y-4">{children}</div>
              </ToolRenderErrorBoundary>
            ),
            tools: {
              Override: ToolCallPart,
            },
          }}
        />
        <TypingIndicator position="continuation" />
        <MessageError />
      </div>

      <div className="aui-assistant-message-footer ms-2 mt-2 flex">
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const { t } = useTranslation();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="aui-assistant-action-bar-root text-muted-foreground data-floating:bg-background col-start-3 row-start-2 -ms-1 flex gap-1 data-floating:absolute data-floating:rounded-md data-floating:border data-floating:p-1 data-floating:shadow-sm"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={t("ai:thread.copy")}>
          <MessagePrimitive.If copied>
            <Icons.Check />
          </MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>
            <Icons.Copy />
          </MessagePrimitive.If>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip={t("ai:thread.refresh")}>
          <Icons.RefreshCw />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-user-message-root fade-in slide-in-from-bottom-1 animate-in mx-auto grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(4.5rem,1fr)_auto] content-start gap-y-2 px-2 py-4 duration-150 ease-out [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content bg-muted text-foreground rounded-3xl px-5 py-2.5 text-sm wrap-break-word">
          <MessagePrimitive.Parts
            components={{
              Reasoning: Reasoning,
              ReasoningGroup: ReasoningGroup,
            }}
          />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker className="aui-user-branch-picker col-span-full col-start-1 row-start-3 -me-1 justify-end" />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  const { t } = useTranslation();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip={t("ai:thread.edit")} className="aui-user-action-edit p-4">
          <Icons.Pencil />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  const { t } = useTranslation();
  return (
    <MessagePrimitive.Root className="aui-edit-composer-wrapper mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 px-2">
      <ComposerPrimitive.Root className="aui-edit-composer-root bg-muted ms-auto flex w-full max-w-7/8 flex-col rounded-xl">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground flex min-h-15 w-full resize-none bg-transparent p-4 outline-none"
          autoFocus
        />

        <div className="aui-edit-composer-footer mx-3 mb-3 flex items-center justify-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" aria-label={t("ai:thread.cancelEdit")}>
              {t("ai:thread.cancel")}
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" aria-label={t("ai:thread.updateMessage")}>
              {t("ai:thread.update")}
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({ className, ...rest }) => {
  const { t } = useTranslation();
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip={t("ai:thread.previous")}>
          <Icons.ChevronLeft className="rtl:rotate-180" />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip={t("ai:thread.next")}>
          <Icons.ChevronRight className="rtl:rotate-180" />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
