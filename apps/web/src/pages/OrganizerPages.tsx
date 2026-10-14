import {
  type QuotaRule,
  type RankingParams,
  rank,
  type SelectionOverride,
  selectShortlist,
  taxonomy,
} from "@talentradar/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ActionButton,
  ActionLink,
  Badge,
  EmptyState,
  Field,
  PageHeading,
  Panel,
  ProgressBar,
  SelectInput,
  StepRail,
  TextArea,
  TextInput,
} from "../components/ui";
import {
  type CreateEventInput,
  createOrganizerEvent,
  createQuickImport,
  type EventConfigurationInput,
  getCurrentUser,
  getOrganizerEvent,
  getOrganizerEventOperations,
  getOrganizerEvents,
  getOrganizerShortlist,
  getOrganizerShortlistRun,
  getQuickImport,
  publishOrganizerEvent,
  publishOrganizerShortlistRun,
  saveOrganizerShortlistRun,
  startQuickImport,
  updateOrganizerEventConfiguration,
  uploadQuickArchive,
  uploadQuickCsv,
} from "../lib/api";

const eventSteps = ["Basics", "Timeline", "Teams and seats", "Requirements and quotas"] as const;
const quickSteps = ["Upload", "Map columns", "Consent", "Build profiles"] as const;
const quickMappingFields = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email", required: true },
  { key: "github", label: "GitHub username", required: false },
  { key: "cv_file", label: "CV file", required: false },
  { key: "team_name", label: "Team name", required: false },
  { key: "college", label: "College", required: false },
  { key: "year_of_study", label: "Year of study", required: false },
  { key: "branch", label: "Branch", required: false },
  { key: "city", label: "City", required: false },
] as const;
type QuickMapping = Partial<Record<(typeof quickMappingFields)[number]["key"], string>>;

interface RequirementDraft {
  id: number;
  skill: string;
  target: number;
  weight: number;
}

const technologyOptions = [
  ...Object.entries(taxonomy.domains).map(([id, domain]) => ({
    id,
    label: `${domain.label} · domain`,
  })),
  ...Object.entries(taxonomy.technologies).map(([id, technology]) => ({
    id,
    label: technology.label,
  })),
].sort((left, right) => left.label.localeCompare(right.label));

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

function isoToIstDateTime(value: string): string {
  const instant = new Date(value);
  return new Date(instant.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 16);
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
  const fullEvents = organizerEvents.filter((event) => event.kind === "event");
  const quickEvents = organizerEvents.filter((event) => event.kind === "quick");

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
          <strong>{fullEvents.filter((event) => event.visibility === "draft").length}</strong>
          <small>Draft events</small>
        </div>
        <div>
          <span>LIVE</span>
          <strong>{fullEvents.filter((event) => event.visibility === "published").length}</strong>
          <small>Published events</small>
        </div>
        <div>
          <span>PAST</span>
          <strong>{fullEvents.filter((event) => event.visibility === "closed").length}</strong>
          <small>Closed records</small>
        </div>
        <div>
          <span>QUICK RUNS</span>
          <strong>{quickEvents.length}</strong>
          <small>Imported workspaces</small>
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
                  <strong>
                    {event.name} {event.kind === "quick" ? <small>QUICK</small> : null}
                  </strong>
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
                  <ActionLink
                    to={
                      event.kind === "quick"
                        ? `/organizer/quick/${event.id}/import`
                        : `/organizer/events/${event.id}`
                    }
                    tone="quiet"
                  >
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
  const [links, setLinks] = useState<Array<{ label: string; url: string }>>([]);
  const [linkDraft, setLinkDraft] = useState({ label: "", url: "" });
  const [quotas, setQuotas] = useState<QuotaRule[]>([]);
  const [quotaDraft, setQuotaDraft] = useState<{
    attribute: QuotaRule["attribute"];
    op: QuotaRule["op"];
    value: string;
    minShare: number;
    unit: QuotaRule["unit"];
    match: NonNullable<QuotaRule["match"]>;
  }>({
    attribute: "college",
    op: "not_equals",
    value: "",
    minShare: 0.1,
    unit: "teams",
    match: "all",
  });
  const [collegeAliases, setCollegeAliases] = useState<Record<string, string[]>>({});
  const [aliasDraft, setAliasDraft] = useState({ canonical: "", aliases: "" });

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

  const addLink = () => {
    const label = linkDraft.label.trim();
    const url = linkDraft.url.trim();
    if (!label || !URL.canParse(url) || links.length >= 12) return;
    setLinks((current) => [...current, { label, url }]);
    setLinkDraft({ label: "", url: "" });
  };

  const addQuota = () => {
    const rawValue = quotaDraft.value.trim();
    if (!rawValue || quotas.length >= 20) return;
    const value =
      quotaDraft.op === "in" || quotaDraft.op === "not_in"
        ? rawValue
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : rawValue;
    setQuotas((current) => [...current, { ...quotaDraft, value }]);
    setQuotaDraft((current) => ({ ...current, value: "" }));
  };

  const addAlias = () => {
    const canonical = aliasDraft.canonical.trim();
    const aliases = aliasDraft.aliases
      .split(",")
      .map((alias) => alias.trim())
      .filter(Boolean);
    if (!canonical || aliases.length === 0) return;
    setCollegeAliases((current) => ({ ...current, [canonical]: aliases }));
    setAliasDraft({ canonical: "", aliases: "" });
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
      links,
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
      quotas,
      collegeAliases,
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
                  <TextInput
                    aria-label="Link label"
                    placeholder="Label"
                    value={linkDraft.label}
                    onChange={(event) =>
                      setLinkDraft((current) => ({ ...current, label: event.target.value }))
                    }
                  />
                  <TextInput
                    aria-label="Link URL"
                    type="url"
                    placeholder="https://…"
                    value={linkDraft.url}
                    onChange={(event) =>
                      setLinkDraft((current) => ({ ...current, url: event.target.value }))
                    }
                  />
                  <ActionButton
                    tone="secondary"
                    disabled={
                      !linkDraft.label.trim() ||
                      !URL.canParse(linkDraft.url.trim()) ||
                      links.length >= 12
                    }
                    onClick={addLink}
                  >
                    Add link
                  </ActionButton>
                </div>
                {links.length ? (
                  <div className="draft-item-list">
                    {links.map((link) => (
                      <div key={`${link.label}-${link.url}`}>
                        <span>
                          <strong>{link.label}</strong>
                          <small>{link.url}</small>
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setLinks((current) => current.filter((candidate) => candidate !== link))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
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
                <section className="wizard-rule-builder">
                  <div>
                    <span>QUOTAS</span>
                    <Badge tone="neutral">{quotas.length} rules</Badge>
                  </div>
                  <p>
                    Build auditable rules from attribute, operator, value, minimum share, unit and
                    match mode.
                  </p>
                  <div className="wizard-quota-fields">
                    <Field label="Attribute">
                      <SelectInput
                        value={quotaDraft.attribute}
                        onChange={(event) =>
                          setQuotaDraft((current) => ({
                            ...current,
                            attribute: event.target.value as QuotaRule["attribute"],
                          }))
                        }
                      >
                        <option value="college">College</option>
                        <option value="year_of_study">Year of study</option>
                        <option value="branch">Branch</option>
                        <option value="city">City</option>
                      </SelectInput>
                    </Field>
                    <Field label="Operator">
                      <SelectInput
                        value={quotaDraft.op}
                        onChange={(event) =>
                          setQuotaDraft((current) => ({
                            ...current,
                            op: event.target.value as QuotaRule["op"],
                          }))
                        }
                      >
                        <option value="equals">Equals</option>
                        <option value="not_equals">Does not equal</option>
                        <option value="in">In list</option>
                        <option value="not_in">Not in list</option>
                      </SelectInput>
                    </Field>
                    <Field
                      label="Value"
                      {...(quotaDraft.op === "in" || quotaDraft.op === "not_in"
                        ? { hint: "Comma-separated values" }
                        : {})}
                    >
                      <TextInput
                        value={quotaDraft.value}
                        onChange={(event) =>
                          setQuotaDraft((current) => ({ ...current, value: event.target.value }))
                        }
                      />
                    </Field>
                    <Field label="Minimum share">
                      <TextInput
                        type="number"
                        min="0.01"
                        max="1"
                        step="0.01"
                        value={quotaDraft.minShare}
                        onChange={(event) =>
                          setQuotaDraft((current) => ({
                            ...current,
                            minShare: Number(event.target.value),
                          }))
                        }
                      />
                    </Field>
                    <Field label="Unit">
                      <SelectInput
                        value={quotaDraft.unit}
                        onChange={(event) =>
                          setQuotaDraft((current) => ({
                            ...current,
                            unit: event.target.value as QuotaRule["unit"],
                          }))
                        }
                      >
                        <option value="teams">Teams</option>
                        <option value="participants">Participants</option>
                      </SelectInput>
                    </Field>
                    <Field label="Team match">
                      <SelectInput
                        value={quotaDraft.match}
                        disabled={quotaDraft.unit === "participants"}
                        onChange={(event) =>
                          setQuotaDraft((current) => ({
                            ...current,
                            match: event.target.value as NonNullable<QuotaRule["match"]>,
                          }))
                        }
                      >
                        <option value="all">All members</option>
                        <option value="majority">Majority</option>
                        <option value="any">Any member</option>
                      </SelectInput>
                    </Field>
                  </div>
                  <ActionButton
                    tone="secondary"
                    disabled={
                      !quotaDraft.value.trim() ||
                      quotaDraft.minShare < 0.01 ||
                      quotaDraft.minShare > 1 ||
                      quotas.length >= 20
                    }
                    onClick={addQuota}
                  >
                    Add quota rule
                  </ActionButton>
                  {quotas.length ? (
                    <div className="draft-item-list">
                      {quotas.map((quota) => (
                        <div key={JSON.stringify(quota)}>
                          <span>
                            <strong>
                              {quota.attribute.replaceAll("_", " ")} {quota.op.replaceAll("_", " ")}{" "}
                              {Array.isArray(quota.value) ? quota.value.join(", ") : quota.value}
                            </strong>
                            <small>
                              {Math.round(quota.minShare * 100)}% of {quota.unit}
                              {quota.unit === "teams" ? ` · ${quota.match}` : ""}
                            </small>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setQuotas((current) =>
                                current.filter((candidate) => candidate !== quota),
                              )
                            }
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
                <section className="wizard-rule-builder">
                  <div>
                    <span>COLLEGE ALIASES</span>
                    <Badge tone="neutral">{Object.keys(collegeAliases).length} mappings</Badge>
                  </div>
                  <p>Normalize institution names before a college-based quota can be trusted.</p>
                  <div className="wizard-alias-fields">
                    <Field label="Canonical college">
                      <TextInput
                        value={aliasDraft.canonical}
                        onChange={(event) =>
                          setAliasDraft((current) => ({
                            ...current,
                            canonical: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field label="Aliases" hint="Comma-separated names">
                      <TextInput
                        value={aliasDraft.aliases}
                        onChange={(event) =>
                          setAliasDraft((current) => ({
                            ...current,
                            aliases: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                  <ActionButton
                    tone="secondary"
                    disabled={!aliasDraft.canonical.trim() || !aliasDraft.aliases.trim()}
                    onClick={addAlias}
                  >
                    Add alias mapping
                  </ActionButton>
                  {Object.entries(collegeAliases).length ? (
                    <div className="draft-item-list">
                      {Object.entries(collegeAliases).map(([canonical, aliases]) => (
                        <div key={canonical}>
                          <span>
                            <strong>{canonical}</strong>
                            <small>{aliases.join(" · ")}</small>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setCollegeAliases((current) => {
                                const next = { ...current };
                                delete next[canonical];
                                return next;
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="rule-explainer">
                    <span>VISIBILITY · DRAFT</span>
                    <p>
                      New events stay private until you review the public page and publish them.
                    </p>
                  </div>
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
  const navigate = useNavigate();
  const [step, setStep] = useState(quickId ? 1 : 0);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState("");
  const [minimumTeamSize, setMinimumTeamSize] = useState(1);
  const [maximumTeamSize, setMaximumTeamSize] = useState(4);
  const [capacity, setCapacity] = useState(100);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [activeQuickId, setActiveQuickId] = useState(quickId ?? null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState<QuickMapping>({});
  const [requirements, setRequirements] = useState<RequirementDraft[]>([]);
  const [requirementSkill, setRequirementSkill] = useState("");
  const status = useQuery({
    queryKey: ["quick-import", activeQuickId],
    queryFn: () => getQuickImport(activeQuickId ?? ""),
    enabled: Boolean(activeQuickId),
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === "profiling" ? 3_000 : false),
  });

  useEffect(() => {
    if (!status.data) return;
    setName(status.data.name);
    setHeaders(status.data.headers);
    setRowCount(status.data.rowCount);
    if (Object.keys(mapping).length === 0) {
      setMapping(status.data.mapping ?? status.data.suggestedMapping);
    }
    if (status.data.status === "profiling" || status.data.status === "ready") setStep(3);
  }, [mapping, status.data]);

  const prepareImport = useMutation({
    mutationFn: async () => {
      if (!csvFile) throw new Error("Choose a CSV file");
      if (requirements.length === 0) throw new Error("Add at least one scoring requirement");
      const quick = await createQuickImport({
        name,
        teamSize: { min: minimumTeamSize, max: maximumTeamSize },
        capacity,
        requirements: requirements.map(({ skill, target, weight }) => ({
          skill,
          target,
          weight,
          coverage: { mode: "any_member" },
        })),
      });
      const inspection = await uploadQuickCsv(quick.id, csvFile);
      if (archiveFile) await uploadQuickArchive(quick.id, archiveFile);
      return { quick, inspection };
    },
    onSuccess: ({ quick, inspection }) => {
      setActiveQuickId(quick.id);
      setHeaders(inspection.headers);
      setRowCount(inspection.rowCount);
      setMapping(inspection.suggestedMapping);
      setStep(1);
      navigate(`/organizer/quick/${quick.id}/import`, { replace: true });
    },
  });
  const startImport = useMutation({
    mutationFn: () => {
      if (!activeQuickId) throw new Error("Quick import is not prepared");
      return startQuickImport(activeQuickId, mapping);
    },
    onSuccess: () => {
      setStep(3);
      void status.refetch();
    },
  });

  const addRequirement = () => {
    if (
      !requirementSkill ||
      requirements.some((requirement) => requirement.skill === requirementSkill)
    )
      return;
    setRequirements((current) => [
      ...current,
      { id: Date.now(), skill: requirementSkill, target: 3, weight: 3 },
    ]);
    setRequirementSkill("");
  };
  const updateRequirement = (id: number, field: "target" | "weight", value: number) => {
    setRequirements((current) =>
      current.map((requirement) =>
        requirement.id === id ? { ...requirement, [field]: value } : requirement,
      ),
    );
  };
  const requiredMappingReady = Boolean(mapping.name && mapping.email);
  const stepReady = [
    name.trim().length >= 3 &&
      minimumTeamSize <= maximumTeamSize &&
      capacity > 0 &&
      csvFile &&
      requirements.length > 0,
    requiredMappingReady,
    consent,
    status.data?.status === "ready",
  ];

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
            <div className="quick-upload-step">
              <div className="form-grid">
                <Field label="Workspace name" className="full-field">
                  <TextInput
                    value={name}
                    maxLength={80}
                    placeholder="e.g. Winter hackathon registrations"
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
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
                <Field label="Participant capacity" className="full-field">
                  <TextInput
                    type="number"
                    min="1"
                    max="5000"
                    value={capacity}
                    onChange={(event) => setCapacity(Number(event.target.value))}
                  />
                </Field>
              </div>
              <div className="upload-pair">
                <div className="upload-zone">
                  <span aria-hidden="true">CSV</span>
                  <h3>{csvFile?.name ?? "Registration responses"}</h3>
                  <p>UTF-8 CSV with a header row, up to 2,000 records.</p>
                  <input
                    id="quick-csv"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(event) => setCsvFile(event.target.files?.[0] ?? null)}
                  />
                  <label className="btn terminal-action action-secondary" htmlFor="quick-csv">
                    [ Choose CSV ]
                  </label>
                </div>
                <div className="upload-zone optional">
                  <span aria-hidden="true">ZIP</span>
                  <h3>{archiveFile?.name ?? "CV archive"}</h3>
                  <p>
                    Optional ZIP of PDFs, up to 200 MB. Useful for private Google Forms uploads.
                  </p>
                  <input
                    id="quick-zip"
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(event) => setArchiveFile(event.target.files?.[0] ?? null)}
                  />
                  <label className="btn terminal-action action-secondary" htmlFor="quick-zip">
                    [ Choose ZIP ]
                  </label>
                </div>
              </div>
              <div className="requirements-builder quick-requirements">
                <div className="requirement-adder">
                  <Field label="Scoring requirement">
                    <SelectInput
                      value={requirementSkill}
                      onChange={(event) => setRequirementSkill(event.target.value)}
                    >
                      <option value="">Select a domain or technology</option>
                      {technologyOptions.map((option) => (
                        <option value={option.id} key={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <ActionButton disabled={!requirementSkill} onClick={addRequirement}>
                    Add requirement
                  </ActionButton>
                </div>
                {requirements.length ? (
                  <div className="requirement-editor">
                    {requirements.map((requirement) => (
                      <div className="requirement-edit-row" key={requirement.id}>
                        <strong>
                          {taxonomy.technologies[requirement.skill]?.label ??
                            taxonomy.domains[requirement.skill]?.label ??
                            requirement.skill}
                        </strong>
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
                              current.filter((candidate) => candidate.id !== requirement.id),
                            )
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy">
                    Add at least one capability the teams will be ranked against.
                  </p>
                )}
              </div>
            </div>
          ) : null}
          {step === 1 ? (
            <div>
              <div className="context-notice compact">
                <span aria-hidden="true">i</span>
                <p>
                  Column headers are detected after a CSV is selected. Confirm every required
                  mapping before import. {rowCount} rows were parsed from the uploaded file.
                </p>
              </div>
              <div className="mapping-table">
                <div>
                  <span>TALENTRADAR FIELD</span>
                  <span>CSV COLUMN</span>
                  <span>REQUIRED</span>
                </div>
                {quickMappingFields.map((field) => (
                  <div key={field.key}>
                    <strong>{field.label}</strong>
                    <SelectInput
                      aria-label={`${field.label} column`}
                      value={mapping[field.key] ?? ""}
                      onChange={(event) =>
                        setMapping((current) => ({
                          ...current,
                          [field.key]: event.target.value || undefined,
                        }))
                      }
                    >
                      <option value="">Not mapped</option>
                      {headers.map((header) => (
                        <option value={header} key={header}>
                          {header}
                        </option>
                      ))}
                    </SelectInput>
                    <Badge tone={field.required ? "warning" : "neutral"}>
                      {field.required ? "Yes" : "No"}
                    </Badge>
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
            <div className="quick-progress">
              <div className="metric-strip">
                <div>
                  <span>TOTAL</span>
                  <strong>{status.data?.progress.total ?? 0}</strong>
                  <small>Profiles created</small>
                </div>
                <div>
                  <span>READY</span>
                  <strong>{status.data?.progress.ready ?? 0}</strong>
                  <small>Evidence complete</small>
                </div>
                <div>
                  <span>PROCESSING</span>
                  <strong>{status.data?.progress.pending ?? 0}</strong>
                  <small>Queued or running</small>
                </div>
                <div>
                  <span>FAILED</span>
                  <strong>{status.data?.progress.failed ?? 0}</strong>
                  <small>Needs review</small>
                </div>
              </div>
              <ProgressBar
                label="Profile completion"
                value={
                  status.data?.progress.total
                    ? ((status.data.progress.ready + status.data.progress.failed) /
                        status.data.progress.total) *
                      100
                    : 0
                }
              />
              {status.data?.recentEvents.length ? (
                <div className="mockup-code real-build-log">
                  {status.data.recentEvents.map((event, index) => (
                    <pre
                      data-prefix={String(index + 1).padStart(2, "0")}
                      key={`${event.at}-${event.message}`}
                    >
                      <code>{event.message}</code>
                    </pre>
                  ))}
                </div>
              ) : (
                <p className="muted-copy">No worker events have been persisted yet.</p>
              )}
              {status.data?.failures.length ? (
                <div className="quick-failures">
                  {status.data.failures.map((failure) => (
                    <p key={failure.personId}>
                      <strong>{failure.name}</strong>
                      <span>{failure.error}</span>
                    </p>
                  ))}
                </div>
              ) : null}
              {status.data?.status === "ready" && activeQuickId ? (
                <ActionLink to={`/organizer/events/${activeQuickId}/shortlist`}>
                  Open ranked shortlist
                </ActionLink>
              ) : null}
            </div>
          ) : null}
          <div className="wizard-actions">
            <ActionButton
              tone="quiet"
              disabled={step === 0 || step === 3}
              onClick={() => setStep((value) => Math.max(0, value - 1))}
            >
              Back
            </ActionButton>
            {step === 0 ? (
              <ActionButton
                disabled={!stepReady[0] || prepareImport.isPending}
                onClick={() => prepareImport.mutate()}
              >
                {prepareImport.isPending ? "Uploading…" : "Upload and inspect"}
              </ActionButton>
            ) : null}
            {step === 1 ? (
              <ActionButton disabled={!stepReady[1]} onClick={() => setStep(2)}>
                Confirm mapping
              </ActionButton>
            ) : null}
            {step === 2 ? (
              <ActionButton
                disabled={!stepReady[2] || startImport.isPending}
                onClick={() => startImport.mutate()}
              >
                {startImport.isPending ? "Starting…" : "Start profiling"}
              </ActionButton>
            ) : null}
          </div>
          {prepareImport.isError || startImport.isError || status.isError ? (
            <div className="error-state" role="alert">
              {(prepareImport.error ?? startImport.error ?? status.error)?.message}
            </div>
          ) : null}
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

export function EventOverviewPage() {
  const { eventId } = useParams();
  const queryClient = useQueryClient();
  const event = useQuery({
    queryKey: ["organizer-event", eventId],
    queryFn: () => getOrganizerEvent(eventId ?? ""),
    enabled: Boolean(eventId),
    retry: false,
  });
  const operations = useQuery({
    queryKey: ["organizer-event-operations", eventId],
    queryFn: () => getOrganizerEventOperations(eventId ?? ""),
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
          {operations.data?.participants.length ? (
            <div className="event-activity-list">
              {operations.data.participants.slice(0, 8).map((participant) => (
                <div key={participant.registrationId}>
                  <span>{participant.profileStatus === "ready" ? "✓" : "~"}</span>
                  <div>
                    <strong>{participant.name}</strong>
                    <small>
                      @{participant.github} · {participant.teamId ? "team formed" : "no team"}
                    </small>
                  </div>
                  <Badge tone={participant.profileStatus === "ready" ? "success" : "neutral"}>
                    {participant.profileStatus}
                  </Badge>
                  <time>{new Date(participant.updatedAt).toLocaleString()}</time>
                </div>
              ))}
              <ActionLink to={`/organizer/events/${eventId}/participants`} tone="secondary">
                Open all participants
              </ActionLink>
            </div>
          ) : operations.isPending ? (
            <div className="loading-state">Loading registration activity…</div>
          ) : (
            <EmptyState title="No registrations yet">
              Applications will appear here after participants start through the published event
              page.
            </EmptyState>
          )}
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
  const { eventId } = useParams();
  const queryClient = useQueryClient();
  const [configuration, setConfiguration] = useState<EventConfigurationInput | null>(null);
  const [newSkill, setNewSkill] = useState("");
  const [quotaDraft, setQuotaDraft] = useState<{
    attribute: QuotaRule["attribute"];
    op: QuotaRule["op"];
    value: string;
    minShare: number;
    unit: QuotaRule["unit"];
    match: QuotaRule["match"];
  }>({
    attribute: "college",
    op: "equals",
    value: "",
    minShare: 0.1,
    unit: "teams",
    match: "all",
  });
  const [aliasName, setAliasName] = useState("");
  const [aliasValues, setAliasValues] = useState("");
  const event = useQuery({
    queryKey: ["organizer-event", eventId],
    queryFn: () => getOrganizerEvent(eventId ?? ""),
    enabled: Boolean(eventId),
    retry: false,
  });
  const operations = useQuery({
    queryKey: ["organizer-event-operations", eventId],
    queryFn: () => getOrganizerEventOperations(eventId ?? ""),
    enabled: Boolean(eventId) && (section === "participants" || section === "teams"),
    retry: false,
  });

  useEffect(() => {
    if (!event.data?.timeline) return;
    setConfiguration({
      name: event.data.name,
      tagline: event.data.tagline,
      description: event.data.description,
      links: event.data.links,
      mode: event.data.mode,
      ...(event.data.venue ? { venue: event.data.venue } : {}),
      timeline: event.data.timeline,
      teamSize: event.data.teamSize,
      capacity: event.data.capacity,
      requirements: event.data.requirements,
      quotas: event.data.quotas,
      collegeAliases: event.data.collegeAliases,
    });
  }, [event.data]);

  const saveConfiguration = useMutation({
    mutationFn: () => {
      if (!eventId || !configuration) throw new Error("Event configuration is not loaded");
      return updateOrganizerEventConfiguration(eventId, configuration);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organizer-event", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-events"] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-shortlist", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["public-events"] }),
      ]);
    },
  });

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

  const updateRequirement = (skill: string, field: "target" | "weight", value: number) => {
    setConfiguration((current) =>
      current
        ? {
            ...current,
            requirements: current.requirements.map((requirement) =>
              requirement.skill === skill ? { ...requirement, [field]: value } : requirement,
            ),
          }
        : current,
    );
  };
  const addRequirement = () => {
    if (!newSkill) return;
    setConfiguration((current) =>
      current && !current.requirements.some((requirement) => requirement.skill === newSkill)
        ? {
            ...current,
            requirements: [
              ...current.requirements,
              { skill: newSkill, target: 3, weight: 3, coverage: { mode: "any_member" } },
            ],
          }
        : current,
    );
    setNewSkill("");
  };
  const addQuota = () => {
    if (!quotaDraft.value.trim()) return;
    const listOperator = quotaDraft.op === "in" || quotaDraft.op === "not_in";
    const value = listOperator
      ? quotaDraft.value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : quotaDraft.value.trim();
    setConfiguration((current) =>
      current
        ? {
            ...current,
            quotas: [
              ...current.quotas,
              {
                attribute: quotaDraft.attribute,
                op: quotaDraft.op,
                value,
                minShare: quotaDraft.minShare,
                unit: quotaDraft.unit,
                match: quotaDraft.match,
              },
            ],
          }
        : current,
    );
    setQuotaDraft((current) => ({ ...current, value: "" }));
  };
  const addAlias = () => {
    const canonical = aliasName.trim();
    const aliases = aliasValues
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!canonical || aliases.length === 0) return;
    setConfiguration((current) =>
      current
        ? {
            ...current,
            collegeAliases: { ...current.collegeAliases, [canonical]: aliases },
          }
        : current,
    );
    setAliasName("");
    setAliasValues("");
  };

  if (
    event.isPending ||
    (operations.isPending && (section === "participants" || section === "teams"))
  ) {
    return <div className="loading-state">Loading event operations…</div>;
  }
  if (event.isError || operations.isError) {
    return (
      <div className="portal-page">
        <EmptyState
          title="Event data unavailable"
          action={<ActionLink to="/organizer">Back to events</ActionLink>}
        >
          {(event.error ?? operations.error)?.message}
        </EmptyState>
      </div>
    );
  }

  const participants = operations.data?.participants ?? [];
  const teams = operations.data?.teams ?? [];
  const lookingForTeam = participants.filter((participant) => participant.lookingForTeam);

  return (
    <div className="portal-page">
      <PageHeading
        eyebrow={`ORGANIZER / ${section.toUpperCase()}`}
        title={copyTitle}
        description={copyDescription}
        action={
          section === "requirements" || section === "settings" ? (
            <ActionButton
              disabled={!configuration || saveConfiguration.isPending}
              onClick={() => saveConfiguration.mutate()}
            >
              {saveConfiguration.isPending ? "Saving…" : "Save changes"}
            </ActionButton>
          ) : undefined
        }
      />
      {saveConfiguration.isError ? (
        <div className="error-state" role="alert">
          {saveConfiguration.error.message}
        </div>
      ) : null}
      {saveConfiguration.isSuccess ? (
        <div className="context-notice compact" role="status">
          <span aria-hidden="true">✓</span>
          <p>Event configuration saved.</p>
        </div>
      ) : null}

      {section === "requirements" && configuration ? (
        <div className="event-config-layout">
          <Panel label="01 / SCORING" title="Required skills" className="span-two">
            <div className="requirement-adder">
              <Field label="Taxonomy skill">
                <SelectInput
                  value={newSkill}
                  onChange={(change) => setNewSkill(change.target.value)}
                >
                  <option value="">Select a domain or technology</option>
                  {technologyOptions.map((option) => (
                    <option value={option.id} key={option.id}>
                      {option.label}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <ActionButton disabled={!newSkill} onClick={addRequirement}>
                Add skill
              </ActionButton>
            </div>
            <div className="requirement-editor event-requirement-editor">
              <div className="requirement-head">
                <span>SKILL</span>
                <span>TARGET</span>
                <span>WEIGHT</span>
                <span />
              </div>
              {configuration.requirements.map((requirement) => (
                <div className="requirement-edit-row" key={requirement.skill}>
                  <strong>
                    {taxonomy.technologies[requirement.skill]?.label ??
                      taxonomy.domains[requirement.skill]?.label ??
                      requirement.skill}
                  </strong>
                  <label>
                    <span>{requirement.target.toFixed(1)}</span>
                    <input
                      type="range"
                      min="1"
                      max="5"
                      step="0.5"
                      value={requirement.target}
                      onChange={(change) =>
                        updateRequirement(requirement.skill, "target", Number(change.target.value))
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
                      onChange={(change) =>
                        updateRequirement(requirement.skill, "weight", Number(change.target.value))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={configuration.requirements.length === 1}
                    onClick={() =>
                      setConfiguration((current) =>
                        current
                          ? {
                              ...current,
                              requirements: current.requirements.filter(
                                (candidate) => candidate.skill !== requirement.skill,
                              ),
                            }
                          : current,
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </Panel>
          <Panel label="02 / QUOTAS" title="Structured share rules">
            <div className="quota-builder">
              <Field label="Attribute">
                <SelectInput
                  value={quotaDraft.attribute}
                  onChange={(change) =>
                    setQuotaDraft((current) => ({
                      ...current,
                      attribute: change.target.value as QuotaRule["attribute"],
                    }))
                  }
                >
                  <option value="college">College</option>
                  <option value="year_of_study">Year of study</option>
                  <option value="branch">Branch</option>
                  <option value="city">City</option>
                </SelectInput>
              </Field>
              <Field label="Operator">
                <SelectInput
                  value={quotaDraft.op}
                  onChange={(change) =>
                    setQuotaDraft((current) => ({
                      ...current,
                      op: change.target.value as QuotaRule["op"],
                    }))
                  }
                >
                  <option value="equals">Equals</option>
                  <option value="not_equals">Does not equal</option>
                  <option value="in">In list</option>
                  <option value="not_in">Not in list</option>
                </SelectInput>
              </Field>
              <Field label="Value" hint="Separate list values with commas.">
                <TextInput
                  value={quotaDraft.value}
                  onChange={(change) =>
                    setQuotaDraft((current) => ({ ...current, value: change.target.value }))
                  }
                />
              </Field>
              <Field label="Minimum share">
                <TextInput
                  type="number"
                  min="0.01"
                  max="1"
                  step="0.01"
                  value={quotaDraft.minShare}
                  onChange={(change) =>
                    setQuotaDraft((current) => ({
                      ...current,
                      minShare: Number(change.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="Unit">
                <SelectInput
                  value={quotaDraft.unit}
                  onChange={(change) =>
                    setQuotaDraft((current) => ({
                      ...current,
                      unit: change.target.value as QuotaRule["unit"],
                    }))
                  }
                >
                  <option value="teams">Teams</option>
                  <option value="participants">Participants</option>
                </SelectInput>
              </Field>
              <Field label="Team match">
                <SelectInput
                  value={quotaDraft.match}
                  disabled={quotaDraft.unit === "participants"}
                  onChange={(change) =>
                    setQuotaDraft((current) => ({
                      ...current,
                      match: change.target.value as QuotaRule["match"],
                    }))
                  }
                >
                  <option value="all">All members</option>
                  <option value="majority">Majority</option>
                  <option value="any">Any member</option>
                </SelectInput>
              </Field>
              <ActionButton disabled={!quotaDraft.value.trim()} onClick={addQuota}>
                Add quota
              </ActionButton>
            </div>
            <div className="configured-rules">
              {configuration.quotas.map((quota) => (
                <div key={JSON.stringify(quota)}>
                  <p>
                    {quota.attribute.replaceAll("_", " ")} {quota.op.replaceAll("_", " ")}{" "}
                    {Array.isArray(quota.value) ? quota.value.join(", ") : quota.value}
                  </p>
                  <small>
                    {Math.round(quota.minShare * 100)}% of {quota.unit}
                    {quota.unit === "teams" ? ` · ${quota.match}` : ""}
                  </small>
                  <button
                    type="button"
                    onClick={() =>
                      setConfiguration((current) =>
                        current
                          ? {
                              ...current,
                              quotas: current.quotas.filter((candidate) => candidate !== quota),
                            }
                          : current,
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              {configuration.quotas.length === 0 ? (
                <p className="muted-copy">No quotas. Capacity fills strictly by score order.</p>
              ) : null}
            </div>
          </Panel>
          <Panel label="03 / NORMALIZATION" title="College aliases">
            <div className="alias-builder">
              <Field label="Canonical college">
                <TextInput
                  value={aliasName}
                  onChange={(change) => setAliasName(change.target.value)}
                />
              </Field>
              <Field label="Aliases" hint="Comma-separated names from registration data.">
                <TextInput
                  value={aliasValues}
                  onChange={(change) => setAliasValues(change.target.value)}
                />
              </Field>
              <ActionButton disabled={!aliasName.trim() || !aliasValues.trim()} onClick={addAlias}>
                Add mapping
              </ActionButton>
            </div>
            <div className="configured-rules aliases-list">
              {Object.entries(configuration.collegeAliases).map(([canonical, aliases]) => (
                <div key={canonical}>
                  <p>{canonical}</p>
                  <small>{aliases.join(" · ")}</small>
                  <button
                    type="button"
                    onClick={() =>
                      setConfiguration((current) => {
                        if (!current) return current;
                        const next = { ...current.collegeAliases };
                        delete next[canonical];
                        return { ...current, collegeAliases: next };
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}

      {section === "participants" ? (
        <>
          <div className="metric-strip">
            <div>
              <span>REGISTERED</span>
              <strong>{participants.length}</strong>
              <small>Application records</small>
            </div>
            <div>
              <span>PROFILES READY</span>
              <strong>
                {participants.filter((person) => person.profileStatus === "ready").length}
              </strong>
              <small>Evidence profiles complete</small>
            </div>
            <div>
              <span>TEAMLESS</span>
              <strong>{participants.filter((person) => !person.teamId).length}</strong>
              <small>No current roster</small>
            </div>
            <div>
              <span>LOOKING</span>
              <strong>{lookingForTeam.length}</strong>
              <small>Visible in teammate pool</small>
            </div>
          </div>
          <Panel
            label="EVENT / PARTICIPANTS"
            title={event.data?.name ?? "Participants"}
            className="operations-panel"
          >
            {participants.length ? (
              <div className="operations-table participants-operations-table">
                <div className="operations-row operations-head">
                  <span>PARTICIPANT</span>
                  <span>IDENTITY</span>
                  <span>COLLEGE</span>
                  <span>PROFILE</span>
                  <span>APPLICATION</span>
                </div>
                {participants.map((participant) => (
                  <div className="operations-row" key={participant.registrationId}>
                    <span>
                      <strong>{participant.name}</strong>
                      <small>@{participant.github}</small>
                    </span>
                    <Badge tone={participant.verified ? "success" : "warning"}>
                      {participant.verified ? "verified" : "unverified"}
                    </Badge>
                    <span>{participant.college ?? "Not provided"}</span>
                    <Badge tone={participant.profileStatus === "ready" ? "success" : "neutral"}>
                      {participant.profileStatus}
                    </Badge>
                    <Badge tone={participant.status === "selected" ? "success" : "neutral"}>
                      {participant.status.replace("_", " ")}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="No registrations yet">
                Participants appear here only after starting the published event application.
              </EmptyState>
            )}
          </Panel>
        </>
      ) : null}

      {section === "teams" ? (
        <div className="event-config-layout">
          <Panel label="01 / ROSTERS" title={`${teams.length} event teams`} className="span-two">
            {teams.length ? (
              <div className="organizer-team-list">
                {teams.map((team) => (
                  <article key={team.id}>
                    <header>
                      <div>
                        <strong>{team.name}</strong>
                        <small>
                          {team.members.length} member{team.members.length === 1 ? "" : "s"}
                        </small>
                      </div>
                      <Badge
                        tone={
                          team.status === "submitted" || team.status === "locked"
                            ? "success"
                            : "neutral"
                        }
                      >
                        {team.status}
                      </Badge>
                    </header>
                    <div>
                      {team.members.map((member) => (
                        <p key={member.id}>
                          <span>{member.name}</span>
                          <small>@{member.github}</small>
                          <Badge tone={member.profileStatus === "ready" ? "success" : "warning"}>
                            {member.profileStatus}
                          </Badge>
                        </p>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState title="No teams formed">
                Created and joined rosters appear here without generated examples.
              </EmptyState>
            )}
          </Panel>
          <Panel label="02 / DISCOVERY" title="Looking for a team">
            {lookingForTeam.length ? (
              <div className="looking-pool-list">
                {lookingForTeam.map((participant) => (
                  <article key={participant.personId}>
                    <strong>{participant.name}</strong>
                    <span>{participant.college ?? "College not provided"}</span>
                    <small>
                      {participant.topSkills.length
                        ? participant.topSkills
                            .map(
                              (skill) =>
                                taxonomy.technologies[skill]?.label ??
                                taxonomy.domains[skill]?.label ??
                                skill,
                            )
                            .join(" · ")
                        : "Profile skills pending"}
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState title="Nobody is listed">
                Applicants can opt into this event-specific pool from their team page.
              </EmptyState>
            )}
          </Panel>
        </div>
      ) : null}

      {section === "settings" && configuration ? (
        <div className="event-config-layout settings-layout">
          <Panel label="01 / PUBLIC PAGE" title="Event identity" className="span-two">
            <div className="form-grid">
              <Field label="Event name">
                <TextInput
                  value={configuration.name}
                  onChange={(change) =>
                    setConfiguration((current) =>
                      current ? { ...current, name: change.target.value } : current,
                    )
                  }
                />
              </Field>
              <Field label="Tagline">
                <TextInput
                  value={configuration.tagline}
                  maxLength={140}
                  onChange={(change) =>
                    setConfiguration((current) =>
                      current ? { ...current, tagline: change.target.value } : current,
                    )
                  }
                />
              </Field>
              <Field label="Description" className="full-field">
                <TextArea
                  value={configuration.description}
                  rows={8}
                  onChange={(change) =>
                    setConfiguration((current) =>
                      current ? { ...current, description: change.target.value } : current,
                    )
                  }
                />
              </Field>
              <Field label="Mode">
                <SelectInput
                  value={configuration.mode}
                  onChange={(change) =>
                    setConfiguration((current) =>
                      current
                        ? {
                            ...current,
                            mode: change.target.value as EventConfigurationInput["mode"],
                          }
                        : current,
                    )
                  }
                >
                  <option value="in_person">In person</option>
                  <option value="online">Online</option>
                  <option value="hybrid">Hybrid</option>
                </SelectInput>
              </Field>
              <Field label="Venue" hint="Required unless the event is online.">
                <TextInput
                  value={configuration.venue ?? ""}
                  onChange={(change) =>
                    setConfiguration((current) =>
                      current ? { ...current, venue: change.target.value } : current,
                    )
                  }
                />
              </Field>
            </div>
          </Panel>
          <Panel label="02 / TEAM RULES" title="Seats and roster size">
            <div className="form-grid compact-form-grid">
              <Field label="Minimum members">
                <TextInput
                  type="number"
                  min="1"
                  max="6"
                  value={configuration.teamSize.min}
                  onChange={(change) =>
                    setConfiguration((current) =>
                      current
                        ? {
                            ...current,
                            teamSize: { ...current.teamSize, min: Number(change.target.value) },
                          }
                        : current,
                    )
                  }
                />
              </Field>
              <Field label="Maximum members">
                <TextInput
                  type="number"
                  min="1"
                  max="6"
                  value={configuration.teamSize.max}
                  onChange={(change) =>
                    setConfiguration((current) =>
                      current
                        ? {
                            ...current,
                            teamSize: { ...current.teamSize, max: Number(change.target.value) },
                          }
                        : current,
                    )
                  }
                />
              </Field>
              <Field label="Participant capacity" className="full-field">
                <TextInput
                  type="number"
                  min="1"
                  max="5000"
                  value={configuration.capacity}
                  onChange={(change) =>
                    setConfiguration((current) =>
                      current ? { ...current, capacity: Number(change.target.value) } : current,
                    )
                  }
                />
              </Field>
            </div>
          </Panel>
          <Panel label="03 / TIMELINE" title="IST milestones" className="span-two">
            <div className="timeline-grid">
              {(
                [
                  ["registrationOpensAt", "Registration opens"],
                  ["registrationClosesAt", "Registration closes"],
                  ["shortlistPublishesAt", "Shortlist publishes"],
                  ["rsvpDeadlineAt", "RSVP deadline"],
                  ["eventStartsAt", "Event starts"],
                  ["eventEndsAt", "Event ends"],
                ] as const
              ).map(([key, label]) => (
                <Field label={label} key={key}>
                  <TextInput
                    type="datetime-local"
                    value={isoToIstDateTime(configuration.timeline[key])}
                    onChange={(change) =>
                      setConfiguration((current) =>
                        current
                          ? {
                              ...current,
                              timeline: {
                                ...current.timeline,
                                [key]: istDateTimeToIso(change.target.value),
                              },
                            }
                          : current,
                      )
                    }
                  />
                </Field>
              ))}
            </div>
          </Panel>
          <Panel label="04 / LINKS" title="Public resources">
            <div className="settings-link-list">
              {configuration.links.map((link, index) => (
                <div key={`${link.label}-${link.url}`}>
                  <TextInput
                    aria-label={`Link ${index + 1} label`}
                    value={link.label}
                    onChange={(change) =>
                      setConfiguration((current) =>
                        current
                          ? {
                              ...current,
                              links: current.links.map((candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? { ...candidate, label: change.target.value }
                                  : candidate,
                              ),
                            }
                          : current,
                      )
                    }
                  />
                  <TextInput
                    aria-label={`Link ${index + 1} URL`}
                    value={link.url}
                    onChange={(change) =>
                      setConfiguration((current) =>
                        current
                          ? {
                              ...current,
                              links: current.links.map((candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? { ...candidate, url: change.target.value }
                                  : candidate,
                              ),
                            }
                          : current,
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setConfiguration((current) =>
                        current
                          ? {
                              ...current,
                              links: current.links.filter(
                                (_, candidateIndex) => candidateIndex !== index,
                              ),
                            }
                          : current,
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <ActionButton
                tone="secondary"
                disabled={configuration.links.length >= 12}
                onClick={() =>
                  setConfiguration((current) =>
                    current
                      ? {
                          ...current,
                          links: [...current.links, { label: "", url: "https://" }],
                        }
                      : current,
                  )
                }
              >
                Add link
              </ActionButton>
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

export function ShortlistWorkspacePage() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [alpha, setAlpha] = useState(0.7);
  const [novelty, setNovelty] = useState(10);
  const [minFit, setMinFit] = useState(0);
  const [capacity, setCapacity] = useState(100);
  const [waitlist, setWaitlist] = useState(10);
  const [confidenceFactors, setConfidenceFactors] = useState({
    high: 1,
    medium: 0.85,
    low: 0.6,
  });
  const [requirements, setRequirements] = useState<RankingParams["requirements"]>([]);
  const [overrides, setOverrides] = useState<SelectionOverride[]>([]);
  const [overrideReason, setOverrideReason] = useState("");
  const [runName, setRunName] = useState("Run 1");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"parameters" | "results" | "inspector">("results");
  const panes = useMemo(() => ["parameters", "results", "inspector"] as const, []);
  const shortlist = useQuery({
    queryKey: ["organizer-shortlist", eventId],
    queryFn: () => getOrganizerShortlist(eventId ?? ""),
    enabled: Boolean(eventId),
    retry: false,
  });

  useEffect(() => {
    if (!shortlist.data) return;
    const { ranking } = shortlist.data.event;
    setAlpha(ranking.alpha);
    setNovelty(ranking.noveltyWeight);
    setMinFit(ranking.minFit);
    setConfidenceFactors(ranking.confidenceFactors);
    setRequirements(ranking.requirements);
    setCapacity(shortlist.data.event.capacity);
    setWaitlist(Math.min(500, Math.ceil(shortlist.data.teams.length * 0.2)));
    setRunName(`Run ${shortlist.data.runs.length + 1}`);
  }, [shortlist.data]);

  const rankingParams = useMemo<RankingParams | null>(() => {
    const defaults = shortlist.data?.event.ranking;
    if (!defaults || requirements.length === 0) return null;
    return {
      ...defaults,
      requirements,
      alpha,
      noveltyWeight: novelty,
      confidenceFactors,
      minFit,
    };
  }, [alpha, confidenceFactors, minFit, novelty, requirements, shortlist.data]);

  const decision = useMemo(() => {
    if (!shortlist.data || !rankingParams) return null;
    const ranked = rank(shortlist.data.profiles, shortlist.data.rankingTeams, rankingParams);
    return selectShortlist(ranked, shortlist.data.teams, {
      capacity,
      waitlistSize: waitlist,
      quotas: shortlist.data.event.quotas,
      overrides,
    });
  }, [capacity, overrides, rankingParams, shortlist.data, waitlist]);

  useEffect(() => {
    if (!decision?.results.length) {
      setSelectedTeamId(null);
      return;
    }
    if (!decision.results.some((result) => result.teamId === selectedTeamId)) {
      setSelectedTeamId(decision.results[0]?.teamId ?? null);
    }
  }, [decision, selectedTeamId]);

  const saveRun = useMutation({
    mutationFn: () => {
      if (!eventId || !rankingParams) throw new Error("Shortlist parameters are not loaded");
      return saveOrganizerShortlistRun(eventId, {
        name: runName,
        params: rankingParams,
        selection: {
          capacity,
          waitlistSize: waitlist,
          quotas: shortlist.data?.event.quotas ?? [],
          overrides,
        },
      });
    },
    onSuccess: async (run) => {
      setActiveRunId(run.id);
      setRunName(`Run ${(shortlist.data?.runs.length ?? 0) + 2}`);
      await queryClient.invalidateQueries({ queryKey: ["organizer-shortlist", eventId] });
    },
  });
  const publishRun = useMutation({
    mutationFn: () => {
      if (!eventId || !activeRunId) throw new Error("Save a shortlist run before publishing");
      return publishOrganizerShortlistRun(eventId, activeRunId);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organizer-shortlist", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-event", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-events"] }),
      ]);
    },
  });

  const selectedResult = decision?.results.find((result) => result.teamId === selectedTeamId);
  const selectedTeam = shortlist.data?.teams.find((team) => team.teamId === selectedTeamId);
  const selectedOverride = overrides.find((override) => override.teamId === selectedTeamId);
  const activeRun = shortlist.data?.runs.find((run) => run.id === activeRunId);
  const selectedCount =
    decision?.results.filter((result) => result.status === "selected").length ?? 0;

  const setRequirement = (skill: string, field: "target" | "weight", value: number) => {
    setRequirements((current) =>
      current.map((requirement) =>
        requirement.skill === skill ? { ...requirement, [field]: value } : requirement,
      ),
    );
  };
  const addOverride = (action: SelectionOverride["action"]) => {
    if (!selectedTeamId || overrideReason.trim().length < 3) return;
    setOverrides((current) => [
      ...current.filter((override) => override.teamId !== selectedTeamId),
      { teamId: selectedTeamId, action, reason: overrideReason.trim() },
    ]);
    setOverrideReason("");
  };

  if (shortlist.isPending) return <div className="loading-state">Loading shortlist workspace…</div>;
  if (shortlist.isError) {
    return (
      <div className="portal-page">
        <EmptyState
          title="Shortlist unavailable"
          action={<ActionLink to={`/organizer/events/${eventId}`}>Back to event</ActionLink>}
        >
          {shortlist.error.message}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="shortlist-page">
      <header className="shortlist-heading">
        <div>
          <p>ORGANIZER / SHORTLIST</p>
          <h1>Decision workspace</h1>
          <span>{shortlist.data.event.name} · every parameter change re-ranks locally</span>
        </div>
        <div className="shortlist-actions">
          {activeRunId ? (
            <a
              className="btn terminal-action action-secondary"
              href={`/api/organizer/events/${eventId}/shortlist/runs/${activeRunId}.csv`}
            >
              <span aria-hidden="true">[</span>
              <span>Export CSV</span>
              <span aria-hidden="true">]</span>
            </a>
          ) : null}
          <ActionButton
            tone="secondary"
            disabled={!decision?.results.length || saveRun.isPending || runName.trim().length < 2}
            onClick={() => saveRun.mutate()}
          >
            {saveRun.isPending ? "Saving…" : "Save run"}
          </ActionButton>
          <ActionButton
            disabled={!activeRunId || activeRun?.published || publishRun.isPending}
            onClick={() => publishRun.mutate()}
          >
            {activeRun?.published ? "Published" : publishRun.isPending ? "Publishing…" : "Publish"}
          </ActionButton>
        </div>
      </header>
      {saveRun.isError || publishRun.isError ? (
        <div className="shortlist-error" role="alert">
          {(saveRun.error ?? publishRun.error)?.message}
        </div>
      ) : null}
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
                <output>{novelty.toFixed(0)} pts</output>
              </span>
              <input
                type="range"
                min="0"
                max="25"
                step="1"
                value={novelty}
                onChange={(event) => setNovelty(Number(event.target.value))}
              />
              <small>Contribution from the team's strongest original project.</small>
            </label>
            <label className="parameter-control">
              <span>
                <strong>Minimum fit</strong>
                <output>{Math.round(minFit * 100)}%</output>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={minFit}
                onChange={(event) => setMinFit(Number(event.target.value))}
              />
              <small>Teams below this requirement coverage become ineligible.</small>
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
            <Field label="Run name" hint="Saved runs are immutable snapshots.">
              <TextInput
                value={runName}
                maxLength={100}
                onChange={(event) => setRunName(event.target.value)}
              />
            </Field>
            <div className="parameter-section">
              <div>
                <strong>Requirements</strong>
                <ActionLink to={`/organizer/events/${eventId}/requirements`} tone="quiet">
                  Edit
                </ActionLink>
              </div>
              <div className="shortlist-requirements">
                {requirements.map((requirement) => (
                  <article key={requirement.skill}>
                    <div>
                      <strong>
                        {taxonomy.technologies[requirement.skill]?.label ??
                          taxonomy.domains[requirement.skill]?.label ??
                          requirement.skill}
                      </strong>
                      <small>{requirement.coverage.mode.replace("_", " ")}</small>
                    </div>
                    <label>
                      <span>Target {requirement.target.toFixed(1)}</span>
                      <input
                        type="range"
                        min="1"
                        max="5"
                        step="0.5"
                        value={requirement.target}
                        onChange={(event) =>
                          setRequirement(requirement.skill, "target", Number(event.target.value))
                        }
                      />
                    </label>
                    <label>
                      <span>Weight {requirement.weight}</span>
                      <input
                        type="range"
                        min="0"
                        max="5"
                        step="1"
                        value={requirement.weight}
                        onChange={(event) =>
                          setRequirement(requirement.skill, "weight", Number(event.target.value))
                        }
                      />
                    </label>
                  </article>
                ))}
              </div>
            </div>
            <div className="parameter-section">
              <div>
                <strong>Confidence factors</strong>
              </div>
              <dl className="compact-definition-list">
                <div>
                  <dt>High confidence</dt>
                  <dd>
                    <input
                      aria-label="High confidence factor"
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={confidenceFactors.high}
                      onChange={(event) =>
                        setConfidenceFactors((current) => ({
                          ...current,
                          high: Number(event.target.value),
                        }))
                      }
                    />
                  </dd>
                </div>
                <div>
                  <dt>Medium confidence</dt>
                  <dd>
                    <input
                      aria-label="Medium confidence factor"
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={confidenceFactors.medium}
                      onChange={(event) =>
                        setConfidenceFactors((current) => ({
                          ...current,
                          medium: Number(event.target.value),
                        }))
                      }
                    />
                  </dd>
                </div>
                <div>
                  <dt>Low confidence</dt>
                  <dd>
                    <input
                      aria-label="Low confidence factor"
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={confidenceFactors.low}
                      onChange={(event) =>
                        setConfidenceFactors((current) => ({
                          ...current,
                          low: Number(event.target.value),
                        }))
                      }
                    />
                  </dd>
                </div>
              </dl>
            </div>
            {shortlist.data.runs.length > 0 ? (
              <div className="parameter-section saved-runs-list">
                <div>
                  <strong>Saved runs</strong>
                  <span>{shortlist.data.runs.length}</span>
                </div>
                {shortlist.data.runs.map((run) => (
                  <button
                    type="button"
                    className={activeRunId === run.id ? "active" : ""}
                    key={run.id}
                    onClick={() => navigate(`/organizer/events/${eventId}/runs/${run.id}`)}
                  >
                    <span>{run.name}</span>
                    <small>{run.published ? "FINAL" : `${run.selectedSeats} seats`}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </section>
        <section
          className={`shortlist-pane results-pane ${mobilePane === "results" ? "mobile-active" : ""}`}
        >
          <header>
            <span>02 / RANKED TEAMS</span>
            <Badge tone="neutral">{decision?.results.length ?? 0} results</Badge>
          </header>
          {decision?.quotaReports.length ? (
            <div className="quota-report-strip">
              {decision.quotaReports.map((report) => (
                <p className={report.met ? "met" : "unmet"} key={JSON.stringify(report.quota)}>
                  {report.message}
                </p>
              ))}
            </div>
          ) : (
            <div className="unmapped-notice">
              <span>NO QUOTAS</span>
              <p>Selection is score order with participant-seat capacity only.</p>
            </div>
          )}
          {shortlist.data.event.quotas.some((quota) => quota.attribute === "college") &&
          shortlist.data.unmappedColleges.length > 0 ? (
            <div className="unmapped-notice warning" role="alert">
              <span>UNMAPPED COLLEGES</span>
              <p>{shortlist.data.unmappedColleges.join(" · ")}</p>
              <ActionLink to={`/organizer/events/${eventId}/requirements`} tone="quiet">
                Map aliases before trusting this quota
              </ActionLink>
            </div>
          ) : null}
          <div className="shortlist-table">
            <div className="shortlist-table-head">
              <span>RANK / TEAM</span>
              <span>FIT</span>
              <span>DEPTH</span>
              <span>NOVELTY</span>
              <span>SCORE</span>
              <span>STATE</span>
            </div>
            {decision?.results.length ? (
              <div className="shortlist-result-rows">
                {decision.results.map((result) => (
                  <button
                    type="button"
                    className={
                      selectedTeamId === result.teamId
                        ? "shortlist-result selected"
                        : "shortlist-result"
                    }
                    key={result.teamId}
                    onClick={() => {
                      setSelectedTeamId(result.teamId);
                      setMobilePane("inspector");
                    }}
                  >
                    <span>
                      <b>{result.rank ? `#${result.rank}` : "—"}</b>
                      <strong>{result.name}</strong>
                      {result.borderline ? <em>review</em> : null}
                    </span>
                    <span>{Math.round(result.fit * 100)}%</span>
                    <span>{result.depth.toFixed(2)}</span>
                    <span>{result.novelty.toFixed(2)}</span>
                    <span>{result.score.toFixed(1)}</span>
                    <span data-status={result.status}>{result.status.replace("_", " ")}</span>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState title="No submitted teams to rank">
                Teams appear here only after captains submit a valid roster with completed profiles.
              </EmptyState>
            )}
          </div>
          <footer className="results-footer">
            <span>Cutoff {decision?.cutoffScore?.toFixed(1) ?? "—"}</span>
            <span>Borderline band ±3.0</span>
            <span>
              Selected {selectedCount} teams · {decision?.selectedSeats ?? 0} / {capacity} seats
            </span>
          </footer>
        </section>
        <section
          className={`shortlist-pane inspector-pane ${mobilePane === "inspector" ? "mobile-active" : ""}`}
        >
          <header>
            <span>03 / INSPECTOR</span>
            <Badge tone={selectedResult?.status === "selected" ? "success" : "neutral"}>
              {selectedResult?.status.replace("_", " ") ?? "No selection"}
            </Badge>
          </header>
          <div className="pane-scroll">
            {selectedResult && selectedTeam ? (
              <div className="team-inspector">
                <div className="inspector-scoreline">
                  <span>{selectedResult.rank ? `#${selectedResult.rank}` : "INELIGIBLE"}</span>
                  <strong>{selectedResult.name}</strong>
                  <b>{selectedResult.score.toFixed(1)}</b>
                </div>
                <p className="decision-copy">
                  {selectedResult.status === "selected"
                    ? `Selected with ${selectedTeam.memberIds.length} seats.`
                    : selectedResult.status === "waitlisted"
                      ? `Waitlisted at position ${selectedResult.waitlistPosition}.`
                      : selectedResult.status === "ineligible"
                        ? selectedResult.ineligibleReasons.join(" ")
                        : decision?.cutoffScore
                          ? `${Math.max(0, decision.cutoffScore - selectedResult.score).toFixed(1)} points below the selected cutoff.`
                          : "Not selected in the current run."}
                </p>
                {selectedResult.override ? (
                  <div className="inspector-flag">
                    <strong>OVERRIDE · {selectedResult.override.action.replace("_", " ")}</strong>
                    <p>{selectedResult.override.reason}</p>
                  </div>
                ) : null}
                {selectedResult.quotaSwap ? (
                  <div className="inspector-flag warning">
                    <strong>QUOTA SWAP · {selectedResult.quotaSwap}</strong>
                    <p>This decision changed while satisfying a structured quota.</p>
                  </div>
                ) : null}
                <div className="inspector-members">
                  <span>MEMBERS</span>
                  {selectedTeam.members.map((member) => (
                    <div key={member.personId}>
                      <strong>{member.name}</strong>
                      <small>
                        @{member.github} · {member.college ?? "College not provided"}
                      </small>
                    </div>
                  ))}
                </div>
                <div className="breakdown-list">
                  <span>REQUIREMENT BREAKDOWN</span>
                  {selectedResult.breakdown.map((item) => {
                    const bestMember = selectedTeam.members.find(
                      (member) => member.personId === item.bestMemberId,
                    );
                    return (
                      <article key={item.skill}>
                        <div>
                          <strong>
                            {taxonomy.technologies[item.skill]?.label ??
                              taxonomy.domains[item.skill]?.label ??
                              item.skill}
                          </strong>
                          <b>
                            {item.teamLevel.toFixed(1)} / {item.target.toFixed(1)}
                          </b>
                        </div>
                        <p>
                          {bestMember
                            ? `Best evidence: ${bestMember.name}. `
                            : "No member evidence. "}
                          Lost {item.fitPointsLost.toFixed(1)} fit points.
                        </p>
                      </article>
                    );
                  })}
                </div>
                <div className="evidence-links">
                  <span>EVIDENCE</span>
                  {shortlist.data.profiles
                    .filter((profile) => selectedTeam.memberIds.includes(profile.personId))
                    .flatMap((profile) =>
                      profile.skills.slice(0, 3).flatMap((skill) =>
                        skill.evidence.slice(0, 2).map((evidence) => (
                          <a
                            href={`https://github.com/${evidence.repository}/blob/${evidence.commitSha}/${evidence.path}`}
                            key={`${profile.personId}-${skill.id}-${evidence.repository}-${evidence.path}`}
                            rel="noreferrer"
                            target="_blank"
                          >
                            <strong>{evidence.path}</strong>
                            <small>
                              {profile.displayName} · {skill.id} · {evidence.commitSha.slice(0, 8)}
                            </small>
                          </a>
                        )),
                      ),
                    )}
                </div>
                <div className="override-editor">
                  <Field label="Override reason" hint="Required and stored in the run audit log.">
                    <TextInput
                      value={overrideReason}
                      maxLength={500}
                      onChange={(event) => setOverrideReason(event.target.value)}
                      placeholder="Document the evidence-based reason"
                    />
                  </Field>
                  <div>
                    <ActionButton
                      tone="secondary"
                      disabled={overrideReason.trim().length < 3}
                      onClick={() => addOverride("pin_in")}
                    >
                      Pin in
                    </ActionButton>
                    <ActionButton
                      tone="danger"
                      disabled={overrideReason.trim().length < 3}
                      onClick={() => addOverride("pin_out")}
                    >
                      Pin out
                    </ActionButton>
                    {selectedOverride ? (
                      <ActionButton
                        tone="quiet"
                        onClick={() =>
                          setOverrides((current) =>
                            current.filter((override) => override.teamId !== selectedTeamId),
                          )
                        }
                      >
                        Clear
                      </ActionButton>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState title="Select a team">
                Choose a ranked row to inspect its evidence, score breakdown, and decision.
              </EmptyState>
            )}
          </div>
          <footer className="inspector-actions">
            <span>
              {overrides.length} logged override{overrides.length === 1 ? "" : "s"} in this draft
            </span>
          </footer>
        </section>
      </div>
    </div>
  );
}

export function SavedRunPage() {
  const { eventId, runId } = useParams();
  const run = useQuery({
    queryKey: ["organizer-shortlist-run", eventId, runId],
    queryFn: () => getOrganizerShortlistRun(eventId ?? "", runId ?? ""),
    enabled: Boolean(eventId && runId),
    retry: false,
  });

  if (run.isPending) return <div className="loading-state">Loading frozen shortlist run…</div>;
  if (run.isError || !run.data) {
    return (
      <div className="portal-page">
        <EmptyState
          title="Saved run not found"
          action={
            <ActionLink to={`/organizer/events/${eventId}/shortlist`}>Back to shortlist</ActionLink>
          }
        >
          {run.error?.message ?? "This run does not exist or is outside your organizer workspace."}
        </EmptyState>
      </div>
    );
  }

  const selected = run.data.results.filter((result) => result.status === "selected");
  const waitlisted = run.data.results.filter((result) => result.status === "waitlisted");
  return (
    <div className="portal-page saved-run-page">
      <PageHeading
        eyebrow="ORGANIZER / SAVED RUN"
        title={run.data.name}
        description={`Immutable snapshot saved ${new Date(run.data.createdAt).toLocaleString("en-IN")} · ${run.data.published ? "published final" : "not published"}.`}
        action={
          <>
            <ActionLink to={`/organizer/events/${eventId}/shortlist`} tone="secondary">
              Back to workspace
            </ActionLink>
            <a
              className="btn terminal-action action-primary"
              href={`/api/organizer/events/${eventId}/shortlist/runs/${run.data.id}.csv`}
            >
              <span aria-hidden="true">[</span>
              <span>Export CSV</span>
              <span aria-hidden="true">]</span>
            </a>
          </>
        }
      />
      <div className="metric-strip saved-run-metrics">
        <div>
          <span>SELECTED</span>
          <strong>{selected.length}</strong>
          <small>{run.data.selection.selectedSeats} participant seats</small>
        </div>
        <div>
          <span>WAITLIST</span>
          <strong>{waitlisted.length}</strong>
          <small>{run.data.selection.waitlistSize} requested</small>
        </div>
        <div>
          <span>CUTOFF</span>
          <strong>{run.data.selection.cutoffScore?.toFixed(1) ?? "—"}</strong>
          <small>Borderline band ±3.0</small>
        </div>
        <div>
          <span>OVERRIDES</span>
          <strong>{run.data.overrides.length}</strong>
          <small>Reasoned and audited</small>
        </div>
      </div>
      <div className="saved-run-grid">
        <Panel label="01 / PARAMETERS" title="Frozen configuration">
          <dl className="compact-definition-list run-parameters">
            <div>
              <dt>Capacity</dt>
              <dd>{run.data.selection.capacity} seats</dd>
            </div>
            <div>
              <dt>Fit / depth balance</dt>
              <dd>{run.data.params.alpha.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Novelty weight</dt>
              <dd>{run.data.params.noveltyWeight} points</dd>
            </div>
            <div>
              <dt>Minimum fit</dt>
              <dd>{Math.round(run.data.params.minFit * 100)}%</dd>
            </div>
          </dl>
          <div className="run-requirements">
            {run.data.params.requirements.map((requirement) => (
              <article key={requirement.skill}>
                <strong>
                  {taxonomy.technologies[requirement.skill]?.label ??
                    taxonomy.domains[requirement.skill]?.label ??
                    requirement.skill}
                </strong>
                <span>
                  target {requirement.target.toFixed(1)} · weight {requirement.weight}
                </span>
              </article>
            ))}
          </div>
          {run.data.quotaReports.length ? (
            <div className="quota-report-strip run-quota-reports">
              {run.data.quotaReports.map((report) => (
                <p className={report.met ? "met" : "unmet"} key={JSON.stringify(report.quota)}>
                  {report.message}
                </p>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No quota rules were applied to this run.</p>
          )}
        </Panel>
        <Panel label="02 / AUDIT" title="Overrides and quota swaps">
          {run.data.overrides.length === 0 && run.data.swaps.length === 0 ? (
            <EmptyState title="No manual or quota changes">
              Final order came directly from score ranking and seat capacity.
            </EmptyState>
          ) : (
            <div className="run-audit-list">
              {run.data.overrides.map((override) => (
                <article key={`${override.teamId}-${override.at}`}>
                  <Badge tone="warning">{override.action.replace("_", " ")}</Badge>
                  <strong>{override.reason}</strong>
                  <small>{new Date(override.at).toLocaleString("en-IN")}</small>
                </article>
              ))}
              {run.data.swaps.map((swap) => (
                <article key={`${swap.addedTeamId}-${swap.removedTeamId}`}>
                  <Badge tone="neutral">quota swap</Badge>
                  <strong>{swap.message}</strong>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <Panel label="03 / ORDERED RESULTS" title={`${run.data.results.length} ranked teams`}>
        <table className="saved-run-table">
          <caption className="sr-only">Frozen shortlist results</caption>
          <thead>
            <tr className="saved-run-row saved-run-head">
              <th scope="col">Rank / team</th>
              <th scope="col">Fit</th>
              <th scope="col">Depth</th>
              <th scope="col">Novelty</th>
              <th scope="col">Score</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {run.data.results.map((result) => (
              <tr className="saved-run-row" key={result.teamId}>
                <th scope="row">
                  <b>{result.rank ? `#${result.rank}` : "—"}</b>
                  <strong>{result.name}</strong>
                  <small>{result.memberIds.length} members</small>
                </th>
                <td>{Math.round(result.fit * 100)}%</td>
                <td>{result.depth.toFixed(2)}</td>
                <td>{result.novelty.toFixed(2)}</td>
                <td>{result.score.toFixed(1)}</td>
                <td data-status={result.status}>{result.status.replace("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
