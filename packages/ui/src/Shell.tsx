import { type HTMLAttributes, type ReactNode, useId } from "react";

import { SkipLink } from "./SkipLink";

export interface ShellProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  focused?: boolean;
  header: ReactNode;
}

export function Shell({ children, className = "", focused = false, header, ...props }: ShellProps) {
  const mainId = useId();

  return (
    <div className={`ui-shell ${className}`.trim()} {...props}>
      <SkipLink targetId={mainId} />
      <header className="ui-shell__header">{header}</header>
      <main id={mainId} className={`ui-shell__body${focused ? " ui-shell__body--focused" : ""}`}>
        {children}
      </main>
    </div>
  );
}
