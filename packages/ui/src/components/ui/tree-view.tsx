"use client";

import { cn } from "@/lib/utils";
import * as React from "react";
import { Icons } from "./icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";

// Types
export interface TreeNode {
  id: string;
  name: string;
  children?: TreeNode[];
  icon?: React.ReactNode;
  color?: string;
  data?: unknown;
}

interface TreeViewProps {
  data: TreeNode[];
  selectedId?: string | null;
  onSelect?: (node: TreeNode) => void;
  className?: string;
  expandedIds?: Set<string>;
  onExpandedChange?: (expandedIds: Set<string>) => void;
  defaultExpandedIds?: string[];
}

interface TreeItemProps {
  node: TreeNode;
  level: number;
  selectedId?: string | null;
  onSelect?: (node: TreeNode) => void;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
}

// TreeItem component (recursive)
function TreeItem({ node, level, selectedId, onSelect, expandedIds, onToggle }: TreeItemProps) {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;

  return (
    <div className="select-none">
      <Collapsible open={isExpanded} onOpenChange={() => hasChildren && onToggle(node.id)}>
        <div
          className={cn(
            "flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors",
            "hover:bg-muted/50",
            isSelected && "bg-accent text-accent-foreground",
          )}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          onClick={() => onSelect?.(node)}
        >
          {hasChildren ? (
            <CollapsibleTrigger
              render={
                <button
                  className="hover:bg-muted flex h-5 w-5 shrink-0 items-center justify-center rounded-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(node.id);
                  }}
                />
              }
            >
              <Icons.ChevronRight
                className={cn("h-4 w-4 transition-transform duration-200", isExpanded && "rotate-90")}
              />
            </CollapsibleTrigger>
          ) : (
            <span className="w-5" />
          )}

          <span className="shrink-0">
            {node.icon ? (
              node.icon
            ) : node.color ? (
              <Icons.Tag className="h-4 w-4" style={{ color: node.color }} />
            ) : hasChildren ? (
              isExpanded ? (
                <Icons.FolderOpen className="text-muted-foreground h-4 w-4" />
              ) : (
                <Icons.Folder className="text-muted-foreground h-4 w-4" />
              )
            ) : (
              <Icons.File className="text-muted-foreground h-4 w-4" />
            )}
          </span>

          <span className="truncate">{node.name}</span>
        </div>

        {hasChildren && (
          <CollapsibleContent className="data-ending-style:h-0 data-starting-style:h-0 h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out">
            {node.children!.map((child) => (
              <TreeItem
                key={child.id}
                node={child}
                level={level + 1}
                selectedId={selectedId}
                onSelect={onSelect}
                expandedIds={expandedIds}
                onToggle={onToggle}
              />
            ))}
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}

// Main TreeView component
export function TreeView({
  data,
  selectedId,
  onSelect,
  className,
  expandedIds: controlledExpandedIds,
  onExpandedChange,
  defaultExpandedIds = [],
}: TreeViewProps) {
  const [internalExpandedIds, setInternalExpandedIds] = React.useState<Set<string>>(() => new Set(defaultExpandedIds));

  const expandedIds = controlledExpandedIds ?? internalExpandedIds;
  const setExpandedIds = onExpandedChange ?? setInternalExpandedIds;

  const handleToggle = React.useCallback(
    (id: string) => {
      const next = new Set(expandedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      setExpandedIds(next);
    },
    [expandedIds, setExpandedIds],
  );

  return (
    <div className={cn("py-2", className)} role="tree">
      {data.map((node) => (
        <TreeItem
          key={node.id}
          node={node}
          level={0}
          selectedId={selectedId}
          onSelect={onSelect}
          expandedIds={expandedIds}
          onToggle={handleToggle}
        />
      ))}
    </div>
  );
}

// Helper to convert flat categories to tree structure
export function buildCategoryTree<T extends { id: string; parentId?: string | null; name: string; color?: string }>(
  categories: T[],
): TreeNode[] {
  const map = new Map<string, TreeNode & { originalData: T }>();
  const roots: TreeNode[] = [];

  // First pass: create all nodes
  for (const cat of categories) {
    map.set(cat.id, {
      id: cat.id,
      name: cat.name,
      children: [],
      color: cat.color,
      data: cat,
      originalData: cat,
    });
  }

  // Second pass: build tree structure
  for (const cat of categories) {
    const node = map.get(cat.id)!;
    if (cat.parentId && map.has(cat.parentId)) {
      map.get(cat.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
