/** Stage publishes lifecycle events on the window bus so an embedder can observe the public
 * surface without that surface ever carrying private session or evidence data. */
export function publishStageEvent(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}
