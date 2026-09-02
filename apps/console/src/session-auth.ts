// Account registration and presenter session lifecycle against the private backend.

import { mutationHeaders, type PrivateClientContext, responseBody } from "./private-transport";

export interface AccountRegistrationView {
  readonly account: { readonly accountId: string };
}

export type AccountRegistrationFailure =
  | "USERNAME_TAKEN"
  | "USERNAME_INVALID"
  | "PASSWORD_TOO_SHORT"
  | "UNKNOWN";

export class AccountRegistrationError extends Error {
  readonly status: number;
  readonly reason: AccountRegistrationFailure;

  constructor(reason: AccountRegistrationFailure, status: number) {
    super("Account registration was rejected.");
    this.name = "AccountRegistrationError";
    this.reason = reason;
    this.status = status;
  }
}

export interface AccountSessionView {
  readonly account: { readonly accountId: string; readonly actorId: string };
  readonly expiresAtMs: number;
  readonly csrfToken: string;
}

function isAccountRegistrationView(value: unknown): value is AccountRegistrationView {
  if (typeof value !== "object" || value === null) return false;
  const account = Reflect.get(value, "account");
  return (
    typeof account === "object" &&
    account !== null &&
    typeof Reflect.get(account, "accountId") === "string"
  );
}

function accountRegistrationFailure(body: unknown, status: number): AccountRegistrationFailure {
  if (status === 409) return "USERNAME_TAKEN";
  if (status !== 400 || typeof body !== "object" || body === null) return "UNKNOWN";
  const reason = Reflect.get(body, "error");
  if (reason === "USERNAME_INVALID" || reason === "PASSWORD_TOO_SHORT") return reason;
  return "UNKNOWN";
}

function isAccountSessionView(value: unknown): value is AccountSessionView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const account = candidate.account;
  return (
    typeof account === "object" &&
    account !== null &&
    typeof (account as Record<string, unknown>).accountId === "string" &&
    typeof (account as Record<string, unknown>).actorId === "string" &&
    typeof candidate.expiresAtMs === "number" &&
    typeof candidate.csrfToken === "string"
  );
}

export async function signUp(
  context: PrivateClientContext,
  username: string,
  password: string,
): Promise<AccountRegistrationView> {
  const response = await fetch(`${context.baseUrl}/v1/accounts`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(),
    body: JSON.stringify({ username, password }),
  });
  const body = await responseBody(response);
  if (!response.ok || !isAccountRegistrationView(body)) {
    throw new AccountRegistrationError(
      accountRegistrationFailure(body, response.status),
      response.status,
    );
  }
  return body;
}

export async function signIn(
  context: PrivateClientContext,
  username: string,
  password: string,
): Promise<AccountSessionView> {
  const response = await fetch(`${context.baseUrl}/v1/account-sessions`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(),
    body: JSON.stringify({ username, password }),
  });
  const body = await responseBody(response);
  if (!response.ok || !isAccountSessionView(body)) throw new Error("Sign-in was rejected.");
  return body;
}

export async function readSession(
  context: PrivateClientContext,
): Promise<AccountSessionView | null> {
  const response = await fetch(`${context.baseUrl}/v1/account-session`, {
    credentials: "include",
  });
  if (response.status === 401) return null;
  const body = await responseBody(response);
  if (!response.ok || !isAccountSessionView(body)) throw new Error("Session could not be read.");
  return body;
}

export async function signOut(context: PrivateClientContext, csrfToken: string): Promise<void> {
  const response = await fetch(`${context.baseUrl}/v1/account-session`, {
    method: "DELETE",
    credentials: "include",
    headers: mutationHeaders(csrfToken),
  });
  if (!response.ok) throw new Error("Sign-out was rejected.");
}
