import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Badge, EmptyPlaceholder } from "@wealthfolio/ui";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@wealthfolio/ui/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { Thread } from "./thread";
import { ThreadList } from "./thread-list";
import { ProviderPicker } from "./provider-picker";
import { ModelPicker } from "./model-picker";
import {
  AccountsToolUI,
  ActivitiesToolUI,
  AllocationToolUI,
  CategorizationProposalsToolUI,
  CreateCategorizationRuleToolUI,
  GoalsToolUI,
  HoldingsToolUI,
  ImportCsvToolUI,
  IncomeToolUI,
  ListCategorizationContextToolUI,
  PerformanceToolUI,
  RecordActivityToolUI,
  RecordActivitiesToolUI,
  ValuationToolUI,
} from "./tool-uis";
import { ChatModelProvider, useChatModelContext } from "../hooks/use-chat-model-context";
import { useChatRuntime } from "../hooks/use-chat-runtime";
import { RuntimeProvider } from "../hooks/use-runtime-context";

interface ChatShellProps {
  className?: string;
}

/**
 * Button with tooltip helper component.
 */
function ButtonWithTooltip({
  children,
  tooltip,
  side = "bottom",
  ...props
}: React.ComponentPropsWithRef<typeof Button> & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props}>
          {children}
          <span className="sr-only">{tooltip}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Sidebar component for thread list.
 */
function Sidebar({ collapsed }: { collapsed?: boolean }) {
  return (
    <aside
      className={cn(
        "bg-muted/30 flex h-full flex-col border-r transition-all duration-200",
        collapsed ? "w-0 overflow-hidden opacity-0" : "w-[260px] opacity-100",
      )}
    >
      <div className="flex-1 overflow-y-auto p-3">
        <ThreadList />
      </div>
    </aside>
  );
}

/**
 * Mobile sidebar using Sheet component.
 */
function MobileSidebar() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-9 shrink-0 md:hidden">
          <Icons.PanelLeft className="size-4" />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="flex w-[280px] flex-col gap-0 px-0 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-[max(env(safe-area-inset-top),0.75rem)]"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Conversations</SheetTitle>
        </SheetHeader>
        <div className="flex h-14 items-center border-b px-4">
          <span className="font-semibold">Conversations</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ThreadList />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Header component with sidebar toggle and provider/model pickers.
 */
function Header({
  sidebarCollapsed,
  onToggleSidebar,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="pt-safe flex shrink-0 items-center gap-2 border-b px-4">
      <MobileSidebar />
      <ButtonWithTooltip
        variant="ghost"
        size="icon"
        tooltip={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        side="bottom"
        onClick={onToggleSidebar}
        className="hidden size-9 md:flex"
      >
        <Icons.PanelLeft className="size-4" />
      </ButtonWithTooltip>
      <ProviderPicker />
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="warning" className="cursor-default">
            Beta
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          This feature is in beta. Results may vary as we continue to improve.
        </TooltipContent>
      </Tooltip>
    </header>
  );
}

/**
 * Empty state when no AI providers are enabled.
 */
function NoProvidersEmptyState({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-full w-full items-center justify-center", className)}>
      <EmptyPlaceholder
        icon={<Icons.Sparkles className="text-muted-foreground h-10 w-10" />}
        title="No AI provider configured"
        description="Connect an AI provider to start chatting with your personal finance assistant. Your data stays private and secure."
      >
        <Button asChild>
          <Link to="/settings/ai-providers">
            <Icons.Settings className="mr-2 h-4 w-4" />
            Configure AI Providers
          </Link>
        </Button>
      </EmptyPlaceholder>
    </div>
  );
}

/**
 * Inner chat shell component that uses the chat model context.
 */
function ChatShellInner({ className }: ChatShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const {
    currentProviderId,
    currentModelId,
    enabledProviders,
    isLoading,
    thinkingEnabled,
    supportsThinking,
  } = useChatModelContext();

  // Build chat config from current selection
  const chatConfig = useMemo(() => {
    if (!currentProviderId || !currentModelId) {
      return undefined;
    }
    return {
      provider: currentProviderId,
      model: currentModelId,
      // Only include thinking if model supports it and user has toggled it
      thinking: supportsThinking ? thinkingEnabled : undefined,
    };
  }, [currentProviderId, currentModelId, supportsThinking, thinkingEnabled]);

  // Create the chat runtime
  const runtime = useChatRuntime(chatConfig);

  // Show empty state if no providers are enabled
  if (!isLoading && enabledProviders.length === 0) {
    return <NoProvidersEmptyState className={className} />;
  }

  return (
    <RuntimeProvider runtime={runtime}>
      <AssistantRuntimeProvider runtime={runtime}>
        {/* Tool UIs - must be children of AssistantRuntimeProvider to register */}
        <HoldingsToolUI />
        <AccountsToolUI />
        <ActivitiesToolUI />
        <GoalsToolUI />
        <ValuationToolUI />
        <IncomeToolUI />
        <AllocationToolUI />
        <PerformanceToolUI />
        <RecordActivityToolUI />
        <RecordActivitiesToolUI />
        <ImportCsvToolUI />
        <CreateCategorizationRuleToolUI />
        <ListCategorizationContextToolUI />
        <CategorizationProposalsToolUI />

        <div className={cn("bg-background flex h-full min-h-0 w-full", className)}>
          {/* Desktop Sidebar */}
          <div className="hidden md:block">
            <Sidebar collapsed={sidebarCollapsed} />
          </div>

          {/* Main Content Area */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Header
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
            />

            {/* Thread (Chat Messages) */}
            <main className="min-h-0 flex-1 overflow-hidden">
              <Thread composerActions={<ModelPicker />} />
            </main>
          </div>
        </div>
      </AssistantRuntimeProvider>
    </RuntimeProvider>
  );
}

/**
 * Main chat shell component with thread sidebar and message panel.
 * Uses @assistant-ui/react for the chat interface.
 * Wraps the inner component in ChatModelProvider to share state.
 */
export function ChatShell({ className }: ChatShellProps) {
  return (
    <ChatModelProvider>
      <ChatShellInner className={className} />
    </ChatModelProvider>
  );
}
