import { taxonomy } from "@talentradar/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ActionButton,
  ActionLink,
  Badge,
  EmptyState,
  Field,
  PageHeading,
  Panel,
  SelectInput,
  StepRail,
  TextArea,
  TextInput,
} from "../components/ui";
import {
  type CreateEventInput,
  createOrganizerEvent,
  getCurrentUser,
  getOrganizerEvent,
  getOrganizerEvents,
  publishOrganizerEvent,
} from "../lib/api";

const eventSteps = ["Basics", "Timeline", "Teams and seats", "Requirements and quotas"] as const;
const quickSteps = ["Upload", "Map columns", "Consent", "Build profiles"] as const;

interface RequirementDraft {
  id: number;
  skill: string;
  target: number;
  weight: number;
}

const technologyOptions = Object.entries(taxonomy.technologies)
  .map(([id, technology]) => ({ id, label: technology.label }))
  .sort((left, right) => left.label.localeCompare(right.label));

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function istDateTimeToIso(value: string): string {
  return new Date(`${value}:00+05:30`).toISOString();
}

function UnauthenticatedOrganizerNotice({ pending }: { pending: boolean }) {
  if (pending) return null;
  return (
    <div className="context-notice">
      <span aria-hidden="true">i</span>
      <p>Sign in with GitHub to create events and access organizer-owned records.</p>
      <ActionLink to="/login" tone="secondary">
        Sign in
      </ActionLink>
    </div>
  );
}

export function OrganizerDashboard() {
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const events = useQuery({
    queryKey: ["organizer-events"],
    queryFn: getOrganizerEvents,
    enabled: Boolean(account.data),
    retry: false,
  });
  const organizerEvents = events.data ?? [];

  return (
    <div className="portal-page organizer-dashboard">
      <PageHeading
        eyebrow="ORGANIZER / WORKSPACE"
        title="Events and shortlist runs"
        description="Create a full event or bring an existing registration sheet into the same evidence and ranking engine."
        action={
          <>
            <ActionLink to="/organizer/events/new">New event</ActionLink>
            <ActionLink to="/organizer/quick/new" tone="secondary">
              Quick shortlist
            </ActionLink>
          </>
        }
      />
      {!account.data ? <UnauthenticatedOrganizerNotice pending={account.isPending} /> : null}
      <div className="metric-strip">
        <div>
          <span>UPCOMING</span>
          <strong>{organizerEvents.filter((event) => event.visibility === "draft").length}</strong>
          <small>Draft events</small>
        </div>
        <div>
          <span>LIVE</span>
          <strong>
            {organizerEvents.filter((event) => event.visibility === "published").length}
          </strong>
          <small>Published events</small>
        </div>
        <div>
          <span>PAST</span>
          <strong>{organizerEvents.filter((event) => event.visibility === "closed").length}</strong>
          <small>Closed records</small>
        </div>
        <div>
          <span>QUICK RUNS</span>
          <strong>0</strong>
          <small>No account data loaded</small>
        </div>
      </div>

      <div className="dashboard-grid">
        <Panel
          label="01 / EVENTS"
          title="Hackathon workspace"
          className="span-two"
          action={
            <ActionLink to="/organizer/events/new" tone="quiet">
              Create event
            </ActionLink>
          }
        >
          {events.isPending && account.data ? (
            <div className="loading-state">Reading event records…</div>
          ) : null}
          {events.isError ? <div className="error-state">{events.error.message}</div> : null}
          {organizerEvents.length === 0 && !events.isPending ? (
            <EmptyState
              title="No events in this workspace"
              action={<ActionLink to="/organizer/events/new">Create the first event</ActionLink>}
            >
              Draft, live, and past events appear here with registration, team, and profile-build
              counts from the service.
            </EmptyState>
          ) : null}
          {organizerEvents.length > 0 ? (
            <div className="event-table">
              <div className="table-row table-head">
                <span>EVENT</span>
                <span>STATE</span>
                <span>REGISTRATION</span>
                <span>START</span>
                <span />
              </div>
              {organizerEvents.map((event) => (
                <div className="table-row" key={event.id}>
                  <strong>{event.name}</strong>
                  <Badge tone={event.visibility === "published" ? "success" : "neutral"}>
                    {event.visibility}
                  </Badge>
                  <span>
                    {event.registrationClosesAt
                      ? new Date(event.registrationClosesAt).toLocaleDateString()
                      : "Not set"}
                  </span>
                  <span>
                    {event.eventStartsAt
                      ? new Date(event.eventStartsAt).toLocaleDateString()
                      : "Not set"}
                  </span>
                  <ActionLink to={`/organizer/events/${event.id}`} tone="quiet">
                    Open
                  </ActionLink>
                </div>
              ))}
            </div>
          ) : null}
        </Panel>
        <Panel label="02 / IMPORT" title="Already have registrations?">
          <p className="prose-copy">
            Upload a CSV from your existing form, confirm its columns and consent, then build
            unverified profiles from public GitHub accounts.
          </p>
          <ul className="terminal-list">
            <li>UTF-8 CSV, up to 2,000 rows</li>
            <li>Optional CV ZIP, up to 200 MB</li>
            <li>Same shortlist controls and explanations</li>
          </ul>
          <ActionLink to="/organizer/quick/new" tone="secondary">
            Start quick shortlist
          </ActionLink>
        </Panel>
      </div>
    </div>
  );
}

export function EventWizardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [bannerUrl, setBannerUrl] = useState("");
  const [mode, setMode] = useState<CreateEventInput["mode"]>("in_person");
  const [venue, setVenue] = useState("");
  const [timeline, setTimeline] = useState({
    registrationOpensAt: "",
    registrationClosesAt: "",
    shortlistPublishesAt: "",
    rsvpDeadlineAt: "",
    eventStartsAt: "",
    eventEndsAt: "",
  });
  const [minimumTeamSize, setMinimumTeamSize] = useState(2);
  const [maximumTeamSize, setMaximumTeamSize] = useState(4);
  const [capacity, setCapacity] = useState(100);
  const [requirements, setRequirements] = useState<RequirementDraft[]>([]);
  const [requirementSkill, setRequirementSkill] = useState("");
  const [nextRequirementId, setNextRequirementId] = useState(1);

  const addRequirement = () => {
    if (!requirementSkill || requirements.some((item) => item.skill === requirementSkill)) return;
    setRequirements((current) => [
      ...current,
      { id: nextRequirementId, skill: requirementSkill, target: 3, weight: 3 },
    ]);
    setNextRequirementId((value) => value + 1);
    setRequirementSkill("");
  };

  const updateRequirement = (id: number, key: "target" | "weight", value: number) => {
    setRequirements((current) =>
      current.map((item) => (item.id === id ? { ...item, [key]: value } : item)),
    );
  };

  const timelineComplete = Object.values(timeline).every(Boolean);
  const stepValid = [
    name.trim().length >= 3 &&
      Boolean(slug) &&
      Boolean(tagline.trim()) &&
      Boolean(description.trim()) &&
      (mode === "online" || Boolean(venue.trim())),
    timelineComplete,
    minimumTeamSize <= maximumTeamSize && capacity > 0,
    requirements.length > 0 && requirements.some((requirement) => requirement.weight > 0),
  ];

  const createEvent = useMutation({
    mutationFn: createOrganizerEvent,
    onSuccess: async (event) => {
      await queryClient.invalidateQueries({ queryKey: ["organizer-events"] });
      navigate(`/organizer/events/${event.id}`);
    },
  });

  const submit = () => {
    if (!stepValid.every(Boolean)) return;
    createEvent.mutate({
      name: name.trim(),
      slug,
      tagline: tagline.trim(),
      description: description.trim(),
      ...(logoUrl ? { logoUrl } : {}),
      ...(bannerUrl ? { bannerUrl } : {}),
      links: [],
      mode,
      ...(venue ? { venue: venue.trim() } : {}),
      timeline: {
        timezone: "Asia/Kolkata",
        registrationOpensAt: istDateTimeToIso(timeline.registrationOpensAt),
        registrationClosesAt: istDateTimeToIso(timeline.registrationClosesAt),
        shortlistPublishesAt: istDateTimeToIso(timeline.shortlistPublishesAt),
        rsvpDeadlineAt: istDateTimeToIso(timeline.rsvpDeadlineAt),
        eventStartsAt: istDateTimeToIso(timeline.eventStartsAt),
        eventEndsAt: istDateTimeToIso(timeline.eventEndsAt),
      },
      teamSize: { min: minimumTeamSize, max: maximumTeamSize },
      capacity,
      requirements: requirements.map((requirement) => ({
        skill: requirement.skill,
        target: requirement.target,
        weight: requirement.weight,
        coverage: { mode: "any_member" },
      })),
    });
  };

  return (
    <div className="portal-page wizard-page">
      <PageHeading
        eyebrow="ORGANIZER / NEW EVENT"
        title="Create a hackathon workspace"
        description="Configure the public page, application timeline, team rules, and transparent shortlist parameters."
      />
      <StepRail steps={eventSteps} current={step} />
      <div className="wizard-layout">
        <Panel
          label={`STEP ${step + 1} / ${eventSteps.length}`}
          title={eventSteps[step] ?? eventSteps[0]}
          className="wizard-main"
        >
          {step === 0 ? (
            <div className="form-grid">
              <Field label="Event name" hint="3–80 characters; required.">
                <TextInput
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (!slug) setSlug(slugify(event.target.value));
                  }}
                  placeholder="Hackathon name"
                  maxLength={80}
                />
              </Field>
              <Field
                label="Public slug"
                hint={slug ? `Public URL: /h/${slug}` : "Lowercase letters, numbers and hyphens."}
              >
                <TextInput
                  value={slug}
                  onChange={(event) => setSlug(slugify(event.target.value))}
                  placeholder="event-name"
                  maxLength={40}
                />
              </Field>
              <Field label="Tagline" className="full-field">
                <TextInput
                  value={tagline}
                  onChange={(event) => setTagline(event.target.value)}
                  placeholder="A concise line for the public event page"
                  maxLength={140}
                />
              </Field>
              <Field
                label="Description"
                hint="Markdown, up to 5,000 characters."
                className="full-field"
              >
                <TextArea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={8}
                  placeholder="Rules, prizes, themes, schedule and participation details"
                  maxLength={5000}
                />
              </Field>
              <Field label="Logo URL">
                <TextInput
                  value={logoUrl}
                  onChange={(event) => setLogoUrl(event.target.value)}
                  type="url"
                  placeholder="https://…"
                />
              </Field>
              <Field label="Banner URL">
                <TextInput
                  value={bannerUrl}
                  onChange={(event) => setBannerUrl(event.target.value)}
                  type="url"
                  placeholder="https://…"
                />
              </Field>
              <Field label="Mode">
                <SelectInput
                  value={mode}
                  onChange={(event) => setMode(event.target.value as CreateEventInput["mode"])}
                >
                  <option value="in_person">In person</option>
                  <option value="online">Online</option>
                  <option value="hybrid">Hybrid</option>
                </SelectInput>
              </Field>
              <Field
                label="Venue"
                hint={
                  mode === "online"
                    ? "Optional for online events."
                    : "Required for in-person and hybrid events."
                }
              >
                <TextInput
                  value={venue}
                  onChange={(event) => setVenue(event.target.value)}
                  placeholder="Building, campus or city"
                  disabled={mode === "online"}
                />
              </Field>
              <div className="repeater full-field">
                <div>
                  <strong>Event links</strong>
                  <span>Discord, rulebook, website, social channels</span>
                </div>
                <div className="link-row">
                  <TextInput aria-label="Link label" placeholder="Label" />
                  <TextInput aria-label="Link URL" type="url" placeholder="https://…" />
                  <ActionButton tone="secondary">Add link</ActionButton>
                </div>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="timeline-grid">
              <Field label="Registration opens">
                <TextInput
                  type="datetime-local"
                  value={timeline.registrationOpensAt}
                  onChange={(event) =>
                    setTimeline((current) => ({
                      ...current,
                      registrationOpensAt: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Registration closes" hint="Teams lock at this time.">
                <TextInput
                  type="datetime-local"
                  value={timeline.registrationClosesAt}
                  onChange={(event) =>
                    setTimeline((current) => ({
                      ...current,
                      registrationClosesAt: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Shortlist published">
                <TextInput
                  type="datetime-local"
                  value={timeline.shortlistPublishesAt}
                  onChange={(event) =>
                    setTimeline((current) => ({
                      ...current,
                      shortlistPublishesAt: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="RSVP deadline">
                <TextInput
                  type="datetime-local"
                  value={timeline.rsvpDeadlineAt}
                  onChange={(event) =>
                    setTimeline((current) => ({ ...current, rsvpDeadlineAt: event.target.value }))
                  }
                />
              </Field>
              <Field label="Event starts">
                <TextInput
                  type="datetime-local"
                  value={timeline.eventStartsAt}
                  onChange={(event) =>
                    setTimeline((current) => ({ ...current, eventStartsAt: event.target.value }))
                  }
                />
              </Field>
              <Field label="Event ends">
                <TextInput
                  type="datetime-local"
                  value={timeline.eventEndsAt}
                  onChange={(event) =>
                    setTimeline((current) => ({ ...current, eventEndsAt: event.target.value }))
                  }
                />
              </Field>
              <div className="timezone-note full-field">
                <span>TIMEZONE</span>
                <strong>Asia/Kolkata · IST</strong>
                <p>Times are entered in IST and stored in UTC.</p>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="form-grid">
              <Field label="Minimum team size">
                <TextInput
                  type="number"
                  min="1"
                  max="6"
                  value={minimumTeamSize}
                  onChange={(event) => setMinimumTeamSize(Number(event.target.value))}
                />
              </Field>
              <Field label="Maximum team size">
                <TextInput
                  type="number"
                  min="1"
                  max="6"
                  value={maximumTeamSize}
                  onChange={(event) => setMaximumTeamSize(Number(event.target.value))}
                />
              </Field>
              <Field label="Participant capacity" hint="Seats to fill, not expected sign-ups.">
                <TextInput
                  type="number"
                  min="1"
                  max="5000"
                  value={capacity}
                  onChange={(event) => setCapacity(Number(event.target.value))}
                />
              </Field>
              <Field label="CV requirement">
                <SelectInput defaultValue="required">
                  <option value="required">Required</option>
                  <option value="optional">Optional</option>
                </SelectInput>
              </Field>
              <div className="rule-explainer full-field">
                <span>TEAM RULES</span>
                <p>
                  A minimum of one enables solo applications. Team size is checked on submit, and
                  every team locks when registration closes.
                </p>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="requirements-builder">
              <div className="requirement-adder">
                <Field label="Search taxonomy">
                  <SelectInput
                    value={requirementSkill}
                    onChange={(event) => setRequirementSkill(event.target.value)}
                  >
                    <option value="">Select a technology or skill</option>
                    {technologyOptions.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
                <ActionButton onClick={addRequirement} disabled={!requirementSkill}>
                  Add requirement
                </ActionButton>
              </div>
              {requirements.length === 0 ? (
                <EmptyState title="No requirements added">
                  Add the capabilities this event needs. Each requirement gets a target level and
                  decision weight.
                </EmptyState>
              ) : (
                <div className="requirement-editor">
                  <div className="requirement-head">
                    <span>SKILL</span>
                    <span>TARGET</span>
                    <span>WEIGHT</span>
                    <span />
                  </div>
                  {requirements.map((requirement) => {
                    const label =
                      taxonomy.technologies[requirement.skill]?.label ?? requirement.skill;
                    return (
                      <div className="requirement-edit-row" key={requirement.id}>
                        <strong>{label}</strong>
                        <label>
                          <span>{requirement.target.toFixed(1)}</span>
                          <input
                            type="range"
                            min="1"
                            max="5"
                            step="0.5"
                            value={requirement.target}
                            onChange={(event) =>
                              updateRequirement(
                                requirement.id,
                                "target",
                                Number(event.target.value),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>{requirement.weight}</span>
                          <input
                            type="range"
                            min="0"
                            max="5"
                            step="1"
                            value={requirement.weight}
                            onChange={(event) =>
                              updateRequirement(
                                requirement.id,
                                "weight",
                                Number(event.target.value),
                              )
                            }
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            setRequirements((current) =>
                              current.filter((item) => item.id !== requirement.id),
                            )
                          }
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="builder-sections">
                <section>
                  <div>
                    <span>QUOTAS</span>
                    <Badge tone="neutral">Optional</Badge>
                  </div>
                  <p>
                    Build auditable rules from attribute, operator, value, minimum share, unit and
                    match mode.
                  </p>
                  <ActionButton tone="secondary">Add quota rule</ActionButton>
                </section>
                <section>
                  <div>
                    <span>COLLEGE ALIASES</span>
                    <Badge tone="neutral">0 mappings</Badge>
                  </div>
                  <p>Normalize institution names before a college-based quota can be trusted.</p>
                  <ActionButton tone="secondary">Add alias</ActionButton>
                </section>
                <section>
                  <div>
                    <span>VISIBILITY</span>
                    <Badge tone="warning">Draft</Badge>
                  </div>
                  <SelectInput defaultValue="draft" aria-label="Event visibility">
                    <option value="draft">Draft</option>
                    <option value="published">Published</option>
                    <option value="closed">Closed</option>
                  </SelectInput>
                </section>
              </div>
            </div>
          ) : null}

          <div className="wizard-actions">
            <ActionButton
              tone="quiet"
              disabled={step === 0}
              onClick={() => setStep((value) => Math.max(0, value - 1))}
            >
              Back
            </ActionButton>
            {step < eventSteps.length - 1 ? (
              <ActionButton
                disabled={!stepValid[step]}
                onClick={() => setStep((value) => Math.min(eventSteps.length - 1, value + 1))}
              >
                Continue
              </ActionButton>
            ) : (
              <ActionButton
                disabled={!stepValid.every(Boolean) || createEvent.isPending}
                onClick={submit}
              >
                {createEvent.isPending ? "Creating…" : "Create draft"}
              </ActionButton>
            )}
          </div>
          {createEvent.isError ? (
            <div className="error-state" role="alert">
              {createEvent.error.message}
            </div>
          ) : null}
        </Panel>
        <aside className="wizard-aside">
          <Panel label="PUBLIC / PREVIEW" title={name || "Untitled event"}>
            <p className="preview-slug">/h/{slug || "event-slug"}</p>
            <Badge tone="warning">Draft</Badge>
            <p className="prose-copy">
              The stable public page reflects the current event status, requirements, timeline, and
              countdown.
            </p>
          </Panel>
          <Panel label="SETUP / REQUIRED" title="Publish checklist">
            <ul className="check-list">
              <li className={name ? "done" : ""}>Event name</li>
              <li className={slug ? "done" : ""}>Unique public slug</li>
              <li>Valid timeline</li>
              <li>At least one requirement</li>
              <li>Organizer account</li>
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

export function QuickShortlistPage() {
  const { quickId } = useParams();
  const [step, setStep] = useState(quickId ? 1 : 0);
  const [consent, setConsent] = useState(false);

  return (
    <div className="portal-page wizard-page">
      <PageHeading
        eyebrow="ORGANIZER / QUICK SHORTLIST"
        title="Import existing registrations"
        description="Bring a CSV into the full evidence, ranking, explanation, and export workflow."
      />
      <StepRail steps={quickSteps} current={step} />
      <div className="wizard-layout">
        <Panel
          label={`STEP ${step + 1} / ${quickSteps.length}`}
          title={quickSteps[step] ?? quickSteps[0]}
          className="wizard-main"
        >
          {step === 0 ? (
            <div className="upload-pair">
              <div className="upload-zone">
                <span aria-hidden="true">CSV</span>
                <h3>Registration responses</h3>
                <p>UTF-8 CSV with a header row, up to 2,000 records.</p>
                <input id="quick-csv" type="file" accept=".csv,text/csv" />
                <label className="btn terminal-action action-secondary" htmlFor="quick-csv">
                  [ Choose CSV ]
                </label>
              </div>
              <div className="upload-zone optional">
                <span aria-hidden="true">ZIP</span>
                <h3>CV archive</h3>
                <p>Optional ZIP of PDFs, up to 200 MB. Useful for private Google Forms uploads.</p>
                <input id="quick-zip" type="file" accept=".zip,application/zip" />
                <label className="btn terminal-action action-secondary" htmlFor="quick-zip">
                  [ Choose ZIP ]
                </label>
              </div>
            </div>
          ) : null}
          {step === 1 ? (
            <div>
              <div className="context-notice compact">
                <span aria-hidden="true">i</span>
                <p>
                  Column headers are detected after a CSV is selected. Confirm every required
                  mapping before import.
                </p>
              </div>
              <div className="mapping-table">
                <div>
                  <span>TALENTRADAR FIELD</span>
                  <span>CSV COLUMN</span>
                  <span>REQUIRED</span>
                </div>
                {[
                  ["Name", "Yes"],
                  ["Email", "Yes"],
                  ["GitHub username", "No"],
                  ["CV file", "No"],
                  ["Team name", "No"],
                  ["College", "No"],
                  ["Year of study", "No"],
                  ["Branch", "No"],
                ].map(([field, required]) => (
                  <div key={field}>
                    <strong>{field}</strong>
                    <SelectInput disabled aria-label={`${field} column`}>
                      <option>No CSV loaded</option>
                    </SelectInput>
                    <Badge tone={required === "Yes" ? "warning" : "neutral"}>{required}</Badge>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="consent-copy">
              <h3>Confirm registrant notice</h3>
              <p>
                People imported from a form did not consent inside TalentRadar. The organizer must
                confirm they were told that GitHub and CV data would be evaluated automatically.
              </p>
              <label className="terminal-check">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  I confirm every imported registrant received this notice before their data was
                  collected.
                </span>
              </label>
              <div className="warning-block">
                <strong>Organizer responsibility</strong>
                <p>
                  Do not continue if the original form omitted this disclosure. Add consent and
                  collect responses again.
                </p>
              </div>
            </div>
          ) : null}
          {step === 3 ? (
            <EmptyState title="Import has not started">
              After a valid CSV, confirmed mapping, and consent, real profile progress and failures
              will appear here. No activity is simulated.
            </EmptyState>
          ) : null}
          <div className="wizard-actions">
            <ActionButton
              tone="quiet"
              disabled={step === 0}
              onClick={() => setStep((value) => Math.max(0, value - 1))}
            >
              Back
            </ActionButton>
            {step < quickSteps.length - 1 ? (
              <ActionButton
                onClick={() => setStep((value) => Math.min(quickSteps.length - 1, value + 1))}
              >
                Continue
              </ActionButton>
            ) : (
              <ActionButton disabled>Start import</ActionButton>
            )}
          </div>
        </Panel>
        <aside className="wizard-aside">
          <Panel label="IMPORT / LIMITS" title="Accepted inputs">
            <dl className="compact-definition-list">
              <div>
                <dt>CSV</dt>
                <dd>UTF-8 · 2,000 rows</dd>
              </div>
              <div>
                <dt>CV archive</dt>
                <dd>ZIP · 200 MB</dd>
              </div>
              <div>
                <dt>Repositories</dt>
                <dd>6 recent non-forks</dd>
              </div>
              <div>
                <dt>GitHub identity</dt>
                <dd>Unverified</dd>
              </div>
            </dl>
          </Panel>
          <Panel label="GOOGLE FORMS / CV" title="Why the ZIP matters">
            <p className="prose-copy">
              Google Forms upload links usually require the form owner's Drive session. Attach the
              downloaded upload folder so files can be matched locally by filename or email.
            </p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function eventLabel(eventId?: string) {
  return eventId && eventId !== "current" ? eventId : "EVENT WORKSPACE";
}

export function EventOverviewPage() {
  const { eventId } = useParams();
  const queryClient = useQueryClient();
  const event = useQuery({
    queryKey: ["organizer-event", eventId],
    queryFn: () => getOrganizerEvent(eventId ?? ""),
    enabled: Boolean(eventId),
    retry: false,
  });
  const publish = useMutation({
    mutationFn: () => publishOrganizerEvent(eventId ?? ""),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organizer-event", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-events"] }),
        queryClient.invalidateQueries({ queryKey: ["public-events"] }),
      ]);
    },
  });

  if (event.isPending) return <div className="loading-state">Loading event workspace…</div>;
  if (event.isError) {
    return (
      <div className="portal-page">
        <EmptyState
          title="Event unavailable"
          action={<ActionLink to="/organizer">Back to events</ActionLink>}
        >
          {event.error.message}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="ORGANIZER / EVENT"
        title={event.data.name}
        description="Registration, team, profile, and timeline state for this workspace."
        action={
          <>
            {event.data.visibility === "draft" ? (
              <ActionButton onClick={() => publish.mutate()} disabled={publish.isPending}>
                {publish.isPending ? "Publishing…" : "Publish event"}
              </ActionButton>
            ) : null}
            <ActionLink to={`/organizer/events/${eventId}/shortlist`} tone="secondary">
              Open shortlist
            </ActionLink>
          </>
        }
      />
      <div className="event-identity">
        <span>WORKSPACE</span>
        <strong>{event.data.slug}</strong>
        <Badge tone={event.data.visibility === "published" ? "success" : "warning"}>
          {event.data.visibility}
        </Badge>
      </div>
      {publish.isError ? (
        <div className="error-state" role="alert">
          {publish.error.message}
        </div>
      ) : null}
      <div className="metric-strip">
        <div>
          <span>REGISTRATIONS</span>
          <strong>{event.data.metrics.registrations}</strong>
          <small>Application records</small>
        </div>
        <div>
          <span>TEAMS</span>
          <strong>{event.data.metrics.teams}</strong>
          <small>Team records</small>
        </div>
        <div>
          <span>PROFILES READY</span>
          <strong>{event.data.metrics.profilesReady}</strong>
          <small>Built profiles</small>
        </div>
        <div>
          <span>DEADLINE</span>
          <strong>
            {event.data.timeline
              ? new Date(event.data.timeline.registrationClosesAt).toLocaleDateString()
              : "Not set"}
          </strong>
          <small>{event.data.timeline?.timezone ?? "No timeline"}</small>
        </div>
      </div>
      <div className="dashboard-grid">
        <Panel label="01 / ACTIVITY" title="Registration flow" className="span-two">
          <EmptyState title="No registrations yet">
            Applications will appear here after participants submit through the published event
            page.
          </EmptyState>
        </Panel>
        <Panel label="02 / TIMELINE" title="Next milestone">
          {event.data.timeline ? (
            <dl className="compact-definition-list">
              <div>
                <dt>Registration closes</dt>
                <dd>{new Date(event.data.timeline.registrationClosesAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Shortlist publishes</dt>
                <dd>{new Date(event.data.timeline.shortlistPublishesAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Event starts</dt>
                <dd>{new Date(event.data.timeline.eventStartsAt).toLocaleString()}</dd>
              </div>
            </dl>
          ) : (
            <EmptyState title="No timeline configured">
              Add the event timeline in settings.
            </EmptyState>
          )}
        </Panel>
      </div>
    </div>
  );
}

export function EventSectionPage({
  section,
}: {
  section: "requirements" | "participants" | "teams" | "settings";
}) {
  const [copyTitle, copyDescription] = (
    {
      requirements: [
        "Requirements and quotas",
        "Edit target levels, weights, quotas, and college aliases before publishing a run.",
      ],
      participants: [
        "Participants",
        "Track consent, GitHub verification, CV processing, and profile build state.",
      ],
      teams: [
        "Teams",
        "Inspect membership, submission eligibility, locks, and looking-for-team participants.",
      ],
      settings: [
        "Event settings",
        "Update the public page, timeline, team rules, links, visibility, and retention controls.",
      ],
    } as const
  )[section];
  return (
    <div className="portal-page">
      <PageHeading
        eyebrow={`ORGANIZER / ${section.toUpperCase()}`}
        title={copyTitle}
        description={copyDescription}
        action={
          section === "requirements" ? (
            <ActionButton disabled>Save changes</ActionButton>
          ) : undefined
        }
      />
      <Panel label="EVENT / DATA" title="No event loaded">
        <EmptyState title={`No ${section} to display`}>
          Open a real event from the organizer workspace. This screen never fills itself with
          example records.
        </EmptyState>
      </Panel>
    </div>
  );
}

export function ShortlistWorkspacePage() {
  const { eventId } = useParams();
  const [alpha, setAlpha] = useState(0.65);
  const [novelty, setNovelty] = useState(0.1);
  const [capacity, setCapacity] = useState(100);
  const [waitlist, setWaitlist] = useState(10);
  const [mobilePane, setMobilePane] = useState<"parameters" | "results" | "inspector">("results");
  const panes = useMemo(() => ["parameters", "results", "inspector"] as const, []);

  return (
    <div className="shortlist-page">
      <header className="shortlist-heading">
        <div>
          <p>ORGANIZER / SHORTLIST</p>
          <h1>Decision workspace</h1>
          <span>{eventLabel(eventId)} · re-ranking runs locally after profiles are loaded</span>
        </div>
        <div className="shortlist-actions">
          <ActionButton tone="secondary" disabled>
            Save run
          </ActionButton>
          <ActionButton tone="secondary" disabled>
            Compare
          </ActionButton>
          <ActionButton disabled>Publish</ActionButton>
        </div>
      </header>
      <div className="mobile-pane-tabs" role="tablist">
        {panes.map((pane) => (
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === pane}
            key={pane}
            onClick={() => setMobilePane(pane)}
          >
            {pane}
          </button>
        ))}
      </div>
      <div className="shortlist-panes">
        <section
          className={`shortlist-pane parameters-pane ${mobilePane === "parameters" ? "mobile-active" : ""}`}
        >
          <header>
            <span>01 / PARAMETERS</span>
            <Badge tone="neutral">Editable</Badge>
          </header>
          <div className="pane-scroll">
            <label className="parameter-control">
              <span>
                <strong>Fit / depth balance</strong>
                <output>{alpha.toFixed(2)}</output>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={alpha}
                onChange={(event) => setAlpha(Number(event.target.value))}
              />
              <small>Lower favours raw strength; higher favours balanced coverage.</small>
            </label>
            <label className="parameter-control">
              <span>
                <strong>Novelty weight</strong>
                <output>{novelty.toFixed(2)}</output>
              </span>
              <input
                type="range"
                min="0"
                max="0.5"
                step="0.05"
                value={novelty}
                onChange={(event) => setNovelty(Number(event.target.value))}
              />
              <small>Contribution from the team's strongest original project.</small>
            </label>
            <div className="numeric-controls">
              <Field label="Capacity">
                <TextInput
                  type="number"
                  min="1"
                  max="5000"
                  value={capacity}
                  onChange={(event) => setCapacity(Number(event.target.value))}
                />
              </Field>
              <Field label="Waitlist size">
                <TextInput
                  type="number"
                  min="0"
                  max="500"
                  value={waitlist}
                  onChange={(event) => setWaitlist(Number(event.target.value))}
                />
              </Field>
            </div>
            <div className="parameter-section">
              <div>
                <strong>Requirements</strong>
                <ActionLink to={`/organizer/events/${eventId}/requirements`} tone="quiet">
                  Edit
                </ActionLink>
              </div>
              <EmptyState title="No requirements loaded">
                Targets and weights appear here from the event.
              </EmptyState>
            </div>
            <div className="parameter-section">
              <div>
                <strong>Confidence factors</strong>
              </div>
              <dl className="compact-definition-list">
                <div>
                  <dt>Verified GitHub</dt>
                  <dd>—</dd>
                </div>
                <div>
                  <dt>Unverified import</dt>
                  <dd>—</dd>
                </div>
                <div>
                  <dt>CV-only claim</dt>
                  <dd>—</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>
        <section
          className={`shortlist-pane results-pane ${mobilePane === "results" ? "mobile-active" : ""}`}
        >
          <header>
            <span>02 / RANKED TEAMS</span>
            <Badge tone="neutral">0 results</Badge>
          </header>
          <div className="unmapped-notice">
            <span>COLLEGE ALIASES</span>
            <p>Unmapped names will be listed here before any quota result can be trusted.</p>
          </div>
          <div className="shortlist-table">
            <div className="shortlist-table-head">
              <span>RANK / TEAM</span>
              <span>FIT</span>
              <span>DEPTH</span>
              <span>NOVELTY</span>
              <span>SCORE</span>
              <span>STATE</span>
            </div>
            <EmptyState title="No teams to rank">
              Load completed profiles and at least one requirement. The table is computed from real
              event data only.
            </EmptyState>
          </div>
          <footer className="results-footer">
            <span>Cutoff —</span>
            <span>Borderline band ±3.0</span>
            <span>Selected 0 / {capacity}</span>
          </footer>
        </section>
        <section
          className={`shortlist-pane inspector-pane ${mobilePane === "inspector" ? "mobile-active" : ""}`}
        >
          <header>
            <span>03 / INSPECTOR</span>
            <Badge tone="neutral">No selection</Badge>
          </header>
          <div className="pane-scroll">
            <EmptyState title="Select a team">
              The explanation opens here with evidence, requirement breakdown, decision reason,
              cutoff gap, quota swaps, and logged overrides.
            </EmptyState>
            <div className="explain-contract">
              <span>EVERY RESULT EXPLAINS</span>
              <ol>
                <li>
                  <strong>Evidence</strong>
                  <p>Skill, confidence, repository, fixed commit, file and model reasoning.</p>
                </li>
                <li>
                  <strong>Breakdown</strong>
                  <p>Target, best member, coverage, points gained or lost, novelty source.</p>
                </li>
                <li>
                  <strong>Decision</strong>
                  <p>Rank, cutoff gap, quota swaps and override reasons.</p>
                </li>
              </ol>
            </div>
          </div>
          <footer className="inspector-actions">
            <ActionButton tone="secondary" disabled>
              Override
            </ActionButton>
            <ActionButton tone="secondary" disabled>
              Export evidence
            </ActionButton>
          </footer>
        </section>
      </div>
    </div>
  );
}

export function SavedRunPage() {
  const { runId } = useParams();
  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="ORGANIZER / SAVED RUN"
        title="Frozen shortlist run"
        description="Saved parameters, ordered results, explanations, overrides, and publication state."
      />
      <Panel label="RUN / SNAPSHOT" title={runId ? `Run ${runId}` : "Run unavailable"}>
        <EmptyState title="Saved run not found">
          Open a saved run from a real event workspace. Runs are immutable snapshots once published.
        </EmptyState>
      </Panel>
    </div>
  );
}
