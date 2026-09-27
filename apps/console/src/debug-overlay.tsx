"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  DEBUG_LOG_LEVELS,
  DEBUG_LOG_SOURCES,
  type DebugLogEntry,
  type DebugLogger,
  type DebugLogLevel,
  type DebugLogSource,
} from "./debug-log";
import "./debug-overlay.css";

const EMPTY_ENTRIES: readonly DebugLogEntry[] = Object.freeze([]);
type LevelFilter = "ALL" | DebugLogLevel;
type SourceFilter = "ALL" | DebugLogSource;

export interface DebugOverlayProps {
  readonly logger: DebugLogger;
}

function formatEntry(entry: DebugLogEntry): string {
  const parts = [`#${entry.seq}`, entry.timestamp, entry.level, entry.source, entry.message];
  if (entry.correlationId !== null) {
    parts.push(`corr=${entry.correlationId}`);
  }
  if (entry.outcome !== null) {
    parts.push(`outcome=${entry.outcome}`);
  }
  if (entry.durationMs !== null) {
    parts.push(`${entry.durationMs}ms`);
  }
  if (entry.detail !== null) {
    parts.push(JSON.stringify(entry.detail));
  }
  return parts.join(" ");
}

export function DebugOverlay({ logger }: DebugOverlayProps): React.JSX.Element | null {
  const [open, setOpen] = useState<boolean>(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("ALL");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("ALL");

  const getSnapshot = useCallback(() => logger.entries(), [logger]);
  const getServerSnapshot = useCallback(() => EMPTY_ENTRIES, []);
  const subscribe = useCallback(
    (onStoreChange: () => void) => logger.subscribe(onStoreChange),
    [logger],
  );
  const entries = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "d"
      ) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const visibleEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (levelFilter === "ALL" || entry.level === levelFilter) &&
          (sourceFilter === "ALL" || entry.source === sourceFilter),
      ),
    [entries, levelFilter, sourceFilter],
  );

  const onCopyAll = useCallback(() => {
    const text = visibleEntries.map(formatEntry).join("\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  }, [visibleEntries]);

  const onClear = useCallback(() => {
    logger.clear();
  }, [logger]);

  // Dev-only chrome: NODE_ENV is statically replaced in a production build, so this branch
  // and the toggle markup are stripped from the shipped bundle regardless of mount site.
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  return (
    <div className="debug-overlay" data-debug-overlay={open ? "open" : "closed"}>
      {open ? (
        <section aria-label="Debug log" className="debug-overlay__panel">
          <header className="debug-overlay__header">
            <span className="debug-overlay__title">Debug log ({visibleEntries.length})</span>
            <div className="debug-overlay__actions">
              <button
                className="debug-overlay__button"
                disabled={visibleEntries.length === 0}
                onClick={onCopyAll}
                type="button"
              >
                Copy all
              </button>
              <button className="debug-overlay__button" onClick={onClear} type="button">
                Clear
              </button>
            </div>
          </header>
          <div className="debug-overlay__filters">
            <label className="debug-overlay__filter-label">
              Level
              <select
                className="debug-overlay__select"
                data-debug-filter-level="true"
                onChange={(event) => setLevelFilter(event.target.value as LevelFilter)}
                value={levelFilter}
              >
                <option value="ALL">All levels</option>
                {DEBUG_LOG_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <label className="debug-overlay__filter-label">
              Source
              <select
                className="debug-overlay__select"
                data-debug-filter-source="true"
                onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
                value={sourceFilter}
              >
                <option value="ALL">All sources</option>
                {DEBUG_LOG_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ol className="debug-overlay__list">
            {visibleEntries.map((entry) => (
              <li
                className={`debug-overlay__row debug-overlay__row--${entry.level.toLowerCase()}`}
                data-debug-entry=""
                data-debug-level={entry.level}
                data-debug-source={entry.source}
                key={entry.seq}
              >
                <span className="debug-overlay__seq">#{entry.seq}</span>
                <span
                  className={`debug-overlay__badge debug-overlay__badge--${entry.level.toLowerCase()}`}
                >
                  {entry.level}
                </span>
                <span className="debug-overlay__source">{entry.source}</span>
                <span className="debug-overlay__message">{entry.message}</span>
                {entry.correlationId !== null ? (
                  <span className="debug-overlay__corr">{entry.correlationId}</span>
                ) : null}
                {entry.durationMs !== null ? (
                  <span className="debug-overlay__duration">{entry.durationMs}ms</span>
                ) : null}
                <span className="debug-overlay__time">{entry.timestamp}</span>
                {entry.detail !== null ? (
                  <code className="debug-overlay__detail">{JSON.stringify(entry.detail)}</code>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="debug-overlay__toggle"
        onClick={() => setOpen((current) => !current)}
        title="Toggle debug log (Ctrl/Cmd+Shift+D)"
        type="button"
      >
        Debug
      </button>
    </div>
  );
}
