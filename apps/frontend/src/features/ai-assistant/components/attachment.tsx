import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAssistantApi,
  useAssistantState,
} from "@assistant-ui/react";
import { PropsWithChildren, useEffect, useState, type FC } from "react";
import { useTranslation } from "react-i18next";

import { Icons, type Icon } from "@wealthfolio/ui/components/ui/icons";
import { useShallow } from "zustand/shallow";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@wealthfolio/ui/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@wealthfolio/ui/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { TooltipIconButton } from "./tooltip-icon-button";

const useFileSrc = (file: File | undefined) => {
  const [src, setSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      setSrc(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return src;
};

const useAttachmentSrc = () => {
  const { file, src } = useAssistantState(
    useShallow(({ attachment }): { file?: File; src?: string } => {
      if (attachment.type !== "image") return {};
      if (attachment.file) return { file: attachment.file };
      const src = attachment.content?.find((c) => c.type === "image")?.image;
      if (!src) return {};
      return { src };
    }),
  );

  return useFileSrc(file) ?? src;
};

interface AttachmentPreviewProps {
  src: string;
}

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const { t } = useTranslation();
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt={t("ai:attachment.imagePreview")}
      className={
        isLoaded
          ? "aui-attachment-preview-image-loaded block h-auto max-h-[80vh] w-auto max-w-full object-contain"
          : "aui-attachment-preview-image-loading hidden"
      }
      onLoad={() => setIsLoaded(true)}
    />
  );
};

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const { t } = useTranslation();
  const src = useAttachmentSrc();

  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger hover:bg-accent/50 cursor-pointer transition-colors"
        asChild
      >
        {children}
      </DialogTrigger>
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&_svg]:text-background [&>button]:hover:[&_svg]:text-destructive [&>button]:ring-0! p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100">
        <DialogTitle className="aui-sr-only sr-only">
          {t("ai:attachment.imageAttachmentPreview")}
        </DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC = () => {
  const { t } = useTranslation();
  const isImage = useAssistantState(({ attachment }) => attachment.type === "image");
  const src = useAttachmentSrc();

  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <AvatarImage
        src={src}
        alt={t("ai:attachment.attachmentPreview")}
        className="aui-attachment-tile-image object-cover"
      />
      <AvatarFallback delayMs={isImage ? 200 : 0}>
        <Icons.FileText className="aui-attachment-tile-fallback-icon text-muted-foreground size-8" />
      </AvatarFallback>
    </Avatar>
  );
};

const getAttachmentExtension = (name: string) => {
  const fileName = name.split(/[\\/]/).pop() ?? name;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return "FILE";
  return fileName
    .slice(dotIndex + 1)
    .slice(0, 5)
    .toUpperCase();
};

const getAttachmentIcon = (name: string, contentType: string): Icon => {
  const normalizedName = name.toLowerCase();
  const normalizedType = contentType.toLowerCase();

  if (normalizedType.includes("csv") || normalizedName.endsWith(".csv")) return Icons.FileCsv;
  if (
    normalizedType.includes("spreadsheet") ||
    normalizedType.includes("excel") ||
    normalizedName.endsWith(".xls") ||
    normalizedName.endsWith(".xlsx") ||
    normalizedName.endsWith(".ods")
  ) {
    return Icons.FileSpreadsheet;
  }
  if (normalizedType.includes("json") || normalizedName.endsWith(".json")) return Icons.FileJson;
  if (normalizedType.startsWith("image/")) return Icons.FileImage;
  if (normalizedType.startsWith("audio/")) return Icons.FileAudio;
  if (normalizedType.startsWith("video/")) return Icons.FileVideo;
  if (
    normalizedType.includes("zip") ||
    normalizedType.includes("archive") ||
    normalizedName.endsWith(".zip")
  ) {
    return Icons.FileArchive;
  }
  if (
    normalizedType.startsWith("text/") ||
    normalizedType.includes("pdf") ||
    normalizedName.endsWith(".txt") ||
    normalizedName.endsWith(".pdf")
  ) {
    return Icons.FileText;
  }

  return Icons.File;
};

const ComposerFileAttachment: FC = () => {
  const { t } = useTranslation();
  const name = useAssistantState(({ attachment }) => attachment.name);
  const contentType = useAssistantState(({ attachment }) => attachment.contentType);
  const FileIcon = getAttachmentIcon(name, contentType);
  const extension = getAttachmentExtension(name);

  return (
    <div
      className="aui-attachment-file-chip bg-muted/60 border-border/70 hover:bg-muted flex h-11 max-w-[18rem] cursor-pointer items-center gap-2 rounded-xl border py-1.5 pl-2.5 pr-8 text-left transition-colors"
      role="button"
      id="attachment-tile"
      aria-label={t("ai:attachment.fileAttachment", { name })}
    >
      <span className="aui-attachment-file-chip-icon bg-background/80 text-foreground/75 flex size-7 shrink-0 items-center justify-center rounded-lg border">
        <FileIcon className="size-4" />
      </span>
      <span className="aui-attachment-file-chip-name min-w-0 flex-1 truncate text-sm font-medium">
        {name}
      </span>
      <span className="aui-attachment-file-chip-extension text-muted-foreground shrink-0 text-[10px] font-semibold uppercase leading-none">
        {extension}
      </span>
    </div>
  );
};

const AttachmentUI: FC = () => {
  const { t } = useTranslation();
  const api = useAssistantApi();
  const isComposer = api.attachment.source === "composer";

  const isImage = useAssistantState(({ attachment }) => attachment.type === "image");
  const typeLabel = useAssistantState(({ attachment }) => {
    const type = attachment.type;
    switch (type) {
      case "image":
        return t("ai:attachment.type.image");
      case "document":
        return t("ai:attachment.type.document");
      case "file":
        return t("ai:attachment.type.file");
      default:
        const _exhaustiveCheck: never = type;
        throw new Error(`Unknown attachment type: ${_exhaustiveCheck}`);
    }
  });

  return (
    <Tooltip>
      <AttachmentPrimitive.Root
        className={cn(
          "aui-attachment-root relative",
          isImage && "aui-attachment-root-composer only:[&>#attachment-tile]:size-24",
        )}
      >
        <AttachmentPreviewDialog>
          <TooltipTrigger asChild>
            {isComposer && !isImage ? (
              <ComposerFileAttachment />
            ) : (
              <div
                className={cn(
                  "aui-attachment-tile bg-muted size-14 cursor-pointer overflow-hidden rounded-[14px] border transition-opacity hover:opacity-75",
                  isComposer && "aui-attachment-tile-composer border-foreground/20",
                )}
                role="button"
                id="attachment-tile"
                aria-label={t("ai:attachment.typedAttachment", { type: typeLabel })}
              >
                <AttachmentThumb />
              </div>
            )}
          </TooltipTrigger>
        </AttachmentPreviewDialog>
        {isComposer && <AttachmentRemove variant={isImage ? "tile" : "chip"} />}
      </AttachmentPrimitive.Root>
      <TooltipContent side="top">
        <AttachmentPrimitive.Name />
      </TooltipContent>
    </Tooltip>
  );
};

interface AttachmentRemoveProps {
  variant?: "tile" | "chip";
}

const AttachmentRemove: FC<AttachmentRemoveProps> = ({ variant = "tile" }) => {
  const { t } = useTranslation();
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip={t("ai:attachment.removeFile")}
        className={cn(
          "aui-attachment-tile-remove text-muted-foreground hover:[&_svg]:text-destructive hover:bg-white! absolute rounded-full bg-white opacity-100 shadow-sm [&_svg]:text-black",
          variant === "chip"
            ? "right-1.5 top-1/2 size-5 -translate-y-1/2"
            : "right-1.5 top-1.5 size-3.5",
        )}
        side="top"
      >
        <Icons.Close
          className={cn(
            "aui-attachment-remove-icon dark:stroke-[2.5px]",
            variant === "chip" ? "size-3.5" : "size-3",
          )}
        />
      </TooltipIconButton>
    </AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
      <MessagePrimitive.Attachments components={{ Attachment: AttachmentUI }} />
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments mb-2 flex w-full flex-row items-center gap-2 overflow-x-auto px-1.5 pb-1 pt-0.5 empty:hidden">
      <ComposerPrimitive.Attachments components={{ Attachment: AttachmentUI }} />
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  const { t } = useTranslation();
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip={t("ai:attachment.addAttachment")}
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-[34px] rounded-full p-1 text-xs font-semibold"
        aria-label={t("ai:attachment.addAttachment")}
      >
        <Icons.Plus className="aui-attachment-add-icon size-5 stroke-[1.5px]" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
};
