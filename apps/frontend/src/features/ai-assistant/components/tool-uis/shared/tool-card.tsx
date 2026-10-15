import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui";

export interface ToolCardProps {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  maxHeight?: number;
  isLoading?: boolean;
  error?: string;
  children: ReactNode;
  className?: string;
}

const DEFAULT_MAX_HEIGHT = 320;

export function ToolCard({
  title,
  subtitle,
  badge,
  maxHeight = DEFAULT_MAX_HEIGHT,
  isLoading,
  error,
  children,
  className,
}: ToolCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{title}</CardTitle>
            {badge}
          </div>
          {subtitle && <p className="text-muted-foreground text-xs">{subtitle}</p>}
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative overflow-y-auto" style={{ maxHeight: `${maxHeight}px` }}>
          {error ? (
            <Alert variant="destructive" className="px-3 py-2">
              <Icons.AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <>
              {children}
              {isLoading && (
                <div className="bg-background/60 absolute inset-0 flex items-center justify-center backdrop-blur-sm">
                  <Icons.Spinner className="text-muted-foreground size-6 animate-spin" />
                </div>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
