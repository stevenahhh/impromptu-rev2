import { Brand, Button, Shell } from "@impromptu/ui";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { LanguagePicker, useAuth } from "./auth-session";
import { messages } from "./i18n";

function PrivateNavigation() {
  const { locale, signOut } = useAuth();
  const location = useLocation();
  const text = messages(locale);
  const isWorkspace = location.pathname === "/" || location.pathname === "/session";

  return (
    <div className="console-header console-app-bar">
      <Brand eyebrow={text.presenterConsole} />
      {isWorkspace ? null : (
        <nav aria-label={text.privateWorkspace} className="console-nav">
          <NavLink to="/" end>
            {text.workspace}
          </NavLink>
        </nav>
      )}
      <div className="console-header__actions">
        <LanguagePicker />
        <Button variant="quiet" onClick={() => void signOut()}>
          {text.leave}
        </Button>
      </div>
    </div>
  );
}

export function PrivateLayout({ coResident }: { readonly coResident: boolean }) {
  const { locale } = useAuth();
  const text = messages(locale);
  const [coResidentState, setCoResidentState] = useState<"OFF" | "ENABLED" | "DISABLED">(
    coResident ? "ENABLED" : "OFF",
  );
  const [controllerLifecycle, setControllerLifecycle] = useState<"ACTIVE" | "BACKGROUND">("ACTIVE");

  useEffect(() => {
    const observeVisibility = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const next =
        typeof detail === "object" && detail !== null && detail.state === "BACKGROUND"
          ? "BACKGROUND"
          : document.visibilityState === "hidden"
            ? "BACKGROUND"
            : "ACTIVE";
      setControllerLifecycle(next);
      window.dispatchEvent(
        new CustomEvent("impromptu:controller-lifecycle", { detail: { state: next } }),
      );
    };
    document.addEventListener("visibilitychange", observeVisibility);
    return () => document.removeEventListener("visibilitychange", observeVisibility);
  }, []);

  useEffect(() => {
    const observePublicSurface = (event: Event) => {
      if (
        coResidentState !== "ENABLED" ||
        !(event instanceof CustomEvent) ||
        typeof event.detail !== "object" ||
        event.detail === null
      ) {
        return;
      }
      const detail = event.detail as Record<string, unknown>;
      if (typeof detail.privatePixelCount !== "number" || detail.privatePixelCount <= 0) return;
      setCoResidentState("DISABLED");
      window.dispatchEvent(
        new CustomEvent("impromptu:co-resident-disabled", {
          detail: { reason: "PRIVATE_PIXEL_OBSERVED", privatePixelCount: detail.privatePixelCount },
        }),
      );
    };
    window.addEventListener("impromptu:public-surface-observation", observePublicSurface);
    return () =>
      window.removeEventListener("impromptu:public-surface-observation", observePublicSurface);
  }, [coResidentState]);

  if (coResidentState === "DISABLED") {
    return (
      <Shell focused header={<Brand eyebrow={text.publicSafety} />} skipLabel={text.skipToContent}>
        <main
          className="console-co-resident-shield"
          data-co-resident-state="DISABLED"
          data-controller-lifecycle={controllerLifecycle}
        >
          <p className="ui-eyebrow">{text.audienceProtected}</p>
          <h1>{text.coResidentDisabled}</h1>
          <p>{text.moveControl}</p>
        </main>
      </Shell>
    );
  }

  return (
    <Shell header={<PrivateNavigation />} skipLabel={text.skipToContent}>
      <div
        className="console-content"
        data-co-resident-state={coResidentState}
        data-controller-lifecycle={controllerLifecycle}
      >
        {coResidentState === "ENABLED" ? (
          <aside className="console-co-resident" role="alert">
            <strong>{text.coResidentMode}</strong>
            <span>{text.coResidentLead}</span>
          </aside>
        ) : null}
        <Outlet />
      </div>
    </Shell>
  );
}
