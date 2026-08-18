const DEFAULT_PRIVATE_API_ORIGIN = "http://127.0.0.1:3001";

export function consolePrivateApiOrigin(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment.CONSOLE_PRIVATE_API_ORIGIN?.trim();
  return configured === undefined || configured.length === 0
    ? DEFAULT_PRIVATE_API_ORIGIN
    : configured;
}
