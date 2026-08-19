"use client";

import dynamic from "next/dynamic";

const ConsoleClient = dynamic(
  () => import("./console-client").then((module) => module.ConsoleClient),
  { ssr: false },
);

export function ConsoleEntry() {
  return <ConsoleClient />;
}
