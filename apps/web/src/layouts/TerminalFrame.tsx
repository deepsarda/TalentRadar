import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { StatusProvider, useStatusLine } from "../components/statusline";
import { LoadingState } from "../components/ui";
import { getCurrentUser, logout } from "../lib/api";

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
      { label: "overview", to: "/participant", match: "/participant/applications" },
      { label: "profile", to: "/participant/profile" },
      { label: "data", to: "/participant/settings/data" },
    ];
  }

  if (portal === "organizer") {
    const eventId = pathname.match(/^\/organizer\/events\/([^/]+)/)?.[1];
    if (eventId && eventId !== "new") {
      const root = `/organizer/events/${eventId}`;
      return [
        { label: "overview", to: root },
        { label: "requirements", to: `${root}/requirements` },
        { label: "participants", to: `${root}/participants` },
        { label: "teams", to: `${root}/teams` },
        { label: "shortlist", to: `${root}/shortlist`, match: `${root}/runs` },
        { label: "settings", to: `${root}/settings` },
        { label: "all events", to: "/organizer" },
      ];
    }
    return [
      { label: "events", to: "/organizer" },
      { label: "new event", to: "/organizer/events/new" },
      { label: "quick shortlist", to: "/organizer/quick/new", match: "/organizer/quick" },
    ];
  }

  return [
    { label: "home", to: "/" },
    { label: "participant", to: "/participant" },
    { label: "organizer", to: "/organizer" },
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

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

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
            placeholder="go to…"
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
    [`1–${tabs.length}`, `switch tab (${tabs.map((tab) => tab.label).join(", ")})`],
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
            <h2>keys</h2>
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

/** Columns × rows the workspace would hold at the body font size, like a real emulator title. */
const measureTerminal = () =>
  `${Math.floor(window.innerWidth / 8.4)}×${Math.floor(window.innerHeight / 21)}`;

function useTerminalSize() {
  const [size, setSize] = useState(measureTerminal);
  useEffect(() => {
    const onResize = () => setSize(measureTerminal());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** Scanlines and glow, remembered per viewer; off by default for reduced motion. */
function useCrt() {
  const [crt, setCrt] = useState(() => {
    try {
      const saved = window.localStorage.getItem("talentradar.crt");
      if (saved) return saved === "on";
    } catch {
      // Storage blocked: fall through to the motion preference.
    }
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("crt", crt);
    try {
      window.localStorage.setItem("talentradar.crt", crt ? "on" : "off");
    } catch {
      // Not persisted; the toggle still works for this page view.
    }
  }, [crt]);
  return [crt, setCrt] as const;
}

function BootScreen({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timeout = window.setTimeout(onDone, 900);
    window.addEventListener("pointerdown", onDone, { once: true });
    window.addEventListener("keydown", onDone, { once: true });
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pointerdown", onDone);
      window.removeEventListener("keydown", onDone);
    };
  }, [onDone]);

  return (
    <div className="boot" role="status" aria-label="Opening TalentRadar">
      <span className="radar" style={{ "--radar-size": "4rem" } as CSSProperties} />
      <strong className="text-accent">talentradar</strong>
      <small>press any key</small>
    </div>
  );
}

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
  const [booting, setBooting] = useState(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    try {
      return window.sessionStorage.getItem("talentradar.booted") !== "1";
    } catch {
      return false;
    }
  });
  const finishBoot = () => {
    try {
      window.sessionStorage.setItem("talentradar.booted", "1");
    } catch {
      // Storage can be blocked; the boot screen then shows once per page load.
    }
    setBooting(false);
  };

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
      if (overlay || isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
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

  const segments = location.pathname.split("/").filter(Boolean);
  const size = useTerminalSize();
  const [crt, setCrt] = useCrt();

  return (
    <div className="tui" data-theme="talentradar">
      {booting ? <BootScreen onDone={finishBoot} /> : null}
      <a className="sr-only focus:not-sr-only focus:absolute focus:p-2" href="#main-content">
        Skip to content
      </a>

      <header className="tui-chrome">
        <span className="tui-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <Link className="tui-brand" to="/" aria-label="TalentRadar home">
          <span className="radar" aria-hidden="true" />
          talentradar
        </Link>
        <span className="tui-chrome-title">
          {account.data?.login ?? "guest"}@talentradar: ~/
          {segments.slice(0, -1).map((segment) => `${segment}/`)}
          <b>{segments.at(-1) ?? ""}</b> — {size}
        </span>
        <span className="tui-chrome-actions">
          <button type="button" aria-pressed={crt} onClick={() => setCrt(!crt)}>
            crt {crt ? "on" : "off"}
          </button>
          {account.data ? (
            <button type="button" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
              {signOut.isPending ? "signing out…" : "logout"}
            </button>
          ) : account.isPending ? null : (
            <Link to={`/login?returnTo=${encodeURIComponent(location.pathname)}`}>login</Link>
          )}
        </span>
      </header>

      <nav className="tui-tabs" aria-label="Sections">
        {tabs.map((tab, index) => (
          <Link
            className="tui-tab"
            key={tab.to}
            to={tab.to}
            aria-current={isActive(tab, location.pathname) ? "page" : undefined}
          >
            <kbd>{index + 1}</kbd>
            {tab.label}
          </Link>
        ))}
      </nav>

      <main className="tui-workspace" id="main-content">
        <Suspense fallback={<LoadingState label="loading screen" />}>
          <Outlet />
        </Suspense>
      </main>

      <footer className="tui-statusline">
        <span className="tui-mode">{portal.toUpperCase()}</span>
        <span>~/{segments.join("/")}</span>
        <span
          className="tui-message"
          role="status"
          aria-live="polite"
          data-tone={message?.tone}
          key={message?.id}
        >
          {message?.text ?? (account.data ? `signed in as @${account.data.login}` : "ready")}
        </span>
        <span className="tui-keys">
          <button type="button" onClick={() => setOverlay("palette")}>
            <kbd>:</kbd> go to
          </button>
          <button type="button" onClick={() => setOverlay("help")}>
            <kbd>?</kbd> keys
          </button>
        </span>
      </footer>

      {overlay === "palette" ? (
        <Palette
          items={[...tabs.map((tab) => ({ ...tab, label: `tab: ${tab.label}` })), ...destinations]}
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
