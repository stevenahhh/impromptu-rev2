import "@impromptu/ui/styles.css";
import "../../console.css";

import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";

// Nonce-bearing CSP requires request-time rendering so Next can apply the middleware nonce to
// every framework script tag.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Private presentation setup and control workspace.",
  manifest: "/manifest.webmanifest",
  title: "Impromptu Presenter Console",
};

export default function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  const stageOrigin = process.env.STAGE_ORIGIN ?? process.env.NEXT_PUBLIC_STAGE_ORIGIN;
  // A blank override must never reach the client: window.__STAGE_ORIGIN="" would turn every
  // stageUrl() into a relative URL on the console's own origin. Emit the script only for a
  // real value; stage-origin.ts re-validates whatever lands here.
  const injectedOrigin =
    typeof stageOrigin === "string" && stageOrigin.trim() !== "" ? stageOrigin : null;
  return (
    <html lang="ko" data-surface="console">
      <body>
        {injectedOrigin === null ? null : (
          <Script strategy="beforeInteractive">
            {`window.__STAGE_ORIGIN=${JSON.stringify(injectedOrigin)};`}
          </Script>
        )}
        {children}
      </body>
    </html>
  );
}
