import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { getCurrentUser, logout } from "../lib/api";

type Portal = "public" | "participant" | "organizer";

interface NavItem {
  label: string;
  to: string;
  end?: boolean;
}

function portalFromPath(pathname: string): Portal {
  if (pathname.startsWith("/participant")) return "participant";
  if (pathname.startsWith("/organizer")) return "organizer";
  return "public";
}

function organizerEventId(pathname: string): string | null {
  return pathname.match(/^\/organizer\/events\/([^/]+)/)?.[1] ?? null;
}

function navigationFor(portal: Portal, pathname: string): NavItem[] {
  if (portal === "participant") {
    return [
      { label: "Overview", to: "/participant", end: true },
      { label: "Profile", to: "/participant/profile" },
      { label: "Team", to: "/participant/team/current" },
      { label: "Status", to: "/participant/applications/current/status" },
      { label: "Data", to: "/participant/settings/data" },
    ];
  }

  if (portal === "organizer") {
    const eventId = organizerEventId(pathname);
    if (eventId && eventId !== "new") {
      const root = `/organizer/events/${eventId}`;
      return [
        { label: "Overview", to: root, end: true },
        { label: "Requirements", to: `${root}/requirements` },
        { label: "Participants", to: `${root}/participants` },
        { label: "Teams", to: `${root}/teams` },
        { label: "Shortlist", to: `${root}/shortlist` },
        { label: "Settings", to: `${root}/settings` },
      ];
    }
    return [
      { label: "Workspace", to: "/organizer", end: true },
      { label: "New event", to: "/organizer/events/new" },
      { label: "Quick shortlist", to: "/organizer/quick/new" },
    ];
  }

  return [
    { label: "Product", to: "/", end: true },
    { label: "Events", to: "/#events" },
    { label: "For organizers", to: "/organizer" },
  ];
}

function portalLabel(portal: Portal) {
  if (portal === "participant") return "PARTICIPANT PORTAL";
  if (portal === "organizer") return "ORGANIZER CONSOLE";
  return "PUBLIC ACCESS";
}

function BootScreen({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const finish = () => onDone();
    const timeout = window.setTimeout(finish, 1100);
    window.addEventListener("pointerdown", finish, { once: true });
    window.addEventListener("keydown", finish, { once: true });
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pointerdown", finish);
      window.removeEventListener("keydown", finish);
    };
  }, [onDone]);

  return (
    <div className="boot-screen" role="status" aria-label="Opening TalentRadar">
      <div className="boot-radar" aria-hidden="true">
        <span />
      </div>
      <strong>TALENTRADAR</strong>
      <p>Loading interface…</p>
      <small>Press any key to continue</small>
    </div>
  );
}

export function TerminalFrame() {
  const location = useLocation();
  const portal = portalFromPath(location.pathname);
  const navigation = useMemo(
    () => navigationFor(portal, location.pathname),
    [portal, location.pathname],
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      queryClient.setQueryData(["current-user"], null);
      await queryClient.invalidateQueries({ queryKey: ["participant-overview"] });
    },
  });
  const [booting, setBooting] = useState(() => {
    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return false;
    }
    return window.sessionStorage.getItem("talentradar.booted") !== "1";
  });

  const finishBoot = () => {
    window.sessionStorage.setItem("talentradar.booted", "1");
    setBooting(false);
  };

  useEffect(() => {
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: "auto" });
    document.title =
      location.pathname === "/" ? "TalentRadar" : `TalentRadar · ${location.pathname}`;
  }, [location.pathname]);

  return (
    <div className={`terminal-root portal-${portal}`} data-theme="talentradar">
      {booting ? <BootScreen onDone={finishBoot} /> : null}

      <header className="terminal-titlebar">
        <Link className="terminal-brand" to="/" aria-label="TalentRadar home">
          <span className="brand-radar" aria-hidden="true">
            <i />
          </span>
          <span>
            <strong>TALENTRADAR</strong>
            <small>{portalLabel(portal)}</small>
          </span>
        </Link>

        <div className="title-context" role="status" aria-label="Current workspace">
          <span className="context-index">TR://</span>
          <span>
            {location.pathname === "/" ? "HOME" : location.pathname.slice(1).toUpperCase()}
          </span>
        </div>

        <div className="title-actions">
          {portal !== "public" ? (
            <Link
              className="portal-switch"
              to={portal === "organizer" ? "/participant" : "/organizer"}
            >
              {portal === "organizer" ? "Participant" : "Organizer"}
            </Link>
          ) : null}
          {account.data ? (
            <button
              className="login-link"
              type="button"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
              title={`Signed in as ${account.data.login}`}
            >
              {signOut.isPending ? "Signing out" : `@${account.data.login} · Sign out`}
            </button>
          ) : (
            <Link className="login-link" to="/login">
              Sign in
            </Link>
          )}
          <button
            className="mobile-menu-button"
            type="button"
            aria-expanded={mobileOpen}
            aria-controls="terminal-navigation"
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? "Close" : "Menu"}
          </button>
        </div>
      </header>

      <nav
        id="terminal-navigation"
        className={`terminal-nav ${mobileOpen ? "nav-open" : ""}`}
        aria-label={`${portalLabel(portal)} navigation`}
      >
        <span className="nav-prefix" aria-hidden="true">
          :
        </span>
        {navigation.map((item, index) => (
          <NavLink
            className={({ isActive }) => (isActive ? "nav-item nav-item-active" : "nav-item")}
            {...(item.end === undefined ? {} : { end: item.end })}
            key={item.to}
            to={item.to}
          >
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="terminal-workspace" id="main-content">
        <Outlet />
      </main>

      <footer className="terminal-statusline">
        <span>
          <b>{portal === "public" ? "READ" : "WORK"}</b> {portalLabel(portal)}
        </span>
        <span className="statusline-centre">Evidence links use frozen commit references</span>
        <span>
          <i aria-hidden="true" /> ROUTE LOADED
        </span>
      </footer>
    </div>
  );
}
