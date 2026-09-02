import type { IngestionJson } from "../deck-render-subprocess.ts";
import { MAX_CHUNK_CHARACTERS } from "./deck-retrieval-model.ts";

export type StructuralElement = IngestionJson["manifest"]["slides"][number]["elements"][number];

export function extractStructuralText(elements: readonly StructuralElement[]): string {
  const values = elements.flatMap((element) => {
    if (element.kind === "text") return [element.text];
    if (element.kind === "table") return element.rows.map((row) => row.join(" "));
    if (element.kind === "chart") {
      return [
        element.chart_type,
        ...element.categories,
        ...element.series.flatMap((series) => [series.name, ...series.values]),
      ];
    }
    return [];
  });
  return values
    .join("\n")
    .replace(/<(?:date\/time|footer|number)>/gi, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

export function chunkText(text: string): readonly string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += MAX_CHUNK_CHARACTERS) {
    const chunk = text.slice(start, start + MAX_CHUNK_CHARACTERS).trim();
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks;
}
