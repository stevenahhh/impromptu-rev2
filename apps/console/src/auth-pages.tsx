import { Button, Panel, Shell } from "@impromptu/ui";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ConsoleHeader, useAuth } from "./auth-session";
import { messages } from "./i18n";
import type { AccountRegistrationFailure } from "./session-client";

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/;
const MINIMUM_PASSWORD_LENGTH = 8;

function signUpFailureMessage(
  failure: AccountRegistrationFailure,
  text: ReturnType<typeof messages>,
): string {
  switch (failure) {
    case "USERNAME_TAKEN":
      return text.signUpUsernameTaken;
    case "USERNAME_INVALID":
      return text.signUpUsernameInvalid;
    case "PASSWORD_TOO_SHORT":
      return text.signUpPasswordTooShort;
    case "UNKNOWN":
      return text.signUpFailed;
  }
}

export function SignInPage() {
  const { error, locale, pending, signIn } = useAuth();
  const text = messages(locale);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <Shell focused header={<ConsoleHeader />} skipLabel={text.skipToContent}>
      <Panel className="console-sign-in ui-reveal">
        <h1>{text.signInTitle}</h1>
        <p className="console-lead">{text.signInLead}</p>
        <label className="console-field">
          <span>{text.username}</span>
          <input
            autoComplete="username"
            data-sign-in-username
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
        </label>
        <label className="console-field">
          <span>{text.password}</span>
          <input
            autoComplete="current-password"
            data-sign-in-password
            type="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        <Button
          data-sign-in-submit
          disabled={pending || username.length === 0 || password.length === 0}
          onClick={() => void signIn(username, password)}
        >
          {pending ? text.signingIn : text.enterWorkspace}
        </Button>
        <section className="console-demo-account" aria-label={text.demoAccountTitle}>
          <h2>{text.demoAccountTitle}</h2>
          <p className="console-caption">{text.demoAccountLead}</p>
          <dl className="console-demo-account__credentials">
            <div>
              <dt>{text.username}</dt>
              <dd>
                <code>demo</code>
              </dd>
            </div>
            <div>
              <dt>{text.password}</dt>
              <dd>
                <code>12341234</code>
              </dd>
            </div>
          </dl>
          <Button
            variant="quiet"
            data-demo-account-fill
            onClick={() => {
              setUsername("demo");
              setPassword("12341234");
            }}
          >
            {text.demoAccountFill}
          </Button>
        </section>
        <p className="console-caption" aria-live="polite">
          {error === null ? text.signInPrivacy : text.signInFailed}
        </p>
        <p className="console-caption">
          {text.needAccount} <Link to="/sign-up">{text.signUpLink}</Link>
        </p>
      </Panel>
    </Shell>
  );
}

export function SignUpPage() {
  const { locale, pending, signUp } = useAuth();
  const text = messages(locale);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<AccountRegistrationFailure | null>(null);

  const submit = async () => {
    const normalizedUsername = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(normalizedUsername)) {
      setFailure("USERNAME_INVALID");
      return;
    }
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setFailure("PASSWORD_TOO_SHORT");
      return;
    }
    const outcome = await signUp(username, password);
    setFailure(outcome === "SUCCESS" ? null : outcome);
  };

  const failureMessage =
    failure === null ? text.signUpPrivacy : signUpFailureMessage(failure, text);

  return (
    <Shell focused header={<ConsoleHeader />} skipLabel={text.skipToContent}>
      <Panel className="console-sign-in ui-reveal">
        <h1>{text.signUpTitle}</h1>
        <p className="console-lead">{text.signUpLead}</p>
        <label className="console-field">
          <span>{text.username}</span>
          <input
            autoComplete="username"
            data-sign-up-username
            value={username}
            onChange={(event) => {
              setUsername(event.currentTarget.value);
              setFailure(null);
            }}
          />
          <span>{text.signUpUsernameRules}</span>
        </label>
        <label className="console-field">
          <span>{text.password}</span>
          <input
            autoComplete="new-password"
            data-sign-up-password
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.currentTarget.value);
              setFailure(null);
            }}
          />
          <span>{text.signUpPasswordRules}</span>
        </label>
        <Button
          data-sign-up-submit
          disabled={pending || username.length === 0 || password.length === 0}
          onClick={() => void submit()}
        >
          {pending ? text.signingUp : text.createAccount}
        </Button>
        <p
          className={`console-caption${failure === null ? "" : " console-caption--error"}`}
          aria-live="polite"
          data-sign-up-error={failure ?? undefined}
        >
          {failureMessage}
        </p>
        <p className="console-caption">
          {text.haveAccount} <Link to="/sign-in">{text.signInLink}</Link>
        </p>
      </Panel>
    </Shell>
  );
}
