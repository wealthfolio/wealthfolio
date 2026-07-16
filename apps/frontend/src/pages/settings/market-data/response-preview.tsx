import { Fragment, useMemo } from "react";

import { cn } from "@/lib/utils";
import { appendJsonPathKey } from "./json-path-suggestions";

interface RawResponseViewerProps {
  rawResponse: string;
  format: "json" | "html";
  onPathClick?: (path: string) => void;
}

/** Scrollable raw response viewer. JSON gets clickable leaves; HTML is plain text. */
export function RawResponseViewer({ rawResponse, format, onPathClick }: RawResponseViewerProps) {
  if (format === "json") {
    return <JsonTreeViewer rawResponse={rawResponse} onPathClick={onPathClick} />;
  }
  return (
    <pre className="text-muted-foreground whitespace-pre-wrap break-all p-3 text-[12px] leading-relaxed">
      {rawResponse}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// JSON tree
// ---------------------------------------------------------------------------

const INDENT = "  ";

function JsonTreeViewer({
  rawResponse,
  onPathClick,
}: {
  rawResponse: string;
  onPathClick?: (path: string) => void;
}) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(rawResponse) as unknown };
    } catch {
      return { ok: false as const };
    }
  }, [rawResponse]);

  if (!parsed.ok) {
    return (
      <pre className="text-muted-foreground whitespace-pre-wrap break-all p-3 text-[12px] leading-relaxed">
        {rawResponse}
      </pre>
    );
  }

  return (
    <pre className="p-3 font-mono text-[12px] leading-relaxed">
      <JsonValue value={parsed.value} path="$" depth={0} onSelect={onPathClick} />
    </pre>
  );
}

function JsonValue({
  value,
  path,
  depth,
  onSelect,
}: {
  value: unknown;
  path: string;
  depth: number;
  onSelect?: (path: string) => void;
}): React.ReactElement {
  if (value === null || value === undefined)
    return <PrimitiveSpan kind="null" display="null" path={path} onSelect={onSelect} />;
  if (typeof value === "boolean")
    return <PrimitiveSpan kind="bool" display={String(value)} path={path} onSelect={onSelect} />;
  if (typeof value === "number")
    return <PrimitiveSpan kind="number" display={String(value)} path={path} onSelect={onSelect} />;
  if (typeof value === "string")
    return (
      <PrimitiveSpan
        kind="string"
        display={JSON.stringify(value)}
        path={path}
        onSelect={onSelect}
      />
    );

  if (Array.isArray(value))
    return <ArrayBlock items={value} path={path} depth={depth} onSelect={onSelect} />;

  if (typeof value === "object") {
    return (
      <ObjectBlock
        entries={Object.entries(value as Record<string, unknown>)}
        path={path}
        depth={depth}
        onSelect={onSelect}
      />
    );
  }

  // Unreachable under typed JSON input; fallback for exhaustive safety.
  return <span className="text-muted-foreground">…</span>;
}

function ArrayBlock({
  items,
  path,
  depth,
  onSelect,
}: {
  items: unknown[];
  path: string;
  depth: number;
  onSelect?: (path: string) => void;
}) {
  if (items.length === 0) return <span>[]</span>;
  const pad = INDENT.repeat(depth + 1);
  const padClose = INDENT.repeat(depth);
  return (
    <>
      {"["}
      {"\n"}
      {items.map((item, i) => {
        // Path: use `[*]` for the first element (acts as the "all items" hint),
        // `[i]` for the rest. Users wanting a specific index can edit manually.
        const childPath = `${path}[${i === 0 ? "*" : i}]`;
        const last = i === items.length - 1;
        return (
          <Fragment key={i}>
            {pad}
            <JsonValue value={item} path={childPath} depth={depth + 1} onSelect={onSelect} />
            {!last && ","}
            {"\n"}
          </Fragment>
        );
      })}
      {padClose}
      {"]"}
    </>
  );
}

function ObjectBlock({
  entries,
  path,
  depth,
  onSelect,
}: {
  entries: [string, unknown][];
  path: string;
  depth: number;
  onSelect?: (path: string) => void;
}) {
  if (entries.length === 0) return <span>{"{}"}</span>;
  const pad = INDENT.repeat(depth + 1);
  const padClose = INDENT.repeat(depth);
  return (
    <>
      {"{"}
      {"\n"}
      {entries.map(([key, val], i) => {
        const childPath = appendJsonPathKey(path, key);
        const last = i === entries.length - 1;
        return (
          <Fragment key={key}>
            {pad}
            <Entry
              keyName={key}
              value={val}
              path={childPath}
              depth={depth + 1}
              onSelect={onSelect}
            />
            {!last && ","}
            {"\n"}
          </Fragment>
        );
      })}
      {padClose}
      {"}"}
    </>
  );
}

/** One `"key": value` line. Primitive values make the whole line clickable. */
function Entry({
  keyName,
  value,
  path,
  depth,
  onSelect,
}: {
  keyName: string;
  value: unknown;
  path: string;
  depth: number;
  onSelect?: (path: string) => void;
}) {
  const isPrimitive =
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";

  if (isPrimitive && onSelect) {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={() => onSelect(path)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(path);
          }
        }}
        title={path}
        className="hover:bg-primary/10 focus:bg-primary/10 -mx-1 cursor-pointer rounded px-1 outline-none focus:outline-none"
      >
        <KeyLabel keyName={keyName} />
        {": "}
        <JsonValue value={value} path={path} depth={depth} onSelect={undefined} />
      </span>
    );
  }

  // Non-primitive (object/array) — key label is inert; nested content renders its own clickable leaves
  return (
    <>
      <KeyLabel keyName={keyName} />
      {": "}
      <JsonValue value={value} path={path} depth={depth} onSelect={onSelect} />
    </>
  );
}

function KeyLabel({ keyName }: { keyName: string }) {
  return <span className="text-slate-500 dark:text-slate-400">{JSON.stringify(keyName)}</span>;
}

/** Primitive leaf. When `onSelect` is provided (standalone value, not inside an
 *  Entry line), the span is itself clickable. When `onSelect` is undefined the
 *  wrapping Entry handles the click, so this renders as plain text. */
function PrimitiveSpan({
  kind,
  display,
  path,
  onSelect,
}: {
  kind: "string" | "number" | "bool" | "null";
  display: string;
  path: string;
  onSelect?: (path: string) => void;
}) {
  const colorClass = cn(
    kind === "number" && "text-sky-600 dark:text-sky-400",
    kind === "string" && "text-emerald-700 dark:text-emerald-400",
    kind === "bool" && "text-violet-600 dark:text-violet-400",
    kind === "null" && "text-muted-foreground",
  );

  if (!onSelect) {
    return <span className={colorClass}>{display}</span>;
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => onSelect(path)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(path);
        }
      }}
      title={path}
      className={cn(
        colorClass,
        "hover:bg-primary/10 focus:bg-primary/10 -mx-0.5 cursor-pointer rounded px-0.5 outline-none focus:outline-none",
      )}
    >
      {display}
    </span>
  );
}
