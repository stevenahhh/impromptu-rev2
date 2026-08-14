import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "quiet" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: ButtonVariant;
}

export function Button({ children, className = "", variant = "primary", ...props }: ButtonProps) {
  return (
    <button className={`ui-button ui-button--${variant} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}
