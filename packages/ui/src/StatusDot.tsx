import type { HTMLAttributes } from "react";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  label: string;
}

export function StatusDot({ label, ...props }: StatusDotProps) {
  return <span className="ui-status-dot" aria-label={label} role="img" {...props} />;
}
