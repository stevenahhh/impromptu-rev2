import { ConsoleEntry } from "../console-entry";
import { DEFAULT_PRESENTATION_TEMPLATES } from "../../../presentation-templates";

export default function ConsolePage() {
  return <ConsoleEntry templates={DEFAULT_PRESENTATION_TEMPLATES} />;
}
