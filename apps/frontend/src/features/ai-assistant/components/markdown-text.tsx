"use client";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import { type FC, memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icons } from "@wealthfolio/ui/components/ui/icons";
import remarkGfm from "remark-gfm";

import { ExternalLink } from "@/components/external-link";
import { cn } from "@/lib/utils";
import { TooltipIconButton } from "./tooltip-icon-button";

const MarkdownTextImpl = () => {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md prose prose-sm dark:prose-invert prose-p:leading-relaxed prose-pre:p-0 prose-pre:bg-transparent max-w-none"
      components={customComponents}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { t } = useTranslation();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="aui-code-header-root bg-muted-foreground/15 text-foreground dark:bg-muted-foreground/20 not-prose mt-4 flex items-center justify-between gap-4 rounded-t-lg px-4 py-2 text-sm font-semibold">
      <span className="aui-code-header-language lowercase [&>span]:text-xs">{language}</span>
      <TooltipIconButton tooltip={t("ai:codeHeader.copy")} onClick={onCopy}>
        {!isCopied && <Icons.Copy />}
        {isCopied && <Icons.Check />}
      </TooltipIconButton>
    </div>
  );
};

const useCopyToClipboard = ({
  copiedDuration = 3000,
}: {
  copiedDuration?: number;
} = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;

    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};

/**
 * Custom link component that uses React Router for internal links.
 */
const MarkdownLink: FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = ({
  href,
  children,
  className,
  ...props
}) => {
  // Check if it's an internal link (starts with /)
  const isInternalLink = href?.startsWith("/");

  if (isInternalLink && href) {
    return (
      <Link
        to={href}
        className={cn("text-primary hover:text-primary/80 underline underline-offset-2", className)}
        {...props}
      >
        {children}
      </Link>
    );
  }

  // External link - open via platform adapter
  return (
    <ExternalLink
      href={href ?? "#"}
      className={cn("text-primary hover:text-primary/80 underline underline-offset-2", className)}
      {...props}
    >
      {children}
    </ExternalLink>
  );
};

/**
 * Custom components for elements that need special handling beyond prose defaults.
 * Most elements use Tailwind Typography prose-sm defaults automatically.
 */
const customComponents = memoizeMarkdownComponents({
  // Custom link handling for React Router
  a: MarkdownLink,
  // Custom code block styling with dark background
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "aui-md-pre not-prose overflow-x-auto rounded-b-lg rounded-t-none bg-black p-4 text-sm text-white",
        className,
      )}
      {...props}
    />
  ),
  // Inline code styling
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code bg-muted rounded border px-1.5 py-0.5 font-mono text-sm font-medium before:content-none after:content-none",
          className,
        )}
        {...props}
      />
    );
  },
  // Code header with copy button
  CodeHeader,
  // Tables with horizontal scroll for overflow content
  table: ({ className, ...props }) => (
    <div className="overflow-x-auto">
      <table
        className={cn(
          "aui-md-table not-prose my-3 w-full border-separate border-spacing-0 text-sm",
          className,
        )}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted whitespace-nowrap px-3 py-2 text-left text-xs font-semibold first:rounded-tl-lg last:rounded-tr-lg",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td whitespace-nowrap border-b border-l px-3 py-2 text-left text-sm last:border-r",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg",
        className,
      )}
      {...props}
    />
  ),
});
