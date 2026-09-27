import type { CoachingState } from "@impromptu/state/coaching";
import { Panel } from "@impromptu/ui";

export type CoachingDisplayText = Readonly<{
  title: string;
  optIn: string;
  mute: string;
  unavailable: string;
  currentPace: string;
  previousPace: string;
  delta: string;
  cueCount: string;
}>;

export interface CoachingDisplayProps {
  readonly state: CoachingState;
  readonly text: CoachingDisplayText;
  readonly wordTimingCapable: boolean;
  readonly onOptInChange: (enabled: boolean) => void;
  readonly onMuteChange: (muted: boolean) => void;
}

function pace(value: number): string {
  return `${value} WPM`;
}

function delta(value: number): string {
  return `${value > 0 ? "+" : ""}${value} WPM`;
}

export function CoachingDisplay({
  onMuteChange,
  onOptInChange,
  state,
  text,
  wordTimingCapable,
}: CoachingDisplayProps) {
  const measurementAvailable = wordTimingCapable && state.measurement.outcome === "AVAILABLE";

  // Before opt-in the surface holds a full panel of space for nothing; it stays one checkbox tall
  // until the presenter opts in. This only changes how much room the panel takes — never when or
  // how coaching state itself is gated.
  if (!state.optedIn) {
    return (
      <div className="console-coaching console-coaching--folded" data-coaching-folded="FOLDED">
        <label className="console-consent-check">
          <input
            type="checkbox"
            checked={state.optedIn}
            onChange={(event) => onOptInChange(event.currentTarget.checked)}
          />
          {text.optIn}
        </label>
      </div>
    );
  }

  return (
    <Panel className="console-coaching" title={text.title} tone="inset">
      <label className="console-consent-check">
        <input
          type="checkbox"
          checked={state.optedIn}
          onChange={(event) => onOptInChange(event.currentTarget.checked)}
        />
        {text.optIn}
      </label>
      <label className="console-consent-check">
        <input
          type="checkbox"
          checked={state.muted}
          disabled={!state.optedIn}
          onChange={(event) => onMuteChange(event.currentTarget.checked)}
        />
        {text.mute}
      </label>
      <div aria-live="polite" aria-atomic="true">
        {!state.optedIn || state.muted ? null : measurementAvailable ? (
          <dl className="console-consent-notice" data-coaching-state="available">
            <div>
              <dt>{text.currentPace}</dt>
              <dd data-coaching-metric="current">
                {pace(state.measurement.currentWordsPerMinute)}
              </dd>
            </div>
            <div>
              <dt>{text.previousPace}</dt>
              <dd data-coaching-metric="previous">
                {pace(state.measurement.previousWordsPerMinute)}
              </dd>
            </div>
            <div>
              <dt>{text.delta}</dt>
              <dd data-coaching-metric="delta">{delta(state.measurement.deltaWordsPerMinute)}</dd>
            </div>
            <div>
              <dt>{text.cueCount}</dt>
              <dd data-coaching-metric="cue-count">{state.cueCount}</dd>
            </div>
          </dl>
        ) : (
          <output className="console-caption" data-coaching-state="unavailable">
            {text.unavailable}
          </output>
        )}
      </div>
    </Panel>
  );
}
