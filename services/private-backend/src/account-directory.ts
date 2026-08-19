import { AccountIdSchema } from "@impromptu/contracts/private";

/**
 * Username/password account directory for the private controller.
 *
 * This is an authentication boundary, not tenant-owned data: a caller has no
 * account context until credentials verify, so the directory is deliberately
 * separate from the tenant-scoped presentation store.
 *
 * Every verified sign-in mints a fresh actor identity. One account may be
 * signed in from several devices, and the playback lease must be able to tell
 * those devices apart.
 */

export interface AccountCredentials {
  readonly username: string;
  readonly password: string;
}

export interface VerifiedAccountIdentity {
  readonly accountId: string;
  readonly actorId: string;
}

export interface AccountRecord {
  readonly accountId: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly createdAtMs: number;
  readonly disabledAtMs: number | null;
}

export type AccountRegistration =
  | { readonly outcome: "APPLIED"; readonly value: { readonly accountId: string } }
  | { readonly outcome: "REJECTED"; readonly reason: AccountRegistrationRejection };

export type AccountRegistrationRejection =
  | "USERNAME_TAKEN"
  | "USERNAME_INVALID"
  | "PASSWORD_TOO_SHORT";

export interface AccountStore {
  readByUsername(username: string): Promise<AccountRecord | null>;
  insert(record: AccountRecord): Promise<"INSERTED" | "USERNAME_TAKEN">;
}

export interface AccountRegistrationOptions {
  /**
   * Pins the generated account identifier. Used to bootstrap a deployment's
   * first operator so that a restart keeps ownership of presentations that
   * were persisted under that account.
   */
  readonly accountId?: string;
}

export interface AccountDirectory {
  register(
    credentials: AccountCredentials,
    nowMs: number,
    options?: AccountRegistrationOptions,
  ): Promise<AccountRegistration>;
  verifyCredentials(username: string, password: string): Promise<VerifiedAccountIdentity | null>;
}

const MINIMUM_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;

/**
 * A hash of a value no caller supplies. Verification runs it when the username
 * is unknown so that a missing account and a wrong password cost the same.
 */
const ABSENT_ACCOUNT_HASH = await hashPassword(`absent:${opaqueHex(32)}`);

function opaqueHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function createInMemoryAccountStore(): AccountStore {
  const accounts = new Map<string, AccountRecord>();
  return {
    async readByUsername(username) {
      return accounts.get(normalizeUsername(username)) ?? null;
    },
    async insert(record) {
      const key = normalizeUsername(record.username);
      if (accounts.has(key)) return "USERNAME_TAKEN";
      accounts.set(key, record);
      return "INSERTED";
    },
  };
}

export function createAccountDirectory(
  store: AccountStore = createInMemoryAccountStore(),
): AccountDirectory {
  return {
    async register(credentials, nowMs, options = {}) {
      const username = normalizeUsername(credentials.username);
      if (!USERNAME_PATTERN.test(username)) {
        return { outcome: "REJECTED", reason: "USERNAME_INVALID" };
      }
      if (credentials.password.length < MINIMUM_PASSWORD_LENGTH) {
        return { outcome: "REJECTED", reason: "PASSWORD_TOO_SHORT" };
      }
      const accountId = AccountIdSchema.parse(options.accountId ?? `account_${opaqueHex(16)}`);
      const inserted = await store.insert({
        accountId,
        username,
        passwordHash: await hashPassword(credentials.password),
        createdAtMs: nowMs,
        disabledAtMs: null,
      });
      return inserted === "USERNAME_TAKEN"
        ? { outcome: "REJECTED", reason: "USERNAME_TAKEN" }
        : { outcome: "APPLIED", value: { accountId } };
    },

    async verifyCredentials(username, password) {
      const account = await store.readByUsername(username);
      const verified = await Bun.password.verify(
        password,
        account?.passwordHash ?? ABSENT_ACCOUNT_HASH,
      );
      return account === null || account.disabledAtMs !== null || !verified
        ? null
        : { accountId: account.accountId, actorId: `actor_${opaqueHex(16)}` };
    },
  };
}
