import type { HTMLAttributes, ReactNode } from "react";

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  action?: ReactNode;
  children: ReactNode;
  title?: string;
  tone?: "default" | "inset";
}

export function Panel({
  action,
  children,
  className = "",
  title,
  tone = "default",
  ...props
}: PanelProps) {
  const toneClass = tone === "inset" ? " ui-panel--inset" : "";
  return (
    <section className={`ui-panel${toneClass} ${className}`.trim()} {...props}>
      {title ? (
        <header className="ui-panel__header">
          <h2 className="ui-panel__title">{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}
