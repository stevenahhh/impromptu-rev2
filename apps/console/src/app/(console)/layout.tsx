import "@impromptu/ui/styles.css";
import "../../console.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  description: "Private presentation setup and control workspace.",
  manifest: "/manifest.webmanifest",
  title: "Impromptu Presenter Console",
};

export default function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="ko" data-surface="console">
      <body>{children}</body>
    </html>
  );
}
