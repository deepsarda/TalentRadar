import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ActionAnchor,
  ActionLink,
  Bar,
  countdown,
  EmptyState,
  ErrorState,
  formatDate,
  LoadingState,
  Notice,
  Pane,
  SkillGroups,
  StateTag,
  TermTabs,
} from "../components/ui";
import { getCurrentUser, getPublicEvent, getPublicEvents, type PublicEvent } from "../lib/api";
import { skillLabel } from "../lib/skills";

const eventTabs = [
  { id: "live", label: "live", status: "open" },
  { id: "upcoming", label: "upcoming", status: "upcoming" },
  { id: "completed", label: "completed", status: "closed" },
] as const;

type EventTab = (typeof eventTabs)[number]["id"];

function EventSessions({ events, user }: { events: PublicEvent[]; user: string }) {
  const counts = Object.fromEntries(
    eventTabs.map((tab) => [tab.id, events.filter((event) => event.status === tab.status).length]),
  ) as Record<EventTab, number>;
  const [tab, setTab] = useState<EventTab>(() =>
    counts.live > 0 ? "live" : counts.upcoming > 0 ? "upcoming" : "live",
  );
  const status = eventTabs.find((candidate) => candidate.id === tab)?.status;
  const shown = events.filter((event) => event.status === status);

  return (
    <TermTabs
      label="Hackathons"
      tabs={eventTabs.map(({ id, label }) => ({ id, label, count: counts[id] }))}
      active={tab}
      onChange={setTab}
      user={user}
      command={`talentradar events ls --${tab}`}
    >
      {shown.length === 0 ? (
        <p className="dim flex items-start gap-3 px-1 text-sm sm:text-base">
          {infoIcon}
          <span>
            0 {tab} events.
            {tab === "live" ? " Check upcoming, or create one from the organizer console." : ""}
          </span>
        </p>
      ) : (
        <div className="tui-list">
          {shown.map((event) => (
            <Link to={`/h/${event.slug}`} key={event.id}>
              <span className="marker" aria-hidden="true">
                ›
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="font-bold">{event.name}</span>
                <span className="dim truncate">{event.tagline}</span>
                <span className="dim text-sm">
                  {[
                    tab === "upcoming"
                      ? `opens ${formatDate(event.registrationOpensAt)}`
                      : tab === "live"
                        ? `closes ${formatDate(event.registrationClosesAt)}`
                        : formatDate(event.eventStartsAt),
                    `${event.capacity} seats`,
                    event.mode.replace("_", " "),
                  ].join(" · ")}
                </span>
              </span>
              <span className="dim hidden sm:inline" aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </div>
      )}
      <p className="dim mt-3 flex items-start gap-3 px-1 text-sm sm:text-base">
        {infoIcon}
        <span>
          {shown.length} {shown.length === 1 ? "event" : "events"}. Select one to open its page.
        </span>
      </p>
    </TermTabs>
  );
}

const infoIcon = (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="mt-0.5 shrink-0"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);

const arrow = (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

const heroPoints = [
  {
    label: "No black box",
    description: "Verified code evidence",
    path: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  },
  {
    label: "Fully tunable",
    description: "Live what-if simulation",
    path: "M4 7h8M16 7h4M4 17h4M12 17h8M14 5v4M10 15v4",
  },
  {
    label: "Blind review",
    description: "Bias-free evaluation",
    path: "M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a14 14 0 0 1-2.4 3.2M6.5 7.6A14 14 0 0 0 2.5 12c1 2 4.5 6 9.5 6 1.5 0 2.8-.4 4-.9",
  },
];

export function LandingPage() {
  const events = useQuery({ queryKey: ["public-events"], queryFn: getPublicEvents });
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const user = account.data?.login ?? "guest";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-6 py-4 sm:py-6">
      {/* Hero Header */}
      <section className="flex w-full flex-col items-center gap-3 text-center">
        <span className="hero-badge text-xs px-3.5 py-1 font-semibold">
          Fair & Explainable Shortlisting
        </span>
        <h1 className="font-display tracking-tight text-5xl sm:text-7xl font-black text-white leading-tight">
          TALENTRADAR
        </h1>
        <p className="max-w-2xl text-base sm:text-xl font-medium text-[var(--accent)]">
          Skill profiles from real code. Rankings you can explain.
        </p>

        {/* Portal Entry Placements */}
        <div className="mt-2.5 grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
          <Link
            to="/organizer"
            className="group flex items-center justify-between rounded-2xl border border-[var(--line)] bg-[var(--raised)] px-6 py-4.5 text-left transition-all hover:border-[var(--accent)] hover:shadow-lg"
          >
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--accent)]">
                Organizers
              </span>
              <h3 className="text-lg font-bold text-white">Organizer Console</h3>
              <p className="text-xs sm:text-sm text-[var(--dim)]">Manage events & shortlists</p>
            </div>
            <span className="text-base font-semibold text-[var(--accent)] transition-transform group-hover:translate-x-1.5">
              {arrow}
            </span>
          </Link>

          <Link
            to="/participant"
            className="group flex items-center justify-between rounded-2xl border border-[var(--line)] bg-[var(--raised)] px-6 py-4.5 text-left transition-all hover:border-[var(--dim)] hover:shadow-lg"
          >
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--dim)]">
                Participants
              </span>
              <h3 className="text-lg font-bold text-white">Participant Portal</h3>
              <p className="text-xs sm:text-sm text-[var(--dim)]">View skills & status</p>
            </div>
            <span className="text-base font-semibold text-white transition-transform group-hover:translate-x-1.5">
              {arrow}
            </span>
          </Link>
        </div>

        {/* 3 Value Pillars */}
        <div className="mt-2 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
          {heroPoints.map((point) => (
            <div
              key={point.label}
              className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--raised)]/60 px-4 py-3 text-left transition-colors"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)]">
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="stroke-[var(--accent)]"
                  aria-hidden="true"
                >
                  <path d={point.path} />
                </svg>
              </span>
              <div>
                <h4 className="text-sm font-semibold text-white leading-snug">{point.label}</h4>
                <p className="text-xs text-[var(--dim)] leading-snug">{point.description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Hackathons Section */}
      <section
        id="events"
        className="grid w-full gap-3.5 rounded-2xl border border-[var(--line)] bg-[var(--raised)]/40 p-6 sm:p-7 [&_.term]:border-0 [&_.term]:bg-transparent [&_.term]:overflow-visible [&_.tui-tabs]:px-0 [&_.tui-tabs]:pt-0 [&_.tui-tabs]:pb-3"
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] pb-3">
          <div>
            <h2 className="font-display text-xl sm:text-2xl font-bold text-white">Hackathons</h2>
            <p className="text-sm sm:text-base text-[var(--dim)]">
              Public events accepting registrations
            </p>
          </div>
          <Link to="/organizer" className="text-sm sm:text-base font-medium text-[var(--accent)] hover:underline">
            Host a hackathon →
          </Link>
        </div>
        {events.isPending ? <LoadingState label="Loading events" /> : null}
        {events.isError ? (
          <ErrorState message={events.error.message} retry={() => void events.refetch()} />
        ) : null}
        {events.data ? <EventSessions events={events.data} user={user} /> : null}
      </section>
    </div>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function PublicEventPage() {
  const { slug = "" } = useParams();
  const now = useNow(30_000);
  const event = useQuery({
    queryKey: ["public-event", slug],
    queryFn: () => getPublicEvent(slug),
    retry: false,
  });

  if (event.isPending) return <LoadingState label="opening event" />;
  if (event.isError) {
    return (
      <Pane title="event not found">
        <EmptyState
          title="This event is not available"
          action={<ActionLink to="/">Home</ActionLink>}
        />
      </Pane>
    );
  }

  const data = event.data;
  const dates: Array<[string, string]> = [
    ["closes", data.registrationClosesAt],
    ["results", data.shortlistPublishesAt],
    ["event", data.eventStartsAt],
  ];
  const next =
    data.status === "upcoming"
      ? { label: "registration opens", at: data.registrationOpensAt }
      : data.status === "open"
        ? { label: "registration closes", at: data.registrationClosesAt }
        : { label: "event starts", at: data.eventStartsAt };
  const remaining = countdown(next.at, now);

  return (
    <div className="mx-auto grid max-w-6xl gap-12 py-4">
      <header className="grid gap-4">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StateTag state={data.status} />
          <span className="dim">
            {[
              data.mode.replace("_", " "),
              data.venue,
              `teams of ${data.teamSize.min}–${data.teamSize.max}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </p>
        <h1 className="font-display text-[32px] leading-tight sm:text-[44px]">{data.name}</h1>
        {data.tagline ? <p className="text-xl">{data.tagline}</p> : null}
        <div className="mt-2 flex flex-wrap items-end gap-x-10 gap-y-4">
          {remaining ? (
            <p className="grid">
              <span className="font-display text-5xl leading-none text-warn">{remaining}</span>
              <span className="dim">until {next.label}</span>
            </p>
          ) : null}
          {data.status === "open" ? (
            <ActionLink to={`/participant/apply/${data.slug}`} tone="primary">
              Apply with GitHub
            </ActionLink>
          ) : null}
        </div>
      </header>

      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <article className="grid max-w-2xl gap-5">
          <div className="prose-tui whitespace-pre-line">{data.description}</div>
          {data.links.length > 0 ? (
            <p className="flex flex-wrap gap-x-6 gap-y-1">
              {data.links.map((link) => (
                <a
                  className="tui-link"
                  href={link.url}
                  key={link.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {link.label} ↗
                </a>
              ))}
            </p>
          ) : null}
        </article>

        <aside className="grid gap-8">
          <Pane title="ranked on">
            <SkillGroups items={data.requirements} idOf={(requirement) => requirement.skill}>
              {(requirement) => (
                <div className="flex items-baseline justify-between gap-3" key={requirement.skill}>
                  <span>{skillLabel(requirement.skill)}</span>
                  <Bar
                    value={requirement.target}
                    cells={5}
                    label={`${skillLabel(requirement.skill)} target`}
                  />
                </div>
              )}
            </SkillGroups>
          </Pane>
          <Pane title="dates">
            <dl className="grid gap-2">
              {dates.map(([label, at]) => (
                <div className="flex justify-between gap-3" key={label}>
                  <dt className={Date.parse(at) <= now ? "dim line-through" : "dim"}>{label}</dt>
                  <dd>
                    <time dateTime={at}>{formatDate(at)}</time>
                  </dd>
                </div>
              ))}
            </dl>
          </Pane>
        </aside>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const error = searchParams.get("error");
  const githubHref = `/auth/github${returnTo?.startsWith("/") ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;
  return (
    <div className="mx-auto grid max-w-xl gap-4 pt-6">
      <Pane title="sign in" active>
        <div className="grid gap-4">
          <p>Read-only access to your public profile and email.</p>
          {error ? (
            <Notice tone="error" tag="error">
              GitHub sign-in did not complete. Try again.
            </Notice>
          ) : null}
          <div>
            <ActionAnchor href={githubHref} tone="primary">
              Continue with GitHub
            </ActionAnchor>
          </div>
        </div>
      </Pane>
    </div>
  );
}

function DocumentPage({
  title,
  intro,
  sections,
}: {
  title: string;
  intro: string;
  sections: Array<[string, string]>;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <Pane title={title}>
        <article className="prose-tui">
          <h1 className="sr-only">{title}</h1>
          <p>{intro}</p>
          {sections.map(([heading, body]) => (
            <section key={heading}>
              <h2>{heading}</h2>
              <p>{body}</p>
            </section>
          ))}
        </article>
      </Pane>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <DocumentPage
      title="privacy"
      intro="What TalentRadar processes, and why, before you submit repositories or a CV."
      sections={[
        [
          "Inputs",
          "Your GitHub identity, the public repositories you select, a PDF CV, event details and team membership.",
        ],
        [
          "Why",
          "To build a profile where every skill cites real files, check it against the event's requirements, and show you and the organizer the result and its evidence.",
        ],
        [
          "Model processing",
          "One model call per profile reads the selected code and the rendered CV pages. The consent screen states which provider is used and whether CVs must be synthetic.",
        ],
        [
          "Control",
          "You can inspect every claim in your profile, report a wrong one, export your data and request deletion.",
        ],
      ]}
    />
  );
}

export function TermsPage() {
  return (
    <DocumentPage
      title="terms"
      intro="TalentRadar recommends. The organizer decides, and stays responsible for the decision."
      sections={[
        [
          "Evidence before automation",
          "Organizers should read evidence for borderline teams, flags, reported corrections and overrides before publishing.",
        ],
        [
          "Organizer responsibility",
          "Organizers are responsible for lawful consent, fair criteria and the outcomes they publish.",
        ],
        [
          "Limits",
          "Public code is incomplete evidence of skill. Confidence shows how much evidence exists; low confidence is not a low score.",
        ],
      ]}
    />
  );
}

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl pt-6">
      <Pane title="404">
        <EmptyState
          title="Nothing lives at this address"
          action={<ActionLink to="/">Home</ActionLink>}
        >
          Press : to jump to any screen.
        </EmptyState>
      </Pane>
    </div>
  );
}
