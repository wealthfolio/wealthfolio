import React, { useState, useMemo, useCallback } from "react";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { InputTags } from "@wealthfolio/ui/components/ui/tag-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { useI18n } from "@/i18n/i18n-provider";
import { cn } from "@/lib/utils";
import type { ChatThread } from "../types";

interface ThreadSidebarProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  isLoading?: boolean;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onRenameThread: (threadId: string, newTitle: string) => void;
  onDeleteThread: (threadId: string) => void;
  onTogglePin: (threadId: string, isPinned: boolean) => void;
  onAddTag: (threadId: string, tag: string) => void;
  onRemoveTag: (threadId: string, tag: string) => void;
  className?: string;
}

export function ThreadSidebar({
  threads,
  activeThreadId,
  isLoading,
  onSelectThread,
  onNewThread,
  onRenameThread,
  onDeleteThread,
  onTogglePin,
  onAddTag,
  onRemoveTag,
  className,
}: ThreadSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [tagsDialogOpen, setTagsDialogOpen] = useState(false);
  const [selectedThread, setSelectedThread] = useState<ChatThread | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [editingTags, setEditingTags] = useState<string[]>([]);
  const { language } = useI18n();
  const isChinese = language === "zh-CN";

  // Get all unique tags across all threads
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    threads.forEach((thread) => thread.tags?.forEach((tag) => tags.add(tag)));
    return Array.from(tags).sort();
  }, [threads]);

  // Filter threads by search query and tag filter
  const filteredThreads = useMemo(() => {
    let result = threads;

    // Filter by tag if selected
    if (filterTag) {
      result = result.filter((thread) => thread.tags?.includes(filterTag));
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((thread) =>
        (thread.title || "New conversation").toLowerCase().includes(query),
      );
    }

    return result;
  }, [threads, searchQuery, filterTag]);

  // Separate pinned and unpinned threads
  const { pinnedThreads, unpinnedThreads } = useMemo(() => {
    const pinned = filteredThreads.filter((t) => t.isPinned);
    const unpinned = filteredThreads.filter((t) => !t.isPinned);
    return { pinnedThreads: pinned, unpinnedThreads: unpinned };
  }, [filteredThreads]);

  const handleOpenRenameDialog = useCallback((thread: ChatThread) => {
    setSelectedThread(thread);
    setNewTitle(thread.title || "");
    setRenameDialogOpen(true);
  }, []);

  const handleOpenDeleteDialog = useCallback((thread: ChatThread) => {
    setSelectedThread(thread);
    setDeleteDialogOpen(true);
  }, []);

  const handleOpenTagsDialog = useCallback((thread: ChatThread) => {
    setSelectedThread(thread);
    setEditingTags(thread.tags || []);
    setTagsDialogOpen(true);
  }, []);

  const handleConfirmRename = useCallback(() => {
    if (selectedThread && newTitle.trim()) {
      onRenameThread(selectedThread.id, newTitle.trim());
    }
    setRenameDialogOpen(false);
    setSelectedThread(null);
    setNewTitle("");
  }, [selectedThread, newTitle, onRenameThread]);

  const handleConfirmDelete = useCallback(() => {
    if (selectedThread) {
      onDeleteThread(selectedThread.id);
    }
    setDeleteDialogOpen(false);
    setSelectedThread(null);
  }, [selectedThread, onDeleteThread]);

  const handleTagsChange: React.Dispatch<React.SetStateAction<string[]>> = useCallback(
    (action) => {
      if (!selectedThread) return;

      // Resolve the new tags value
      setEditingTags((prevTags) => {
        const newTags = typeof action === "function" ? action(prevTags) : action;

        const currentTags = selectedThread.tags || [];
        const tagsToAdd = newTags.filter((t) => !currentTags.includes(t));
        const tagsToRemove = currentTags.filter((t) => !newTags.includes(t));

        tagsToAdd.forEach((tag) => onAddTag(selectedThread.id, tag));
        tagsToRemove.forEach((tag) => onRemoveTag(selectedThread.id, tag));

        return newTags;
      });
    },
    [selectedThread, onAddTag, onRemoveTag],
  );

  const handleCloseTagsDialog = useCallback(() => {
    setTagsDialogOpen(false);
    setSelectedThread(null);
    setEditingTags([]);
  }, []);

  const handleTagFilterClick = useCallback((tag: string) => {
    setFilterTag((prev) => (prev === tag ? null : tag));
  }, []);

  const renderThread = (thread: ChatThread) => (
    <div
      key={thread.id}
      className={cn(
        "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        "hover:bg-accent cursor-pointer",
        activeThreadId === thread.id && "bg-accent",
      )}
    >
      <button
        onClick={() => onSelectThread(thread.id)}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
      >
        <div className="flex items-center gap-1.5">
          {thread.isPinned && <Icons.Pin className="text-muted-foreground h-3 w-3 shrink-0" />}
          <span className="truncate font-medium">{thread.title || "New conversation"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">
            {new Date(thread.updatedAt).toLocaleDateString()}
          </span>
          {thread.tags && thread.tags.length > 0 && (
            <div className="flex flex-wrap gap-0.5">
              {thread.tags.slice(0, 2).map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className="h-4 px-1 py-0 text-[10px] leading-none"
                >
                  {tag}
                </Badge>
              ))}
              {thread.tags.length > 2 && (
                <span className="text-muted-foreground text-[10px]">+{thread.tags.length - 2}</span>
              )}
            </div>
          )}
        </div>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Icons.MoreVertical className="h-4 w-4" />
            <span className="sr-only">Thread options</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => handleOpenRenameDialog(thread)}>
            <Icons.Pencil className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleOpenTagsDialog(thread)}>
            <Icons.Tag className="mr-2 h-4 w-4" />
            Edit tags
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onTogglePin(thread.id, !thread.isPinned)}>
            {thread.isPinned ? (
              <>
                <Icons.PinOff className="mr-2 h-4 w-4" />
                Unpin
              </>
            ) : (
              <>
                <Icons.Pin className="mr-2 h-4 w-4" />
                Pin
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => handleOpenDeleteDialog(thread)}
          >
            <Icons.Trash className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div className={cn("flex h-full flex-col border-r", className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="text-sm font-semibold">Conversations</h2>
        <Button variant="ghost" size="icon" onClick={onNewThread} className="h-8 w-8">
          <Icons.Plus className="h-4 w-4" />
          <span className="sr-only">New conversation</span>
        </Button>
      </div>

      {/* Search */}
      <div className="border-b p-2">
        <div className="relative">
          <Icons.Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <Input
            type="search"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      {/* Tag Filter */}
      {allTags.length > 0 && (
        <div className="scrollbar-thin flex gap-1 overflow-x-auto border-b p-2">
          {allTags.map((tag) => (
            <Badge
              key={tag}
              variant={filterTag === tag ? "default" : "outline"}
              className="shrink-0 cursor-pointer text-xs"
              onClick={() => handleTagFilterClick(tag)}
            >
              {tag}
              {filterTag === tag && <Icons.X className="ml-1 h-3 w-3" />}
            </Badge>
          ))}
        </div>
      )}

      {/* Thread List */}
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Icons.Spinner className="text-muted-foreground h-6 w-6 animate-spin" />
          </div>
        ) : threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Icons.Sparkles className="text-muted-foreground mb-2 h-8 w-8" />
            <p className="text-muted-foreground text-sm">No conversations yet</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Start a new chat to ask questions about your portfolio
            </p>
          </div>
        ) : filteredThreads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Icons.Search className="text-muted-foreground mb-2 h-6 w-6" />
            <p className="text-muted-foreground text-sm">No matches found</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {filterTag ? "Try clearing the tag filter" : "Try a different search term"}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Pinned threads */}
            {pinnedThreads.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1 flex items-center gap-1 px-2 text-xs font-medium">
                  <Icons.Pin className="h-3 w-3" />
                  Pinned
                </div>
                <div className="space-y-0.5">{pinnedThreads.map(renderThread)}</div>
              </div>
            )}

            {/* Unpinned threads */}
            {unpinnedThreads.length > 0 && (
              <div>
                {pinnedThreads.length > 0 && (
                  <div className="text-muted-foreground mb-1 px-2 text-xs font-medium">Recent</div>
                )}
                <div className="space-y-0.5">{unpinnedThreads.map(renderThread)}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
          </DialogHeader>
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Enter a new title..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleConfirmRename();
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmRename} disabled={!newTitle.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tags Dialog */}
      <Dialog open={tagsDialogOpen} onOpenChange={(open) => !open && handleCloseTagsDialog()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit tags</DialogTitle>
            <DialogDescription>Add or remove tags to organize this conversation.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="tags">Tags</Label>
            <InputTags
              id="tags"
              value={editingTags}
              onChange={handleTagsChange}
              placeholder="Type a tag and press Enter..."
            />
            <p className="text-muted-foreground text-xs">
              Press Enter or comma to add a tag. Backspace to remove the last tag.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={handleCloseTagsDialog}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isChinese ? "要删除对话吗？" : "Delete conversation?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isChinese
                ? `这会永久删除“${selectedThread?.title ?? "此对话"}”及其全部消息。此操作无法撤销。`
                : `This will permanently delete “${selectedThread?.title ?? "this conversation"}” and all its messages. This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              <Icons.Trash className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
