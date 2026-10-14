import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useState } from "react";
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

const banner = `████████╗ █████╗ ██╗     ███████╗███╗   ██╗████████╗██████╗  █████╗ ██████╗  █████╗ ██████╗ 
╚══██╔══╝██╔══██╗██║     ██╔════╝████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔══██╗
   ██║   ███████║██║     █████╗  ██╔██╗ ██║   ██║   ██████╔╝███████║██║  ██║███████║██████╔╝
   ██║   ██╔══██║██║     ██╔══╝  ██║╚██╗██║   ██║   ██╔══██╗██╔══██║██║  ██║██╔══██║██╔══██╗
   ██║   ██║  ██║███████╗███████╗██║ ╚████║   ██║   ██║  ██║██║  ██║██████╔╝██║  ██║██║  ██║
   ╚═╝   ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝`;

const bannerNarrow = `████████╗ █████╗ ██╗     ███████╗███╗   ██╗████████╗
╚══██╔══╝██╔══██╗██║     ██╔════╝████╗  ██║╚══██╔══╝
   ██║   ███████║██║     █████╗  ██╔██╗ ██║   ██║   
   ██║   ██╔══██║██║     ██╔══╝  ██║╚██╗██║   ██║   
   ██║   ██║  ██║███████╗███████╗██║ ╚████║   ██║   
   ╚═╝   ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   
██████╗  █████╗ ██████╗  █████╗ ██████╗ 
██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔══██╗
██████╔╝███████║██║  ██║███████║██████╔╝
██╔══██╗██╔══██║██║  ██║██╔══██║██╔══██╗
██║  ██║██║  ██║██████╔╝██║  ██║██║  ██║
╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝`;

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
        <p className="dim px-4">
          0 {tab} events.
          {tab === "live" ? " Check upcoming, or create one from the organizer console." : ""}
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
                {event.slug}/
              </span>
            </Link>
          ))}
        </div>
      )}
      <p className="dim mt-2 px-4">
        {shown.length} {shown.length === 1 ? "entry" : "entries"}. Enter opens the event page.
      </p>
    </TermTabs>
  );
}

export function LandingPage() {
  const events = useQuery({ queryKey: ["public-events"], queryFn: getPublicEvents });
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const user = account.data?.login ?? "guest";

  return (
    <div className="mx-auto grid max-w-6xl gap-14 py-4">
      <section className="grid gap-10">
        <div aria-hidden="true">
          <pre className="banner glow hidden sm:block">{banner}</pre>
          <pre className="banner narrow glow sm:hidden">{bannerNarrow}</pre>
        </div>
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="grid gap-6">
            <h1 className="font-display text-[44px] leading-[0.95] text-accent sm:text-[60px]">
              Shortlist teams by the work they can show.
            </h1>
            <p className="dim text-lg">Skill profiles from real code. Rankings you can explain.</p>
            <div className="flex flex-wrap gap-3">
              <ActionLink to="/organizer" tone="primary">
                Organizer console
              </ActionLink>
              <ActionLink to="/participant">Participant portal</ActionLink>
            </div>
          </div>
          <section id="events">
            {events.isPending ? <LoadingState label="talentradar events ls" /> : null}
            {events.isError ? (
              <ErrorState message={events.error.message} retry={() => void events.refetch()} />
            ) : null}
            {events.data ? <EventSessions events={events.data} user={user} /> : null}
          </section>
        </div>
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
        <h1 className="font-display text-[48px] leading-none text-accent sm:text-[72px]">
          <span className="typed" style={{ "--chars": data.name.length } as CSSProperties}>
            {data.name}
          </span>
        </h1>
        {data.tagline ? <p className="text-xl">{data.tagline}</p> : null}
        <div className="mt-2 flex flex-wrap items-end gap-x-10 gap-y-4">
          {remaining ? (
            <p className="grid">
              <span className="font-display text-5xl leading-none text-warn glow">{remaining}</span>
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
