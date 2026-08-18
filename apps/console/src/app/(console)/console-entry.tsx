"use client";

import dynamic from "next/dynamic";

import type { PresentationTemplate } from "../../presentation-templates";

const ConsoleClient = dynamic(
  () => import("./console-client").then((module) => module.ConsoleClient),
  { ssr: false },
);

export function ConsoleEntry({
  templates,
}: {
  readonly templates: readonly PresentationTemplate[];
}) {
  return <ConsoleClient templates={templates} />;
}
