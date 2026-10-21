import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { StatusProvider, useStatusLine } from "../components/statusline";
import { LoadingState } from "../components/ui";
import { getCurrentUser, logout } from "../lib/api";
import { shortcutBlocked } from "../lib/keys";

type Portal = "public" | "participant" | "organizer";

interface NavItem {
  label: string;
  to: string;
  /** Path prefix that marks this tab active; defaults to an exact match on `to`. */
  match?: string;
}

function portalFromPath(pathname: string): Portal {
  if (pathname.startsWith("/participant")) return "participant";
  if (pathname.startsWith("/organizer")) return "organizer";
  return "public";
}

function navigationFor(portal: Portal, pathname: string): NavItem[] {
  if (portal === "participant") {
    return [
      { label: "Overview", to: "/participant", match: "/participant/applications" },
      { label: "Profile", to: "/participant/profile" },
      { label: "Your data", to: "/participant/settings/data" },
    ];
  }

  if (portal === "organizer") {
    const eventId = pathname.match(/^\/organizer\/events\/([^/]+)/)?.[1];
    if (eventId && eventId !== "new") {
      const root = `/organizer/events/${eventId}`;
      return [
        { label: "Overview", to: root },
        { label: "Requirements", to: `${root}/requirements` },
        { label: "Participants", to: `${root}/participants` },
        { label: "Teams", to: `${root}/teams` },
        { label: "Shortlist", to: `${root}/shortlist`, match: `${root}/runs` },
        { label: "Settings", to: `${root}/settings` },
        { label: "All events", to: "/organizer" },
      ];
    }
    return [
      { label: "Events", to: "/organizer" },
      { label: "New event", to: "/organizer/events/new" },
      { label: "Quick shortlist", to: "/organizer/quick/new", match: "/organizer/quick" },
    ];
  }

  return [
    { label: "Home", to: "/" },
    { label: "Participant", to: "/participant" },
    { label: "Organizer", to: "/organizer" },
  ];
}

function isActive(item: NavItem, pathname: string) {
  return pathname === item.to || (item.match !== undefined && pathname.startsWith(item.match));
}

/** Every place a person can go, for the command palette. */
const destinations: NavItem[] = [
  { label: "home", to: "/" },
  { label: "sign in", to: "/login" },
  { label: "participant: overview", to: "/participant" },
  { label: "participant: apply / onboarding", to: "/participant/onboarding" },
  { label: "participant: profile and evidence", to: "/participant/profile" },
  { label: "participant: data and consent", to: "/participant/settings/data" },
  { label: "organizer: events", to: "/organizer" },
  { label: "organizer: new event", to: "/organizer/events/new" },
  { label: "organizer: quick shortlist (csv import)", to: "/organizer/quick/new" },
  { label: "privacy", to: "/privacy" },
  { label: "terms", to: "/terms" },
];

/** Matches when every query character appears in order, so "ostl" finds "organizer: shortlist". */
export function fuzzyMatch(query: string, text: string) {
  let position = 0;
  const haystack = text.toLowerCase();
  for (const character of query.toLowerCase().replaceAll(" ", "")) {
    position = haystack.indexOf(character, position) + 1;
    if (position === 0) return false;
  }
  return true;
}

function Palette({ items, onClose }: { items: NavItem[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const results = items.filter((item) => fuzzyMatch(query, item.label));
  const go = (item: NavItem | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.to);
  };

  return (
    <div className="modal modal-open tui-modal" role="dialog" aria-modal="true" aria-label="Go to">
      <div className="modal-box">
        <div className="palette-input">
          <span aria-hidden="true">:</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
            autoFocus
            aria-label="Search destinations"
            aria-controls="palette-results"
            aria-activedescendant={results[cursor] ? `palette-${cursor}` : undefined}
            value={query}
            placeholder="Go to…"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
                event.preventDefault();
                setCursor((value) => Math.min(results.length - 1, value + 1));
              } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
                event.preventDefault();
                setCursor((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter") {
                go(results[cursor]);
              }
            }}
          />
          <span className="dim text-xs font-normal">esc to close</span>
        </div>
        <div className="palette-results tui-list" id="palette-results" role="listbox">
          {results.length === 0 ? <p className="dim px-4 py-1">No destination matches.</p> : null}
          {results.map((item, index) => (
            <button
              type="button"
              role="option"
              id={`palette-${index}`}
              aria-selected={index === cursor}
              key={item.to + item.label}
              onMouseEnter={() => setCursor(index)}
              onClick={() => go(item)}
            >
              <span className="marker">›</span>
              <span>{item.label}</span>
              <span className="dim">{item.to}</span>
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>
  );
}

function Help({ tabs, onClose }: { tabs: NavItem[]; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const rows: Array<[string, string]> = [
    [`1–${tabs.length}`, `switch section (${tabs.map((tab) => tab.label).join(", ")})`],
    [": or ⌘K", "go to any screen"],
    ["j / k", "move down / up in a list"],
    ["enter", "open the selected row"],
    ["?", "this help"],
    ["esc", "close"],
  ];
  return (
    <div
      className="modal modal-open tui-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard"
    >
      <div className="modal-box">
        <div className="pane m-4">
          <header className="pane-title">
            <h2>Keyboard shortcuts</h2>
          </header>
          <div className="pane-body">
            <dl className="kv">
              {rows.map(([key, action]) => (
                <div className="contents" key={key}>
                  <dt className="text-info!">{key}</dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
            <p className="dim mt-4">Everything here is also clickable.</p>
          </div>
        </div>
        <div className="flex justify-end px-4 pb-4">
          <button ref={closeRef} type="button" className="btn tui-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>
  );
}

const portalLinks: NavItem[] = [
  { label: "Home", to: "/" },
  { label: "Participant", to: "/participant", match: "/participant" },
  { label: "Organizer", to: "/organizer", match: "/organizer" },
];

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const portal = portalFromPath(location.pathname);
  const tabs = useMemo(() => navigationFor(portal, location.pathname), [portal, location.pathname]);
  const [overlay, setOverlay] = useState<"palette" | "help" | null>(null);
  const { message, post } = useStatusLine();
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      queryClient.setQueryData(["current-user"], null);
      await queryClient.invalidateQueries({ queryKey: ["participant-overview"] });
      post("Signed out.");
    },
  });
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    const segments = location.pathname.split("/").filter(Boolean);
    document.title = segments.length ? `${segments.join(" › ")} · TalentRadar` : "TalentRadar";
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOverlay((current) => (current === "palette" ? null : "palette"));
        return;
      }
      if (event.key === "Escape") {
        setOverlay(null);
        return;
      }
      if (
        overlay ||
        shortcutBlocked(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      if (event.key === ":") {
        event.preventDefault();
        setOverlay("palette");
      } else if (event.key === "?") {
        setOverlay("help");
      } else if (/^[1-9]$/.test(event.key)) {
        const tab = tabs[Number(event.key) - 1];
        if (tab) navigate(tab.to);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, overlay, tabs]);

  return (
    <div className="app" data-theme="talentradar">
      <a className="sr-only focus:not-sr-only focus:absolute focus:p-2" href="#main-content">
        Skip to content
      </a>

      <header className="app-header">
        <div className="app-header-inner">
          <Link className="app-brand" to="/" aria-label="TalentRadar home">
            <span className="radar" aria-hidden="true" />
            TalentRadar
          </Link>
          <nav className="app-portals" aria-label="Portals">
            {portalLinks.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                aria-current={
                  item.to === "/"
                    ? location.pathname === "/"
                      ? "page"
                      : undefined
                    : location.pathname.startsWith(item.match ?? item.to)
                      ? "page"
                      : undefined
                }
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="app-account">
            {account.data ? (
              <>
                <span>@{account.data.login}</span>
                <button type="button" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
                  {signOut.isPending ? "Signing out…" : "Sign out"}
                </button>
              </>
            ) : account.isPending ? null : (
              <Link to={`/login?returnTo=${encodeURIComponent(location.pathname)}`}>Sign in</Link>
            )}
          </div>
        </div>
      </header>

      {portal === "public" ? (
        <div />
      ) : (
        <nav className="app-tabs" aria-label="Sections">
          <div className="app-tabs-inner">
            {tabs.map((tab) => (
              <Link
                className="app-tab"
                key={tab.to}
                to={tab.to}
                aria-current={isActive(tab, location.pathname) ? "page" : undefined}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </nav>
      )}

      <main className="app-main" id="main-content">
        <Suspense fallback={<LoadingState label="Loading" />}>
          <Outlet />
        </Suspense>
      </main>

      <footer className="app-footer">
        <span
          className="app-message"
          role="status"
          aria-live="polite"
          data-tone={message?.tone}
          key={message?.id}
        >
          {message?.text ?? (account.data ? `Signed in as @${account.data.login}` : "Ready")}
        </span>
        <span className="app-footer-links">
          <button type="button" onClick={() => setOverlay("palette")}>
            Go to <kbd>:</kbd>
          </button>
          <button type="button" onClick={() => setOverlay("help")}>
            Shortcuts <kbd>?</kbd>
          </button>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </span>
      </footer>

      {overlay === "palette" ? (
        <Palette
          items={[
            ...tabs.map((tab) => ({ ...tab, label: `section: ${tab.label}` })),
            ...destinations,
          ]}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {overlay === "help" ? <Help tabs={tabs} onClose={() => setOverlay(null)} /> : null}
    </div>
  );
}

export function TerminalFrame() {
  return (
    <StatusProvider>
      <Shell />
    </StatusProvider>
  );
}
