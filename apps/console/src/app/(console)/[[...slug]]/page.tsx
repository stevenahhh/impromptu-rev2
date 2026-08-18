import { DEFAULT_PRESENTATION_TEMPLATES } from "../../../presentation-templates";
import { ConsoleEntry } from "../console-entry";

export default function ConsolePage() {
  return <ConsoleEntry templates={DEFAULT_PRESENTATION_TEMPLATES} />;
}
