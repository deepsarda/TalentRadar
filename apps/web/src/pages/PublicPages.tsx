import { taxonomy } from "@talentradar/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ActionLink, Badge, EmptyState, ErrorState, LoadingState, Panel } from "../components/ui";
import { getPublicEvent, getPublicEvents } from "../lib/api";

const pipeline = [
  {
    index: "01",
    title: "Choose the evidence",
    body: "Participants choose up to six public repositories and provide a PDF CV with explicit consent.",
    mode: "PARTICIPANT CONTROL",
  },
  {
    index: "02",
    title: "Extract what code can prove",
    body: "Languages, manifests, authorship, tests, CI and file structure come from deterministic checks.",
    mode: "PLAIN CODE",
  },
  {
    index: "03",
    title: "Judge only what needs judgment",
    body: "A structured model assessment evaluates quality and originality, then every citation is verified.",
    mode: "ONE CACHED CALL",
  },
  {
    index: "04",
    title: "Rank against stated needs",
    body: "Teams are scored against organizer requirements with a deterministic function and readable breakdown.",
    mode: "PURE TYPESCRIPT",
  },
] as const;

export function LandingPage() {
  const events = useQuery({ queryKey: ["public-events"], queryFn: getPublicEvents });

  return (
    <div className="public-page">
      <section className="public-hero">
        <div className="hero-copy">
          <p className="terminal-kicker">PUBLIC REPOSITORY + CV EVALUATION</p>
          <h1>
            Shortlist teams by the work
            <span>they can actually show.</span>
          </h1>
          <p className="hero-summary">
            TalentRadar builds inspectable skill profiles from repositories participants choose and
            ranks teams against requirements the organizer defines. Every score leads back to the
            evidence behind it.
          </p>
          <div className="hero-actions">
            <ActionLink to="/#events">View published events</ActionLink>
            <ActionLink to="/organizer" tone="secondary">
              Open organizer console
            </ActionLink>
          </div>
          <div className="hero-privacy">
            <span aria-hidden="true">◈</span>
            <p>
              Participants select their inputs and can inspect or challenge every profile claim.
              Public repositories only.
            </p>
          </div>
        </div>

        <section className="hero-terminal" aria-label="TalentRadar evidence flow">
          <div className="hero-terminal-bar">
            <span>PROFILE_BUILD / INPUT CONTRACT</span>
            <Badge tone="success">TRACEABLE</Badge>
          </div>
          <div className="evidence-command">
            <span aria-hidden="true">›</span>
            <span>evidence sources</span>
          </div>
          <dl className="source-list">
            <div>
              <dt>Repositories</dt>
              <dd>Up to 6, selected by the participant</dd>
            </div>
            <div>
              <dt>CV</dt>
              <dd>PDF, up to 2 MB, consent required</dd>
            </div>
            <div>
              <dt>Code facts</dt>
              <dd>Manifests, tests, CI, authorship, files</dd>
            </div>
          </dl>
          <div className="terminal-divider" />
          <div className="evidence-command">
            <span aria-hidden="true">›</span>
            <span>output contract</span>
          </div>
          <ul className="output-list">
            <li>
              <span>01</span> Skill level + confidence
            </li>
            <li>
              <span>02</span> File citations at a fixed commit
            </li>
            <li>
              <span>03</span> Team score breakdown
            </li>
            <li>
              <span>04</span> Logged organizer decisions
            </li>
          </ul>
        </section>
      </section>

      <section className="method-section" id="method">
        <header className="section-heading">
          <p>HOW THE SYSTEM WORKS</p>
          <h2>Code handles facts. Judgment stays bounded. Decisions remain inspectable.</h2>
        </header>
        <div className="pipeline-grid">
          {pipeline.map((step) => (
            <article className="pipeline-step" key={step.index}>
              <span className="step-number">{step.index}</span>
              <span className="step-mode">{step.mode}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="portal-section">
        <article className="portal-path participant-path">
          <div className="portal-path-heading">
            <span>PARTICIPANT://</span>
            <Badge tone="info">YOUR EVIDENCE</Badge>
          </div>
          <h2>Apply with work you choose.</h2>
          <p>
            Connect GitHub, choose repositories, provide consent, inspect your profile, and manage
            your team from one guided workspace.
          </p>
          <ul>
            <li>Only public repositories you select</li>
            <li>Levels and confidence kept separate</li>
            <li>Evidence and correction controls on every skill</li>
            <li>Your rank and other teams stay private</li>
          </ul>
          <ActionLink to="/participant" tone="secondary">
            Enter participant portal
          </ActionLink>
        </article>

        <article className="portal-path organizer-path">
          <div className="portal-path-heading">
            <span>ORGANIZER://</span>
            <Badge tone="success">YOUR REQUIREMENTS</Badge>
          </div>
          <h2>Review decisions, not black-box scores.</h2>
          <p>
            Create an event or import an existing registration sheet, tune explicit requirements,
            and inspect why each team landed where it did.
          </p>
          <ul>
            <li>One engine for full events and quick imports</li>
            <li>Instant local re-ranking with zero model calls</li>
            <li>Evidence, breakdown, and decision explanations</li>
            <li>Reasoned overrides and immutable published runs</li>
          </ul>
          <ActionLink to="/organizer">Enter organizer console</ActionLink>
        </article>
      </section>

      <section className="why-section">
        <header className="section-heading">
          <p>THREE LEVELS OF WHY</p>
          <h2>No number appears without a route back to its source.</h2>
        </header>
        <div className="why-chain">
          <article>
            <span>01 / EVIDENCE</span>
            <h3>Why this skill level?</h3>
            <p>
              Repository, fixed commit, file path, confidence, per-repository score and reasoning.
            </p>
          </article>
          <i aria-hidden="true">→</i>
          <article>
            <span>02 / BREAKDOWN</span>
            <h3>Why this team score?</h3>
            <p>Target, best member, coverage, points contributed or lost, and novelty source.</p>
          </article>
          <i aria-hidden="true">→</i>
          <article>
            <span>03 / DECISION</span>
            <h3>Why this outcome?</h3>
            <p>
              Cutoff gap, capacity, quota changes, and every organizer override with its reason.
            </p>
          </article>
        </div>
      </section>

      <section className="events-section" id="events">
        <header className="section-heading section-heading-row">
          <div>
            <p>PUBLISHED EVENTS</p>
            <h2>Apply through a live event page.</h2>
          </div>
          <Link to="/organizer/events/new">Organizing an event? Create it here →</Link>
        </header>
        {events.isPending ? <LoadingState label="Reading published events" /> : null}
        {events.isError ? (
          <ErrorState message={events.error.message} retry={() => void events.refetch()} />
        ) : null}
        {events.data?.length === 0 ? (
          <EmptyState title="No events are published yet">
            Published hackathons will appear here with their real dates, requirements, and
            registration status.
          </EmptyState>
        ) : null}
        {events.data && events.data.length > 0 ? (
          <div className="event-list">
            {events.data.map((event) => (
              <Link className="event-row" key={event.id} to={`/h/${event.slug}`}>
                <span>
                  <Badge tone={event.status === "open" ? "success" : "neutral"}>
                    {event.status}
                  </Badge>
                </span>
                <strong>{event.name}</strong>
                <span>{event.tagline}</span>
                <small>{new Date(event.eventStartsAt).toLocaleDateString()}</small>
                <b aria-hidden="true">→</b>
              </Link>
            ))}
          </div>
        ) : null}
      </section>

      <section className="public-data-note">
        <span>DATA://</span>
        <p>
          TalentRadar processes only disclosed inputs. Read how consent, model use, retention and
          deletion work before connecting an account.
        </p>
        <Link to="/privacy">Read privacy details →</Link>
      </section>
    </div>
  );
}

export function PublicEventPage() {
  const { slug = "" } = useParams();
  const event = useQuery({
    queryKey: ["public-event", slug],
    queryFn: () => getPublicEvent(slug),
    retry: false,
  });

  if (event.isPending) return <LoadingState label="Opening event" />;
  if (event.isError) {
    return (
      <div className="contained-page">
        <EmptyState
          title="This event is not available"
          action={<ActionLink to="/">Return home</ActionLink>}
        >
          The link may be incorrect, the event may still be a draft, or registration may no longer
          be public.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="contained-page event-public-page">
      <section className="event-public-hero">
        <Badge tone={event.data.status === "open" ? "success" : "neutral"}>
          {event.data.status}
        </Badge>
        <h1>{event.data.name}</h1>
        <p>{event.data.tagline}</p>
        <div className="event-facts">
          <span>{event.data.mode.replace("_", " ")}</span>
          {event.data.venue ? <span>{event.data.venue}</span> : null}
          <span>Starts {new Date(event.data.eventStartsAt).toLocaleString()}</span>
        </div>
        {event.data.status === "open" ? (
          <ActionLink to={`/participant/apply/${event.data.slug}`}>Start application</ActionLink>
        ) : null}
        {event.data.status === "upcoming" ? (
          <p className="muted-copy">
            Registration opens {new Date(event.data.registrationOpensAt).toLocaleString()}.
          </p>
        ) : null}
        {event.data.status === "closed" ? (
          <p className="muted-copy">Registration is closed for this event.</p>
        ) : null}
      </section>
      <div className="event-public-grid">
        <Panel label="01 / EVENT" title="What to expect">
          <p className="prose-copy">{event.data.description}</p>
          {event.data.links.length > 0 ? (
            <div className="hero-actions">
              {event.data.links.map((link) => (
                <a href={link.url} key={link.url} rel="noreferrer" target="_blank">
                  {link.label} ↗
                </a>
              ))}
            </div>
          ) : null}
        </Panel>
        <Panel label="02 / DEADLINE" title="Registration closes">
          <time className="deadline-value" dateTime={event.data.registrationClosesAt}>
            {new Date(event.data.registrationClosesAt).toLocaleString()}
          </time>
          <p className="muted-copy">Teams lock at this deadline · {event.data.timezone}.</p>
        </Panel>
        <Panel label="03 / REQUIREMENTS" title="What teams are evaluated against">
          <div className="requirement-editor">
            {event.data.requirements.map((requirement) => (
              <div className="requirement-edit-row" key={requirement.skill}>
                <strong>
                  {taxonomy.technologies[requirement.skill]?.label ??
                    taxonomy.domains[requirement.skill]?.label ??
                    requirement.skill}
                </strong>
                <span>Target {requirement.target.toFixed(1)}</span>
                <span>Weight {requirement.weight}</span>
                <span>
                  {requirement.coverage.mode === "any_member"
                    ? "Any member"
                    : `${requirement.coverage.minMembers} members`}
                </span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel label="04 / TEAMS" title="Team and capacity rules">
          <dl className="compact-definition-list">
            <div>
              <dt>Team size</dt>
              <dd>
                {event.data.teamSize.min}–{event.data.teamSize.max} people
              </dd>
            </div>
            <div>
              <dt>Participant capacity</dt>
              <dd>{event.data.capacity} seats</dd>
            </div>
            <div>
              <dt>Shortlist publishes</dt>
              <dd>{new Date(event.data.shortlistPublishesAt).toLocaleString()}</dd>
            </div>
          </dl>
        </Panel>
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
    <div className="narrow-page">
      <Panel label="AUTH / GITHUB" title="Sign in to TalentRadar">
        <div className="login-content">
          <p>
            GitHub verifies your identity and lets TalentRadar list public repositories for you to
            choose. The application requests profile and email access only.
          </p>
          <dl className="permission-list">
            <div>
              <dt>read:user</dt>
              <dd>Read your public GitHub identity.</dd>
            </div>
            <div>
              <dt>user:email</dt>
              <dd>Read your verified email for applications.</dd>
            </div>
            <div>
              <dt>Repository access</dt>
              <dd>Public repositories only. No write permission.</dd>
            </div>
          </dl>
          {error ? (
            <div className="error-state" role="alert">
              GitHub sign-in did not complete. Please try again.
            </div>
          ) : null}
          <a className="btn terminal-action action-primary" href={githubHref}>
            <span aria-hidden="true">[</span> Continue with GitHub <span aria-hidden="true">]</span>
          </a>
          <p className="fine-print">
            By continuing, you can review the exact consent terms before any profile is processed.
          </p>
        </div>
      </Panel>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <article className="document-page">
      <p className="terminal-kicker">DOCUMENT / PRIVACY</p>
      <h1>What TalentRadar processes</h1>
      <p className="document-intro">
        TalentRadar must explain its data use before a participant submits repositories or a CV.
      </p>
      <section>
        <h2>Inputs</h2>
        <p>
          GitHub identity, selected public repositories, a PDF CV, event details and team
          membership.
        </p>
      </section>
      <section>
        <h2>Why</h2>
        <p>
          Inputs are used to build an evidence-backed profile, evaluate event requirements and show
          the participant or organizer the resulting evidence and decision.
        </p>
      </section>
      <section>
        <h2>Model processing</h2>
        <p>
          Model use, provider privacy terms and whether CV content is included must be disclosed in
          the consent shown for the active deployment configuration.
        </p>
      </section>
      <section>
        <h2>Control</h2>
        <p>Participants can inspect, challenge, export and request deletion of their own data.</p>
      </section>
    </article>
  );
}

export function TermsPage() {
  return (
    <article className="document-page">
      <p className="terminal-kicker">DOCUMENT / TERMS</p>
      <h1>How decisions should be used</h1>
      <p className="document-intro">
        TalentRadar supports organizer review. It does not replace human responsibility for final
        selection decisions.
      </p>
      <section>
        <h2>Evidence before automation</h2>
        <p>
          Organizers should inspect evidence, borderline teams, flags, corrections and overrides.
        </p>
      </section>
      <section>
        <h2>Organizer responsibility</h2>
        <p>
          Organizers remain responsible for lawful consent, fair criteria and published outcomes.
        </p>
      </section>
      <section>
        <h2>Service limits</h2>
        <p>
          Public-repository evidence is incomplete by nature. Confidence communicates that limit.
        </p>
      </section>
    </article>
  );
}

export function NotFoundPage() {
  return (
    <div className="contained-page">
      <EmptyState title="Route not found" action={<ActionLink to="/">Return home</ActionLink>}>
        TalentRadar does not have a page at this address.
      </EmptyState>
    </div>
  );
}
