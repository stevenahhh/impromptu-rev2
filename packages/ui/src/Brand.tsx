import type { HTMLAttributes } from "react";

export interface BrandProps extends HTMLAttributes<HTMLDivElement> {
  eyebrow: string;
  name?: string;
}

export function Brand({ className = "", eyebrow, name = "Impromptu", ...props }: BrandProps) {
  return (
    <div className={`ui-brand ${className}`.trim()} {...props}>
      <span className="ui-brand__mark" aria-hidden="true">
        I
      </span>
      <span className="ui-brand__copy">
        <span className="ui-brand__name">{name}</span>
        <span className="ui-brand__eyebrow">{eyebrow}</span>
      </span>
    </div>
  );
}
