import type { HTMLAttributes, ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warning";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: BadgeTone;
}

export function Badge({ children, className = "", tone = "neutral", ...props }: BadgeProps) {
  const toneClass = tone === "neutral" ? "" : ` ui-badge--${tone}`;
  return (
    <span className={`ui-badge${toneClass} ${className}`.trim()} {...props}>
      {children}
    </span>
  );
}
