export interface SkipLinkProps {
  label?: string;
  targetId: string;
}

export function SkipLink({ label = "Skip to content", targetId }: SkipLinkProps) {
  return (
    <a className="ui-skip-link" href={`#${targetId}`}>
      {label}
    </a>
  );
}
