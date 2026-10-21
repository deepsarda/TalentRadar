import type { QuotaRule } from "@talentradar/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PromoteQuickForm } from "../components/PromoteQuickForm";
import { SkillPicker } from "../components/SkillPicker";
import { useStatusLine } from "../components/statusline";
import { TimelineFields } from "../components/TimelineFields";
import {
  ActionButton,
  ActionLink,
  Avatar,
  CheckRow,
  countdown,
  Details,
  EmptyState,
  ErrorState,
  Field,
  formatDate,
  formatDateTime,
  LoadingState,
  LogView,
  Notice,
  Pane,
  RequiredMark,
  ScreenHead,
  SelectInput,
  SkillGroups,
  Slider,
  Stat,
  StateTag,
  Steps,
  TermTabs,
  TextAction,
  TextArea,
  TextInput,
} from "../components/ui";
import {
  type CreateEventInput,
  createOrganizerEvent,
  createQuickImport,
  type EventConfigurationInput,
  type EventDraftStep,
  getCurrentUser,
  getOrganizerCorrections,
  getOrganizerEvent,
  getOrganizerEventAudit,
  getOrganizerEventOperations,
  getOrganizerEvents,
  getQuickImport,
  type OrganizerCorrection,
  type OrganizerEventDetails,
  type OrganizerEventSummary,
  publishOrganizerEvent,
  resolveOrganizerCorrection,
  saveOrganizerEventDraft,
  startQuickImport,
  unpublishOrganizerEvent,
  updateOrganizerEventConfiguration,
  uploadQuickArchive,
  uploadQuickCsv,
} from "../lib/api";
import {
  isoToIstDateTime,
  istDateTimeToIso,
  slugify,
  type TimelineKey,
  timelineFields,
} from "../lib/event-fields";
import { isArea, skillLabel, splitSkills } from "../lib/skills";

const eventSteps = ["details", "dates", "teams", "areas", "tools", "quotas"] as const;
const quickSteps = ["upload", "columns", "consent", "build"] as const;
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

type Requirement = CreateEventInput["requirements"][number];

const logTime = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});

/* ------------------------------------------------------------------ shared editors */

/** Type-to-search skill picker, then one row per requirement with target and weight sliders. */
function RequirementsEditor({
  value,
  onChange,
  keepOne = false,
  kind,
}: {
  /** Every requirement; with `kind`, only that kind is shown and edited, the rest pass through. */
  value: Requirement[];
  onChange: (next: Requirement[]) => void;
  /** Saved events must keep at least one requirement. */
  keepOne?: boolean;
  kind?: "area" | "tool";
}) {
  const rows =
    kind === undefined
      ? value
      : value.filter((requirement) => (kind === "area") === isArea(requirement.skill));
  const update = (skill: string, patch: Partial<Requirement>) =>
    onChange(
      value.map((requirement) =>
        requirement.skill === skill ? { ...requirement, ...patch } : requirement,
      ),
    );

  return (
    <div className="grid gap-4">
      <SkillPicker
        {...(kind ? { kind, label: kind === "area" ? "Add area" : "Add tool" } : {})}
        exclude={value.map((requirement) => requirement.skill)}
        onPick={(skill) =>
          onChange([...value, { skill, target: 3, weight: 3, coverage: { mode: "any_member" } }])
        }
      />
      {rows.length ? (
        <SkillGroups items={rows} idOf={(requirement) => requirement.skill} className="grid">
          {(requirement) => {
            const label = skillLabel(requirement.skill);
            return (
              <fieldset
                key={requirement.skill}
                className="m-0 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 border-x-0 border-t-0 border-b border-line px-0 py-3 last:border-b-0"
              >
                <legend className="sr-only">{label}</legend>
                <span className="truncate font-bold" aria-hidden="true">
                  {label}
                </span>
                <span>
                  <TextAction
                    tone="danger"
                    aria-label={`Remove ${label}`}
                    disabled={keepOne && value.length === 1}
                    onClick={() =>
                      onChange(value.filter((candidate) => candidate.skill !== requirement.skill))
                    }
                  >
                    remove
                  </TextAction>
                </span>
                <div className="col-span-2 grid gap-x-8 gap-y-1 sm:grid-cols-2">
                  <Slider
                    compact
                    label="target"
                    value={requirement.target}
                    min={1}
                    max={5}
                    step={0.5}
                    format={(current) => current.toFixed(1)}
                    onChange={(target) => update(requirement.skill, { target })}
                  />
                  <Slider
                    compact
                    label="weight"
                    value={requirement.weight}
                    min={0}
                    max={5}
                    step={1}
                    // 0 is shown on the profile but not scored; "off" says that without a legend.
                    format={(current) => (current === 0 ? "off" : `×${current}`)}
                    onChange={(weight) => update(requirement.skill, { weight })}
                  />
                </div>
              </fieldset>
            );
          }}
        </SkillGroups>
      ) : null}
    </div>
  );
}

const quotaAttributes: Record<QuotaRule["attribute"], string> = {
  college: "college",
  year_of_study: "year of study",
  branch: "branch",
  city: "city",
};
const quotaOperators: Record<QuotaRule["op"], string> = {
  equals: "is",
  not_equals: "is not",
  in: "is one of",
  not_in: "is none of",
};
const quotaMatches: Record<QuotaRule["match"], string> = {
  all: "all members match",
  majority: "most members match",
  any: "any member matches",
};

/** "college is not SVNIT Surat — at least 10% of teams, all members match" */
function describeQuota(quota: QuotaRule) {
  const value = Array.isArray(quota.value) ? quota.value.join(", ") : quota.value;
  const share = `at least ${Math.round(quota.minShare * 100)}% of ${quota.unit}`;
  return `${quotaAttributes[quota.attribute]} ${quotaOperators[quota.op]} ${value} — ${share}${
    quota.unit === "teams" ? `, ${quotaMatches[quota.match]}` : ""
  }`;
}

function QuotaBuilder({
  value,
  onChange,
}: {
  value: QuotaRule[];
  onChange: (next: QuotaRule[]) => void;
}) {
  const [draft, setDraft] = useState<{
    attribute: QuotaRule["attribute"];
    op: QuotaRule["op"];
    value: string;
    minShare: number;
    unit: QuotaRule["unit"];
    match: QuotaRule["match"];
  }>({
    attribute: "college",
    op: "not_equals",
    value: "",
    minShare: 0.1,
    unit: "teams",
    match: "all",
  });
  const listOperator = draft.op === "in" || draft.op === "not_in";
  const rawValue = draft.value.trim();
  const candidate: QuotaRule | null = rawValue
    ? {
        ...draft,
        value: listOperator
          ? rawValue
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : rawValue,
      }
    : null;
  const canAdd =
    candidate !== null && draft.minShare >= 0.01 && draft.minShare <= 1 && value.length < 20;
  const add = () => {
    if (!canAdd || !candidate) return;
    onChange([...value, candidate]);
    setDraft((current) => ({ ...current, value: "" }));
  };

  return (
    <div className="grid gap-4">
      {value.length ? (
        <ul className="grid gap-1">
          {value.map((quota, index) => (
            <li
              className="grid grid-cols-[2ch_minmax(0,1fr)_auto] items-baseline gap-x-2"
              key={JSON.stringify(quota)}
            >
              <span aria-hidden="true" className="text-accent">
                {index + 1}.
              </span>
              <span>{describeQuota(quota)}</span>
              <TextAction
                tone="danger"
                aria-label={`Remove rule ${index + 1}`}
                onClick={() => onChange(value.filter((other) => other !== quota))}
              >
                remove
              </TextAction>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim">No quotas.</p>
      )}
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field label="Attribute">
          <SelectInput
            value={draft.attribute}
            onChange={(event) =>
              setDraft((current) => ({
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
        <Field label="Condition">
          <SelectInput
            value={draft.op}
            onChange={(event) =>
              setDraft((current) => ({ ...current, op: event.target.value as QuotaRule["op"] }))
            }
          >
            <option value="equals">is</option>
            <option value="not_equals">is not</option>
            <option value="in">is one of</option>
            <option value="not_in">is none of</option>
          </SelectInput>
        </Field>
        <Field
          label="Value"
          required
          className="sm:col-span-2"
          {...(listOperator ? { hint: "comma-separated" } : {})}
        >
          <TextInput
            value={draft.value}
            placeholder={listOperator ? "SVNIT Surat, NIT Trichy" : "SVNIT Surat"}
            onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))}
          />
        </Field>
        <div className="sm:col-span-2">
          <Slider
            label="minimum share"
            value={draft.minShare}
            min={0.01}
            max={1}
            step={0.01}
            format={(current) => `${Math.round(current * 100)}%`}
            onChange={(minShare) => setDraft((current) => ({ ...current, minShare }))}
          />
        </div>
        <Field label="Count">
          <SelectInput
            value={draft.unit}
            onChange={(event) =>
              setDraft((current) => ({ ...current, unit: event.target.value as QuotaRule["unit"] }))
            }
          >
            <option value="teams">Teams</option>
            <option value="participants">Participants</option>
          </SelectInput>
        </Field>
        <Field label="A team counts when">
          <SelectInput
            value={draft.match}
            disabled={draft.unit === "participants"}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                match: event.target.value as QuotaRule["match"],
              }))
            }
          >
            <option value="all">All members match</option>
            <option value="majority">Most members match</option>
            <option value="any">Any member matches</option>
          </SelectInput>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ActionButton disabled={!canAdd} onClick={add}>
          Add rule
        </ActionButton>
        {candidate ? <span className="dim">{describeQuota(candidate)}</span> : null}
      </div>
    </div>
  );
}

function AliasEditor({
  value,
  onChange,
}: {
  value: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
}) {
  const [canonical, setCanonical] = useState("");
  const [aliases, setAliases] = useState("");
  const add = () => {
    const name = canonical.trim();
    const names = aliases
      .split(",")
      .map((alias) => alias.trim())
      .filter(Boolean);
    if (!name || names.length === 0) return;
    onChange({ ...value, [name]: names });
    setCanonical("");
    setAliases("");
  };
  const entries = Object.entries(value);

  return (
    <div className="grid gap-4">
      {entries.length ? (
        <ul className="grid gap-1">
          {entries.map(([name, names]) => (
            <li className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2" key={name}>
              <span>
                <span className="font-bold">{name}</span>
                <span className="dim"> ← {names.join(", ")}</span>
              </span>
              <TextAction
                tone="danger"
                aria-label={`Remove ${name}`}
                onClick={() => {
                  const next = { ...value };
                  delete next[name];
                  onChange(next);
                }}
              >
                remove
              </TextAction>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim">No aliases.</p>
      )}
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field label="College" required>
          <TextInput
            value={canonical}
            placeholder="SVNIT Surat"
            onChange={(event) => setCanonical(event.target.value)}
          />
        </Field>
        <Field label="Other spellings" hint="comma-separated" required>
          <TextInput
            value={aliases}
            placeholder="SVNIT, NIT Surat"
            onChange={(event) => setAliases(event.target.value)}
          />
        </Field>
      </div>
      <div>
        <ActionButton disabled={!canonical.trim() || !aliases.trim()} onClick={add}>
          Add alias
        </ActionButton>
      </div>
    </div>
  );
}

function TeamSizeFields({
  min,
  max,
  capacity,
  onMin,
  onMax,
  onCapacity,
}: {
  min: number;
  max: number;
  capacity: number;
  onMin: (value: number) => void;
  onMax: (value: number) => void;
  onCapacity: (value: number) => void;
}) {
  return (
    <div className="grid items-start gap-4 sm:grid-cols-3">
      <Field label="Min team size" hint="1 = solo" required>
        <TextInput
          type="number"
          min="1"
          max="6"
          value={min}
          onChange={(event) => onMin(Number(event.target.value))}
        />
      </Field>
      <Field label="Max team size" required {...(min > max ? { error: "below the minimum" } : {})}>
        <TextInput
          type="number"
          min="1"
          max="6"
          value={max}
          onChange={(event) => onMax(Number(event.target.value))}
        />
      </Field>
      <Field label="Seats" required>
        <TextInput
          type="number"
          min="1"
          max="5000"
          value={capacity}
          onChange={(event) => onCapacity(Number(event.target.value))}
        />
      </Field>
    </div>
  );
}

/** A titled block inside a single-column form; blocks are spaced, not boxed. */
function FormSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <h2 className="font-display text-2xl text-accent">
        {title}
        {meta ? <span className="dim text-lg"> {meta}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** Back on the left; on the right, the first missing thing (if any) and the primary action. */
function WizardFooter({
  onBack,
  missing,
  children,
}: {
  onBack?: () => void;
  missing?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <ActionButton tone="quiet" disabled={!onBack} onClick={() => onBack?.()}>
        Back
      </ActionButton>
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {missing ? <span className="dim">~ {missing}</span> : null}
        {children}
      </div>
    </div>
  );
}

/** The message of the first failing check, or null when every check passes. */
function firstMissing(checks: Array<[boolean, string]>) {
  return checks.find(([ok]) => !ok)?.[1] ?? null;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ dashboard */

function SignInNotice() {
  return (
    <Notice
      tone="info"
      action={
        <ActionLink to="/login?returnTo=%2Forganizer" tone="primary">
          Sign in with GitHub
        </ActionLink>
      }
    >
      You're signed out.
    </Notice>
  );
}

function eventHref(event: OrganizerEventSummary) {
  if (event.kind === "quick") return `/organizer/quick/${event.id}/import`;
  // An unfinished draft reopens in the wizard at the step it still needs.
  if (event.missing) return `/organizer/events/new?draft=${event.id}`;
  return `/organizer/events/${event.id}`;
}

type EventTab = "live" | "upcoming" | "past" | "quick";

const eventTabs: Array<{
  id: EventTab;
  label: string;
  command: string;
  noun: string;
  matches: (event: OrganizerEventSummary) => boolean;
}> = [
  {
    id: "live",
    label: "live",
    command: "talentradar events ls --live",
    noun: "No live events",
    matches: (event) => event.kind === "event" && event.visibility === "published",
  },
  {
    id: "upcoming",
    label: "upcoming",
    command: "talentradar events ls --upcoming",
    noun: "No drafts",
    matches: (event) => event.kind === "event" && event.visibility === "draft",
  },
  {
    id: "past",
    label: "past",
    command: "talentradar events ls --past",
    noun: "No past events",
    matches: (event) => event.kind === "event" && event.visibility === "closed",
  },
  {
    id: "quick",
    label: "quick",
    command: "talentradar quick ls",
    noun: "No quick shortlists",
    matches: (event) => event.kind === "quick",
  },
];

function EventRows({ events }: { events: OrganizerEventSummary[] }) {
  const navigate = useNavigate();
  return (
    <div className="table-scroll">
      <table className="tui-table cards">
        <caption className="sr-only">Your events</caption>
        <thead>
          <tr>
            <th scope="col">event</th>
            <th scope="col">state</th>
            <th scope="col">closes</th>
            <th scope="col">starts</th>
            <th scope="col">
              <span className="sr-only">open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} data-clickable onClick={() => navigate(eventHref(event))}>
              <th scope="row" data-label="event" className="font-bold">
                <Link to={eventHref(event)} className="hover:text-accent">
                  {event.name}
                </Link>
              </th>
              <td data-label="state">
                <StateTag state={event.visibility} />
              </td>
              <td data-label="closes">
                {event.registrationClosesAt ? formatDate(event.registrationClosesAt) : "—"}
              </td>
              <td data-label="starts">
                {event.eventStartsAt ? formatDate(event.eventStartsAt) : "—"}
              </td>
              <td className="dim num max-[720px]:hidden!" aria-hidden="true">
                open ›
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const [chosenTab, setChosenTab] = useState<EventTab | null>(null);
  const organizerEvents = events.data ?? [];
  const groups = eventTabs.map((tab) => ({ ...tab, rows: organizerEvents.filter(tab.matches) }));
  const tab =
    chosenTab ?? groups.find((group) => group.rows.length > 0)?.id ?? eventTabs[0]?.id ?? "live";
  const current = groups.find((group) => group.id === tab) ?? groups[0];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <ScreenHead
        title="Your events"
        actions={
          <>
            <ActionLink to="/organizer/quick/new">Quick shortlist</ActionLink>
            <ActionLink to="/organizer/events/new" tone="primary">
              New event
            </ActionLink>
          </>
        }
      />

      <TermTabs
        label="events"
        tabs={groups.map((group) => ({
          id: group.id,
          label: group.label,
          ...(events.data ? { count: group.rows.length } : {}),
        }))}
        active={tab}
        onChange={setChosenTab}
        command={current?.command ?? "talentradar events ls"}
        {...(account.data ? { user: account.data.login } : {})}
      >
        <div className="px-4">
          {!account.data && !account.isPending ? <SignInNotice /> : null}
          {events.isPending && account.data ? <LoadingState label="reading your events" /> : null}
          {events.isError ? (
            <ErrorState message={events.error.message} retry={() => void events.refetch()} />
          ) : null}
          {events.data && current && current.rows.length === 0 ? (
            <EmptyState
              title={current.noun}
              action={
                current.id === "quick" ? (
                  <ActionLink to="/organizer/quick/new">Quick shortlist</ActionLink>
                ) : (
                  <ActionLink to="/organizer/events/new">New event</ActionLink>
                )
              }
            />
          ) : null}
        </div>
        {current && current.rows.length > 0 ? <EventRows events={current.rows} /> : null}
      </TermTabs>
    </div>
  );
}

/* ------------------------------------------------------------------ event wizard */

/** Which server step each wizard screen saves; areas and tools share the requirements list. */
const draftStepOf = [
  "details",
  "dates",
  "teams",
  "requirements",
  "requirements",
  "quotas",
] as const;

/** Where a reopened draft continues: the first step it still needs. */
function resumeStep(event: OrganizerEventDetails) {
  if (event.missing === "dates") return 1;
  if (event.missing === "requirements") return 2;
  return eventSteps.length - 1;
}

/** Wait after the last keystroke before autosaving a valid step. */
const AUTOSAVE_DELAY_MS = 1500;

export function EventWizardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { post } = useStatusLine();
  const [searchParams, setSearchParams] = useSearchParams();
  const draftId = searchParams.get("draft");
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const draft = useQuery({
    queryKey: ["organizer-event", draftId],
    queryFn: () => getOrganizerEvent(draftId ?? ""),
    enabled: Boolean(draftId && account.data),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [hydrated, setHydrated] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  /** JSON of the last payload the server accepted, per server step. */
  const saved = useRef<Partial<Record<EventDraftStep["step"], string>>>({});
  /** JSON of the raw inputs behind it (valid or not), to notice edits not stored yet. */
  const baseline = useRef<Partial<Record<EventDraftStep["step"], string>>>({});
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [bannerUrl, setBannerUrl] = useState("");
  const [mode, setMode] = useState<CreateEventInput["mode"]>("in_person");
  const [venue, setVenue] = useState("");
  const [timeline, setTimeline] = useState<Record<TimelineKey, string>>({
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
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [links, setLinks] = useState<Array<{ label: string; url: string }>>([]);
  const [linkDraft, setLinkDraft] = useState({ label: "", url: "" });
  const [quotas, setQuotas] = useState<QuotaRule[]>([]);
  const [collegeAliases, setCollegeAliases] = useState<Record<string, string[]>>({});

  // Reopening ?draft=<id> fills every step from the server and continues where it stopped.
  useEffect(() => {
    const event = draft.data;
    if (!event || hydrated) return;
    if (event.visibility !== "draft") {
      navigate(`/organizer/events/${event.id}`, { replace: true });
      return;
    }
    setName(event.name);
    setSlug(event.slug);
    setTagline(event.tagline);
    setDescription(event.description);
    setLogoUrl(event.logoUrl ?? "");
    setBannerUrl(event.bannerUrl ?? "");
    setMode(event.mode);
    setVenue(event.venue ?? "");
    setLinks(event.links);
    const eventTimeline = event.timeline;
    if (eventTimeline) {
      setTimeline(
        Object.fromEntries(
          timelineFields.map(([key]) => [key, isoToIstDateTime(eventTimeline[key])]),
        ) as Record<TimelineKey, string>,
      );
    }
    setMinimumTeamSize(event.teamSize.min);
    setMaximumTeamSize(event.teamSize.max);
    setCapacity(event.capacity);
    setRequirements(event.requirements);
    setQuotas(event.quotas);
    setCollegeAliases(event.collegeAliases);
    setStep(resumeStep(event));
    setHydrated(true);
  }, [draft.data, hydrated, navigate]);

  const addLink = () => {
    const label = linkDraft.label.trim();
    const url = linkDraft.url.trim();
    if (!label || !URL.canParse(url) || links.length >= 12) return;
    setLinks((current) => [...current, { label, url }]);
    setLinkDraft({ label: "", url: "" });
  };

  const timelineComplete = Object.values(timeline).every(Boolean);
  const stepValidity = [
    name.trim().length >= 3 &&
      Boolean(slug) &&
      Boolean(tagline.trim()) &&
      Boolean(description.trim()) &&
      (mode === "online" || Boolean(venue.trim())),
    timelineComplete,
    minimumTeamSize <= maximumTeamSize && capacity > 0,
    true,
    // Areas and tools are each optional; together they need one scored skill.
    requirements.some((requirement) => requirement.weight > 0),
    Boolean(account.data),
  ];
  const emptyDate = timelineFields.find(([key]) => !timeline[key]);
  const missing = [
    firstMissing([
      [name.trim().length >= 3, "add an event name"],
      [Boolean(slug), "add a public link"],
      [Boolean(tagline.trim()), "add a tagline"],
      [Boolean(description.trim()), "add a description"],
      [mode === "online" || Boolean(venue.trim()), "add a venue"],
    ]),
    emptyDate ? `set ${emptyDate[1].toLowerCase()}` : null,
    firstMissing([
      [minimumTeamSize <= maximumTeamSize, "fix team size"],
      [capacity > 0, "add seats"],
    ]),
    null,
    firstMissing([
      [requirements.length > 0, "add an area or a tool"],
      [stepValidity[4] ?? false, "weight one skill"],
    ]),
    firstMissing([[Boolean(account.data) || account.isPending, "sign in first"]]),
  ][step];

  /** The current screen's server step, or null while it is not valid yet. */
  const payloadFor = (index: number): EventDraftStep | null => {
    if (!stepValidity[index]) return null;
    const stepName = draftStepOf[index];
    if (stepName === "details") {
      return {
        step: "details",
        name: name.trim(),
        slug,
        tagline: tagline.trim(),
        description: description.trim(),
        ...(logoUrl ? { logoUrl } : {}),
        ...(bannerUrl ? { bannerUrl } : {}),
        links,
        mode,
        ...(venue.trim() && mode !== "online" ? { venue: venue.trim() } : {}),
      };
    }
    if (stepName === "dates") {
      return {
        step: "dates",
        timeline: {
          timezone: "Asia/Kolkata",
          ...(Object.fromEntries(
            timelineFields.map(([key]) => [key, istDateTimeToIso(timeline[key])]),
          ) as Record<TimelineKey, string>),
        },
      };
    }
    if (stepName === "teams") {
      return {
        step: "teams",
        teamSize: { min: minimumTeamSize, max: maximumTeamSize },
        capacity,
      };
    }
    if (stepName === "requirements") {
      return {
        step: "requirements",
        requirements: requirements.map((requirement) => ({
          skill: requirement.skill,
          target: requirement.target,
          weight: requirement.weight,
          coverage: requirement.coverage,
        })),
      };
    }
    return { step: "quotas", quotas, collegeAliases };
  };

  /** The step's inputs as typed, valid or not. */
  const rawFor = (index: number) =>
    JSON.stringify(
      [
        { name, slug, tagline, description, logoUrl, bannerUrl, mode, venue, links },
        timeline,
        [minimumTeamSize, maximumTeamSize, capacity],
        requirements,
        requirements,
        [quotas, collegeAliases],
      ][index],
    );

  const saveStep = useMutation({
    mutationFn: async ({ payload }: { payload: EventDraftStep; raw: string }) => {
      if (draftId) return saveOrganizerEventDraft(draftId, payload);
      if (payload.step !== "details") throw new Error("Save the details first");
      const { step: _details, ...detailsInput } = payload;
      return createOrganizerEvent(detailsInput);
    },
    onSuccess: async (event, { payload, raw }) => {
      saved.current[payload.step] = JSON.stringify(payload);
      baseline.current[payload.step] = raw;
      setSavedAt(new Date());
      if (draftId) {
        queryClient.setQueryData(["organizer-event", draftId], event);
      } else {
        // What is on screen is the draft; no need to load it back.
        setHydrated(true);
        setSearchParams({ draft: event.id }, { replace: true });
        post("Draft created.");
      }
      await queryClient.invalidateQueries({ queryKey: ["organizer-events"] });
    },
  });

  // A fresh wizard starts from its defaults; a reopened draft from what the server has.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot once per hydration change
  useEffect(() => {
    if (draftId && !hydrated) return;
    for (let index = 0; index < eventSteps.length; index += 1) {
      const stepName = draftStepOf[index];
      if (!stepName) continue;
      baseline.current[stepName] ??= rawFor(index);
      const payload = hydrated ? payloadFor(index) : null;
      if (payload) saved.current[stepName] ??= JSON.stringify(payload);
    }
  }, [hydrated]);

  const currentPayload = payloadFor(step);
  const currentJson = currentPayload ? JSON.stringify(currentPayload) : null;
  const currentStepName = draftStepOf[step] ?? "details";
  const unsaved = currentJson !== saved.current[currentStepName];
  const signedIn = Boolean(account.data);

  const currentRaw = rawFor(step);
  const edited = currentRaw !== baseline.current[currentStepName];

  // Autosave: a valid step of an existing draft is stored shortly after the last change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the payload's content
  useEffect(() => {
    if (!signedIn || !draftId || !currentPayload || !unsaved || saveStep.isPending) return;
    // A rejected payload is not retried until it changes.
    if (saveStep.isError && JSON.stringify(saveStep.variables?.payload) === currentJson) return;
    const timer = window.setTimeout(
      () => saveStep.mutate({ payload: currentPayload, raw: currentRaw }),
      AUTOSAVE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [currentJson, draftId, signedIn, unsaved, saveStep.isPending]);

  // Leaving with edits the server has not stored (invalid, pending or signed out) asks first.
  useEffect(() => {
    if (!edited) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edited]);

  /** Saves the step when signed in (creating the draft on the first one), then moves on. */
  const advance = async () => {
    if (!stepValidity[step]) return;
    if (signedIn && currentPayload && (unsaved || !draftId)) {
      try {
        await saveStep.mutateAsync({ payload: currentPayload, raw: currentRaw });
      } catch {
        return; // the error is shown under the footer; stay on this step
      }
    }
    setStep((value) => Math.min(eventSteps.length - 1, value + 1));
  };

  const finish = async () => {
    if (!stepValidity.every(Boolean) || !currentPayload) return;
    try {
      const event =
        unsaved || !draftId
          ? await saveStep.mutateAsync({ payload: currentPayload, raw: currentRaw })
          : null;
      const id = event?.id ?? draftId;
      if (id) navigate(`/organizer/events/${id}`);
    } catch {
      // shown under the footer
    }
  };

  if (draftId && (draft.isPending || (draft.isSuccess && !hydrated)) && account.data) {
    return <LoadingState label="opening draft" />;
  }
  if (draftId && draft.isError) return <EventUnavailable message={draft.error.message} />;

  return (
    <div className="mx-auto grid max-w-2xl gap-10">
      <div className="grid gap-6">
        <ScreenHead title="Create a hackathon workspace" />
        {!account.data && !account.isPending ? <SignInNotice /> : null}
        <Steps
          steps={eventSteps}
          current={step}
          onSelect={(index) => {
            if (index < step) setStep(index);
          }}
        />
      </div>

      <Pane title={eventSteps[step] ?? eventSteps[0]} meta={step === 1 ? "IST" : undefined} active>
        {step === 0 ? (
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Event name" required>
              <TextInput
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (!slug) setSlug(slugify(event.target.value));
                }}
                placeholder="HackSVNIT 2026"
                maxLength={80}
              />
            </Field>
            <Field label="Public link" hint={slug ? `/h/${slug}` : "a-z, 0-9, -"} required>
              <TextInput
                value={slug}
                onChange={(event) => setSlug(slugify(event.target.value))}
                placeholder="hacksvnit-2026"
                maxLength={40}
              />
            </Field>
            <Field label="Tagline" className="sm:col-span-2" required>
              <TextInput
                value={tagline}
                onChange={(event) => setTagline(event.target.value)}
                placeholder="36 hours. Build for Gujarat's farmers."
                maxLength={140}
              />
            </Field>
            <Field label="Description" hint="Markdown" className="sm:col-span-2" required>
              <TextArea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={5}
                placeholder="Rules, prizes, themes and schedule"
                maxLength={5000}
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
            <Field label="Venue" required={mode !== "online"}>
              <TextInput
                value={venue}
                onChange={(event) => setVenue(event.target.value)}
                placeholder="SVNIT Surat, CSE block"
                disabled={mode === "online"}
              />
            </Field>

            <div className="pt-2 sm:col-span-2">
              <Details
                summary="links and images"
                {...(links.length ? { meta: plural(links.length, "link") } : {})}
              >
                <div className="grid gap-4">
                  <div className="grid items-start gap-4 sm:grid-cols-2">
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
                  </div>
                  {links.length ? (
                    <ul className="grid gap-1">
                      {links.map((link) => (
                        <li
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2"
                          key={`${link.label}-${link.url}`}
                        >
                          <span className="truncate">
                            {link.label} <span className="dim">{link.url}</span>
                          </span>
                          <TextAction
                            tone="danger"
                            aria-label={`Remove ${link.label}`}
                            onClick={() =>
                              setLinks((current) => current.filter((other) => other !== link))
                            }
                          >
                            remove
                          </TextAction>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]">
                    <TextInput
                      aria-label="Link label"
                      placeholder="Discord"
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
                      className="min-h-9!"
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
                </div>
              </Details>
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <TimelineFields
            value={timeline}
            onChange={(key, value) => setTimeline((current) => ({ ...current, [key]: value }))}
          />
        ) : null}

        {step === 2 ? (
          <TeamSizeFields
            min={minimumTeamSize}
            max={maximumTeamSize}
            capacity={capacity}
            onMin={setMinimumTeamSize}
            onMax={setMaximumTeamSize}
            onCapacity={setCapacity}
          />
        ) : null}

        {step === 3 ? (
          <RequirementsEditor value={requirements} onChange={setRequirements} kind="area" />
        ) : null}
        {step === 4 ? (
          <RequirementsEditor value={requirements} onChange={setRequirements} kind="tool" />
        ) : null}
        {step === 5 ? (
          <div className="grid gap-10">
            <QuotaBuilder value={quotas} onChange={setQuotas} />
            <FormSection title="college aliases" meta={String(Object.keys(collegeAliases).length)}>
              <AliasEditor value={collegeAliases} onChange={setCollegeAliases} />
            </FormSection>
          </div>
        ) : null}
      </Pane>

      <div className="grid gap-3">
        <WizardFooter
          {...(step > 0 ? { onBack: () => setStep((value) => Math.max(0, value - 1)) } : {})}
          missing={missing ?? null}
        >
          {savedAt && !unsaved ? (
            <span className="dim">saved {logTime.format(savedAt)}</span>
          ) : null}
          {step < eventSteps.length - 1 ? (
            <ActionButton
              tone="primary"
              disabled={!stepValidity[step] || saveStep.isPending}
              onClick={() => void advance()}
            >
              {saveStep.isPending ? "Saving…" : "Continue"}
            </ActionButton>
          ) : (
            <ActionButton
              tone="primary"
              disabled={!stepValidity.every(Boolean) || saveStep.isPending}
              onClick={() => void finish()}
            >
              {saveStep.isPending ? "Saving…" : "Save draft"}
            </ActionButton>
          )}
        </WizardFooter>
        {saveStep.isError ? <ErrorState message={saveStep.error.message} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ quick shortlist */

function FileInput({
  accept,
  onFile,
  ...props
}: {
  accept: string;
  onFile: (file: File | null) => void;
  id?: string;
  required?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <input
      {...props}
      type="file"
      accept={accept}
      className="block w-full min-w-0 cursor-pointer border border-dim p-1 file:mr-3 file:cursor-pointer file:border file:border-current file:bg-transparent file:px-2 file:py-0.5 file:text-accent hover:file:bg-accent hover:file:text-bg"
      onChange={(event) => onFile(event.target.files?.[0] ?? null)}
    />
  );
}

export function QuickShortlistPage() {
  const { quickId } = useParams();
  const navigate = useNavigate();
  const { post } = useStatusLine();
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
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
  const [requirements, setRequirements] = useState<Requirement[]>([]);
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

  const requiredMappingReady = Boolean(mapping.name && mapping.email);
  const validTeamSize =
    minimumTeamSize >= 1 &&
    minimumTeamSize <= 6 &&
    maximumTeamSize >= 1 &&
    maximumTeamSize <= 6 &&
    minimumTeamSize <= maximumTeamSize;
  const stepReady = [
    name.trim().length >= 3 && validTeamSize && capacity > 0 && csvFile && requirements.length > 0,
    requiredMappingReady,
    consent,
    status.data?.status === "ready",
  ];
  const missing = [
    firstMissing([
      [name.trim().length >= 3, "add a name"],
      [Boolean(csvFile), "choose a CSV"],
      [requirements.length > 0, "add a skill"],
      [validTeamSize, "team size must be between 1 and 6"],
      [capacity > 0, "enter capacity"],
      [Boolean(account.data) || account.isPending, "sign in first"],
    ]),
    firstMissing([
      [Boolean(mapping.name), "map the name column"],
      [Boolean(mapping.email), "map the email column"],
    ]),
    consent ? null : "confirm consent",
    null,
  ][step];
  const progress = status.data?.progress;
  const failures = status.data?.failures ?? [];
  const buildLog = status.data?.recentEvents ?? [];
  const error = prepareImport.error ?? startImport.error ?? status.error;

  return (
    <div className="mx-auto grid max-w-2xl gap-10">
      <div className="grid gap-6">
        <ScreenHead title="Quick shortlist" />
        <Steps
          steps={quickSteps}
          current={step}
          onSelect={(index) => {
            if (index < step && step !== 3) setStep(index);
          }}
        />
      </div>

      <Pane
        title={quickSteps[step] ?? quickSteps[0]}
        meta={
          step === 3 && status.data ? (
            <StateTag state={status.data.status} />
          ) : step === 1 ? (
            plural(rowCount, "row")
          ) : undefined
        }
        active
      >
        {step === 0 ? (
          <div className="grid gap-6">
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field label="Name" required>
                <TextInput
                  value={name}
                  maxLength={80}
                  placeholder="Winter hackathon"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field
                label="Responses CSV"
                hint={csvFile ? csvFile.name : "max 2,000 rows"}
                required
              >
                <FileInput accept=".csv,text/csv" onFile={setCsvFile} />
              </Field>
            </div>
            <FormSection title="areas">
              <RequirementsEditor value={requirements} onChange={setRequirements} kind="area" />
            </FormSection>
            <FormSection title="tools">
              <RequirementsEditor value={requirements} onChange={setRequirements} kind="tool" />
            </FormSection>
            <Details
              summary="options"
              meta={`teams ${minimumTeamSize}–${maximumTeamSize} · ${capacity} seats`}
            >
              <div className="grid gap-4">
                <TeamSizeFields
                  min={minimumTeamSize}
                  max={maximumTeamSize}
                  capacity={capacity}
                  onMin={setMinimumTeamSize}
                  onMax={setMaximumTeamSize}
                  onCapacity={setCapacity}
                />
                <Field label="CV archive" hint={archiveFile ? archiveFile.name : "zip, max 200 MB"}>
                  <FileInput accept=".zip,application/zip" onFile={setArchiveFile} />
                </Field>
              </div>
            </Details>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="table-scroll -mx-6">
            <table className="tui-table cards">
              <caption className="sr-only">Map CSV columns to TalentRadar fields</caption>
              <thead>
                <tr>
                  <th scope="col">field</th>
                  <th scope="col">CSV column</th>
                </tr>
              </thead>
              <tbody>
                {quickMappingFields.map((field) => (
                  <tr key={field.key}>
                    <th scope="row" data-label="field" className="font-bold align-middle">
                      {field.label}
                      {field.required ? <RequiredMark /> : null}
                    </th>
                    <td data-label="column" className="w-full">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {step === 2 ? (
          <CheckRow checked={consent} onChange={setConsent} required>
            Registrants agreed to automated evaluation of their GitHub and CV.
          </CheckRow>
        ) : null}

        {step === 3 ? (
          <div className="grid gap-8">
            <div className="flex flex-wrap gap-x-10 gap-y-6 sm:gap-x-16">
              <Stat
                value={`${progress?.ready ?? 0}/${progress?.total ?? 0}`}
                label="profiles ready"
              />
              <Stat value={progress?.pending ?? 0} label="building" />
              {progress?.failed ? (
                <Stat value={progress.failed} label="failed" tone="warn" />
              ) : null}
            </div>
            <div className="grid gap-3">
              <Details summary="build log" meta={plural(buildLog.length, "event")}>
                {buildLog.length ? (
                  <div className="[&_pre]:w-auto! [&_pre]:break-words">
                    <LogView
                      live={status.data?.status === "profiling"}
                      lines={buildLog.map((event) => ({
                        key: `${event.at}-${event.message}`,
                        text: `${logTime.format(new Date(event.at))}  ${event.message}`,
                      }))}
                    />
                  </div>
                ) : (
                  <p className="dim">No events yet.</p>
                )}
              </Details>
              {failures.length ? (
                <Details summary="failed profiles" meta={failures.length}>
                  <ul className="grid gap-1">
                    {failures.map((failure) => (
                      <li key={failure.personId}>
                        <span className="font-bold">{failure.name}</span>{" "}
                        <span className="text-error">{failure.error}</span>
                      </li>
                    ))}
                  </ul>
                </Details>
              ) : null}
            </div>
          </div>
        ) : null}
      </Pane>

      <div className="grid gap-3">
        {step < 3 ? (
          <WizardFooter
            {...(step > 0 ? { onBack: () => setStep((value) => Math.max(0, value - 1)) } : {})}
            missing={missing ?? null}
          >
            {step === 0 ? (
              <ActionButton
                tone="primary"
                disabled={!stepReady[0] || prepareImport.isPending}
                onClick={() => prepareImport.mutate()}
              >
                {prepareImport.isPending ? "Uploading…" : "Upload CSV"}
              </ActionButton>
            ) : null}
            {step === 1 ? (
              <ActionButton tone="primary" disabled={!stepReady[1]} onClick={() => setStep(2)}>
                Continue
              </ActionButton>
            ) : null}
            {step === 2 ? (
              <ActionButton
                tone="primary"
                disabled={!stepReady[2] || startImport.isPending}
                onClick={() =>
                  startImport.mutate(undefined, { onSuccess: () => post("Profiling started.") })
                }
              >
                {startImport.isPending ? "Starting…" : "Start profiling"}
              </ActionButton>
            ) : null}
          </WizardFooter>
        ) : status.data?.status === "ready" && activeQuickId ? (
          <>
            <div className="flex justify-end">
              <ActionLink to={`/organizer/events/${activeQuickId}/shortlist`} tone="primary">
                Open shortlist
              </ActionLink>
            </div>
            <PromoteQuickForm quickId={activeQuickId} name={status.data.name} />
          </>
        ) : null}
        {error ? <ErrorState message={error.message} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ event overview */

const auditLabel: Record<string, string> = {
  "event.created": "created the draft",
  "draft.saved": "saved",
  "event.updated": "changed",
  "event.published": "published",
  "event.unpublished": "unpublished",
  "run.saved": "saved a run",
  "run.published": "published a run",
  "override.added": "overrode",
  "correction.resolved": "resolved a report",
  "correction.dismissed": "dismissed a report",
};

const correctionReasonLabel: Record<OrganizerCorrection["reason"], string> = {
  not_my_repo: "repo isn't theirs",
  missing_repo: "repo missing",
  level_off: "level seems off",
};

/** Newest first: who did what, when, and the field-level summary. */
function ActivityLog({ eventId }: { eventId: string }) {
  const audit = useQuery({
    queryKey: ["organizer-event-audit", eventId],
    queryFn: () => getOrganizerEventAudit(eventId),
    retry: false,
  });
  return (
    <Details summary="activity" meta={audit.data?.length ?? "…"}>
      {audit.isError ? (
        <ErrorState message={audit.error.message} retry={() => void audit.refetch()} />
      ) : audit.data?.length === 0 ? (
        <p className="dim">Nothing yet.</p>
      ) : (
        <ol className="grid gap-3">
          {audit.data?.map((entry) => (
            <li key={entry.id} className="grid">
              <span>
                <time className="dim" dateTime={entry.at}>
                  {formatDateTime(entry.at)}
                </time>{" "}
                @{entry.actor} {auditLabel[entry.action] ?? entry.action}
                {entry.action === "draft.saved" && entry.note ? ` ${entry.note}` : null}
              </span>
              {entry.changes.length ? (
                <span className="dim wrap">{entry.changes.join(" · ")}</span>
              ) : null}
              {entry.note && entry.action !== "draft.saved" ? (
                <span className="dim wrap">“{entry.note}”</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Details>
  );
}

function useOpenCorrections(eventId: string | undefined) {
  return useQuery({
    queryKey: ["organizer-corrections", eventId],
    queryFn: () => getOrganizerCorrections(eventId ?? ""),
    enabled: Boolean(eventId),
    retry: false,
  });
}

/** One open report with an optional note and the two ways to close it. */
function CorrectionRow({
  eventId,
  correction,
}: {
  eventId: string;
  correction: OrganizerCorrection;
}) {
  const queryClient = useQueryClient();
  const { post } = useStatusLine();
  const [note, setNote] = useState("");
  const resolve = useMutation({
    mutationFn: (outcome: "resolved" | "dismissed") =>
      resolveOrganizerCorrection(eventId, correction.id, {
        outcome,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async (_, outcome) => {
      post(outcome === "resolved" ? "Report resolved." : "Report dismissed.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organizer-corrections", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-event-audit", eventId] }),
      ]);
    },
  });
  return (
    <li className="grid gap-2">
      <span className="wrap">
        <span className="font-bold">{correction.name}</span>{" "}
        <span className="dim">@{correction.github}</span> · {skillLabel(correction.skill)} ·{" "}
        {correctionReasonLabel[correction.reason]}
        <span className="dim"> · v{correction.profileVersion}</span>
      </span>
      {correction.note ? <span className="dim wrap">“{correction.note}”</span> : null}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3">
        <TextInput
          aria-label={`Note for ${correction.name}`}
          placeholder="note"
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
        <TextAction disabled={resolve.isPending} onClick={() => resolve.mutate("dismissed")}>
          dismiss
        </TextAction>
        <ActionButton
          size="sm"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate("resolved")}
        >
          Resolve
        </ActionButton>
      </div>
      {resolve.isError ? <ErrorState message={resolve.error.message} /> : null}
    </li>
  );
}

function EventUnavailable({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-2xl pt-6">
      <EmptyState
        title="This event could not be opened"
        action={<ActionLink to="/organizer">Back to events</ActionLink>}
      >
        {message}
      </EmptyState>
    </div>
  );
}

export function EventOverviewPage() {
  const { eventId } = useParams();
  const queryClient = useQueryClient();
  const { post } = useStatusLine();
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
  const corrections = useOpenCorrections(eventId);
  const refreshVisibility = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["organizer-event", eventId] }),
      queryClient.invalidateQueries({ queryKey: ["organizer-events"] }),
      queryClient.invalidateQueries({ queryKey: ["public-events"] }),
      queryClient.invalidateQueries({ queryKey: ["organizer-event-audit", eventId] }),
    ]);
  };
  const publish = useMutation({
    mutationFn: () => publishOrganizerEvent(eventId ?? ""),
    onSuccess: refreshVisibility,
  });
  const unpublish = useMutation({
    mutationFn: () => unpublishOrganizerEvent(eventId ?? ""),
    onSuccess: refreshVisibility,
  });

  if (event.isPending) return <LoadingState label="opening event" />;
  if (event.isError) return <EventUnavailable message={event.error.message} />;

  const data = event.data;
  const now = Date.now();
  const participants = operations.data?.participants ?? [];
  const draft = data.visibility === "draft";
  const nextDeadline = timelineFields
    .map(([key, label]) => ({ label, at: data.timeline?.[key] ?? "" }))
    .find((item) => Date.parse(item.at) > now);

  return (
    <div className="mx-auto grid max-w-4xl gap-10">
      <div className="grid gap-3">
        <ScreenHead
          title={data.name}
          actions={
            <>
              <ActionLink
                to={`/organizer/events/${eventId}/shortlist`}
                tone={draft ? "default" : "primary"}
              >
                Open shortlist
              </ActionLink>
              {draft ? (
                <ActionButton
                  tone="primary"
                  disabled={publish.isPending || Boolean(data.missing)}
                  onClick={() =>
                    publish.mutate(undefined, {
                      onSuccess: () => post(`Published at /h/${data.slug}.`),
                    })
                  }
                >
                  {publish.isPending ? "Publishing…" : "Publish"}
                </ActionButton>
              ) : null}
            </>
          }
        >
          <span className="inline-flex flex-wrap items-center gap-x-3">
            <StateTag state={data.visibility} />
            {data.visibility === "published" ? (
              <Link className="tui-link" to={`/h/${data.slug}`}>
                /h/{data.slug}
              </Link>
            ) : null}
            {data.visibility === "published" && data.metrics.registrations === 0 ? (
              <TextAction
                disabled={unpublish.isPending}
                onClick={() =>
                  unpublish.mutate(undefined, { onSuccess: () => post("Back to draft.") })
                }
              >
                unpublish
              </TextAction>
            ) : null}
            {draft && data.missing ? (
              <Link className="tui-link" to={`/organizer/events/new?draft=${data.id}`}>
                finish setup ›
              </Link>
            ) : null}
          </span>
        </ScreenHead>
        {publish.isError ? <ErrorState message={publish.error.message} /> : null}
        {unpublish.isError ? <ErrorState message={unpublish.error.message} /> : null}
      </div>

      <div className="grid gap-8">
        <div className="flex flex-wrap gap-x-10 gap-y-6 sm:gap-x-16">
          <Stat value={data.metrics.registrations} label="registered" />
          <Stat value={data.metrics.teams} label="teams" />
          <Stat value={data.metrics.profilesReady} label="profiles ready" />
        </div>
        {nextDeadline ? (
          <p>
            <span className="dim">{nextDeadline.label.toLowerCase()} in </span>
            <time className="font-display text-2xl text-accent" dateTime={nextDeadline.at}>
              {countdown(nextDeadline.at, now)}
            </time>
          </p>
        ) : data.timeline ? (
          <p className="dim">All dates have passed.</p>
        ) : (
          <p className="dim">
            No dates yet.{" "}
            <Link
              className="tui-link"
              to={
                draft
                  ? `/organizer/events/new?draft=${eventId}`
                  : `/organizer/events/${eventId}/settings`
              }
            >
              set dates ›
            </Link>
          </p>
        )}
        {corrections.data?.length ? (
          <p className="text-warn">
            ~ {plural(corrections.data.length, "profile report")} open{" "}
            <Link className="tui-link" to={`/organizer/events/${eventId}/participants`}>
              review ›
            </Link>
          </p>
        ) : null}
      </div>

      <Pane title="recent registrations" flush>
        {operations.isPending ? (
          <div className="px-6">
            <LoadingState label="reading registrations" />
          </div>
        ) : operations.isError ? (
          <div className="px-6 pb-3">
            <ErrorState
              message={operations.error.message}
              retry={() => void operations.refetch()}
            />
          </div>
        ) : participants.length === 0 ? (
          <div className="px-6 pb-3">
            <EmptyState title={draft ? "Publish to open registration" : "No registrations yet"} />
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="tui-table cards">
                <caption className="sr-only">Most recent registrations</caption>
                <thead>
                  <tr>
                    <th scope="col">participant</th>
                    <th scope="col">profile</th>
                    <th scope="col">team</th>
                    <th scope="col">updated</th>
                  </tr>
                </thead>
                <tbody>
                  {participants.slice(0, 8).map((participant) => (
                    <tr key={participant.registrationId}>
                      <th scope="row" data-label="participant" className="font-bold">
                        {participant.name}
                      </th>
                      <td data-label="profile">
                        <StateTag state={participant.profileStatus} />
                      </td>
                      <td data-label="team">
                        {participant.teamId ? "yes" : <span className="dim">no</span>}
                      </td>
                      <td data-label="updated" className="dim">
                        {formatDate(participant.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3 pt-3 pb-2">
              <Link className="tui-link" to={`/organizer/events/${eventId}/participants`}>
                all {participants.length} participants ›
              </Link>
            </div>
          </>
        )}
      </Pane>

      {eventId ? <ActivityLog eventId={eventId} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ event sections */

const sectionTitle = {
  requirements: "Requirements",
  participants: "Participants",
  teams: "Teams",
  settings: "Settings",
} as const;

export function EventSectionPage({
  section,
}: {
  section: "requirements" | "participants" | "teams" | "settings";
}) {
  const { eventId } = useParams();
  const queryClient = useQueryClient();
  const { post } = useStatusLine();
  const [configuration, setConfiguration] = useState<EventConfigurationInput | null>(null);
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
  const corrections = useOpenCorrections(section === "participants" ? eventId : undefined);

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

  /** Patch the loaded configuration; a no-op until it has loaded. */
  const patch = (change: Partial<EventConfigurationInput>) =>
    setConfiguration((current) => (current ? { ...current, ...change } : current));
  const updateLink = (index: number, change: Partial<{ label: string; url: string }>) =>
    setConfiguration((current) =>
      current
        ? {
            ...current,
            links: current.links.map((candidate, candidateIndex) =>
              candidateIndex === index ? { ...candidate, ...change } : candidate,
            ),
          }
        : current,
    );

  if (
    event.isPending ||
    (operations.isPending && (section === "participants" || section === "teams"))
  ) {
    return <LoadingState label="reading event" />;
  }
  if (event.isError || operations.isError) {
    return (
      <EventUnavailable message={(event.error ?? operations.error)?.message ?? "Unknown error"} />
    );
  }

  const participants = operations.data?.participants ?? [];
  const teams = operations.data?.teams ?? [];
  const lookingForTeam = participants.filter((participant) => participant.lookingForTeam);
  const editable = section === "requirements" || section === "settings";
  // Shown at the top and again at the bottom, so long forms can be saved from either end.
  const saveButton = (
    <ActionButton
      tone="primary"
      disabled={!configuration || saveConfiguration.isPending}
      onClick={() =>
        saveConfiguration.mutate(undefined, {
          onSuccess: () =>
            post(section === "requirements" ? "Requirements saved." : "Settings saved."),
        })
      }
    >
      {saveConfiguration.isPending ? "Saving…" : "Save changes"}
    </ActionButton>
  );

  return (
    <div className={`mx-auto grid gap-10 ${editable ? "max-w-2xl" : "max-w-5xl"}`}>
      <div className="grid gap-3">
        <ScreenHead title={sectionTitle[section]} actions={editable ? saveButton : undefined} />
        {saveConfiguration.isError ? (
          <ErrorState message={saveConfiguration.error.message} />
        ) : null}
        {editable && !configuration ? <Notice tone="warn">No timeline yet.</Notice> : null}
      </div>

      {section === "requirements" && configuration ? (
        <>
          {(["area", "tool"] as const).map((kind) => (
            <Pane
              key={kind}
              title={kind === "area" ? "areas" : "tools"}
              meta={
                configuration.requirements.filter(
                  (requirement) => (kind === "area") === isArea(requirement.skill),
                ).length
              }
            >
              <RequirementsEditor
                value={configuration.requirements}
                onChange={(requirements) => patch({ requirements })}
                keepOne
                kind={kind}
              />
            </Pane>
          ))}
          <Pane title="quotas" meta={configuration.quotas.length}>
            <QuotaBuilder value={configuration.quotas} onChange={(quotas) => patch({ quotas })} />
          </Pane>
          <Pane title="college aliases" meta={Object.keys(configuration.collegeAliases).length}>
            <AliasEditor
              value={configuration.collegeAliases}
              onChange={(collegeAliases) => patch({ collegeAliases })}
            />
          </Pane>
        </>
      ) : null}

      {section === "participants" ? (
        <Pane
          title="participants"
          meta={`${participants.length} registered · ${lookingForTeam.length} looking`}
          flush
        >
          {participants.length ? (
            <div className="table-scroll">
              <table className="tui-table cards">
                <caption className="sr-only">Participants in {event.data?.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">participant</th>
                    <th scope="col">college</th>
                    <th scope="col">profile</th>
                    <th scope="col">application</th>
                    <th scope="col">team</th>
                  </tr>
                </thead>
                <tbody>
                  {participants.map((participant) => (
                    <tr key={participant.registrationId}>
                      <th scope="row" data-label="participant" className="font-bold">
                        <span className="flex items-center gap-x-3">
                          <Avatar login={participant.github} size={32} />
                          <span>
                            {participant.name}
                            <span className="dim block font-normal">
                              @{participant.github}
                              {participant.verified ? null : (
                                <span className="text-warn"> unverified</span>
                              )}
                            </span>
                          </span>
                        </span>
                      </th>
                      <td data-label="college" className="wrap">
                        {participant.college ?? <span className="dim">—</span>}
                      </td>
                      <td data-label="profile">
                        <StateTag state={participant.profileStatus} />
                      </td>
                      <td data-label="application">
                        <StateTag state={participant.status} />
                      </td>
                      <td data-label="team">
                        {participant.teamId ? (
                          "yes"
                        ) : (
                          <span className="dim">
                            {participant.lookingForTeam ? "looking" : "no"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-6 pb-3">
              <EmptyState title="No registrations yet" />
            </div>
          )}
        </Pane>
      ) : null}

      {section === "participants" && eventId && corrections.data?.length ? (
        <div className="grid gap-3">
          <p className="text-warn">~ {plural(corrections.data.length, "profile report")} open</p>
          <Details summary="profile reports" meta={corrections.data.length}>
            <ul className="grid gap-6">
              {corrections.data.map((correction) => (
                <CorrectionRow key={correction.id} eventId={eventId} correction={correction} />
              ))}
            </ul>
          </Details>
        </div>
      ) : null}
      {section === "participants" && corrections.isError ? (
        <ErrorState message={corrections.error.message} retry={() => void corrections.refetch()} />
      ) : null}

      {section === "teams" ? (
        <>
          <Pane title="teams" meta={String(teams.length)} flush>
            {teams.length ? (
              <div className="table-scroll">
                <table className="tui-table cards">
                  <caption className="sr-only">Teams in {event.data?.name}</caption>
                  <thead>
                    <tr>
                      <th scope="col">team</th>
                      <th scope="col">members</th>
                      <th scope="col">profiles</th>
                      <th scope="col">state</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map((team) => (
                      <tr key={team.id}>
                        <th scope="row" data-label="team" className="font-bold">
                          {team.name}
                        </th>
                        <td data-label="members" className="wrap">
                          <span>
                            {team.members.map((member, index) => (
                              <span key={member.id}>
                                {index ? <span className="dim">, </span> : null}
                                {member.name}
                                {member.id === team.captainId ? (
                                  <span className="dim" title="captain">
                                    {" "}
                                    ★<span className="sr-only">captain</span>
                                  </span>
                                ) : null}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td data-label="profiles" className="num">
                          {team.members.filter((member) => member.profileStatus === "ready").length}
                          /{team.members.length} ready
                        </td>
                        <td data-label="state">
                          <StateTag state={team.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-6 pb-3">
                <EmptyState title="No teams yet" />
              </div>
            )}
          </Pane>

          {lookingForTeam.length ? (
            <Details summary="looking for a team" meta={lookingForTeam.length}>
              <ul className="grid gap-2">
                {lookingForTeam.map((participant) => (
                  <li key={participant.personId}>
                    <span className="font-bold">{participant.name}</span>{" "}
                    {participant.topSkills.length ? (
                      splitSkills(participant.topSkills, (id) => id).map((group, index) => (
                        <span
                          className={group.label === "tools" ? "dim" : undefined}
                          key={group.label}
                        >
                          {index > 0 ? " · " : ""}
                          {group.items.map(skillLabel).join(", ")}
                        </span>
                      ))
                    ) : (
                      <span className="dim">profile building</span>
                    )}
                    {participant.college ? (
                      <span className="dim"> · {participant.college}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Details>
          ) : null}
        </>
      ) : null}

      {section === "settings" && configuration ? (
        <>
          <FormSection title="public page">
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field label="Event name" required>
                <TextInput
                  value={configuration.name}
                  onChange={(change) => patch({ name: change.target.value })}
                />
              </Field>
              <Field label="Tagline" required>
                <TextInput
                  value={configuration.tagline}
                  maxLength={140}
                  onChange={(change) => patch({ tagline: change.target.value })}
                />
              </Field>
              <Field label="Description" hint="Markdown" className="sm:col-span-2" required>
                <TextArea
                  value={configuration.description}
                  rows={6}
                  onChange={(change) => patch({ description: change.target.value })}
                />
              </Field>
              <Field label="Mode">
                <SelectInput
                  value={configuration.mode}
                  onChange={(change) =>
                    patch({ mode: change.target.value as EventConfigurationInput["mode"] })
                  }
                >
                  <option value="in_person">In person</option>
                  <option value="online">Online</option>
                  <option value="hybrid">Hybrid</option>
                </SelectInput>
              </Field>
              <Field label="Venue" required={configuration.mode !== "online"}>
                <TextInput
                  value={configuration.venue ?? ""}
                  onChange={(change) => patch({ venue: change.target.value })}
                />
              </Field>
            </div>
          </FormSection>

          <FormSection title="dates" meta="IST">
            <TimelineFields
              value={
                Object.fromEntries(
                  timelineFields.map(([key]) => [
                    key,
                    isoToIstDateTime(configuration.timeline[key]),
                  ]),
                ) as Record<TimelineKey, string>
              }
              onChange={(key, value) => {
                // A cleared datetime-local input has no instant to store.
                if (!value) return;
                setConfiguration((current) =>
                  current
                    ? {
                        ...current,
                        timeline: { ...current.timeline, [key]: istDateTimeToIso(value) },
                      }
                    : current,
                );
              }}
            />
          </FormSection>

          <FormSection title="teams">
            <TeamSizeFields
              min={configuration.teamSize.min}
              max={configuration.teamSize.max}
              capacity={configuration.capacity}
              onMin={(min) => patch({ teamSize: { ...configuration.teamSize, min } })}
              onMax={(max) => patch({ teamSize: { ...configuration.teamSize, max } })}
              onCapacity={(capacity) => patch({ capacity })}
            />
          </FormSection>

          <FormSection title="links" meta={`${configuration.links.length} of 12`}>
            {configuration.links.map((link, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: links are edited in place; a content key would remount the input on every keystroke
                key={index}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]"
              >
                <TextInput
                  aria-label={`Link ${index + 1} label`}
                  placeholder="Label"
                  value={link.label}
                  className="col-span-2 sm:col-span-1"
                  onChange={(change) => updateLink(index, { label: change.target.value })}
                />
                <TextInput
                  aria-label={`Link ${index + 1} URL`}
                  type="url"
                  value={link.url}
                  onChange={(change) => updateLink(index, { url: change.target.value })}
                />
                <TextAction
                  tone="danger"
                  aria-label={`Remove link ${index + 1}`}
                  onClick={() =>
                    patch({
                      links: configuration.links.filter(
                        (_, candidateIndex) => candidateIndex !== index,
                      ),
                    })
                  }
                >
                  remove
                </TextAction>
              </div>
            ))}
            <div>
              <ActionButton
                disabled={configuration.links.length >= 12}
                onClick={() =>
                  patch({ links: [...configuration.links, { label: "", url: "https://" }] })
                }
              >
                Add link
              </ActionButton>
            </div>
          </FormSection>
        </>
      ) : null}
      {editable && configuration ? (
        <div className="grid justify-items-end gap-3">
          {saveConfiguration.isError ? (
            <ErrorState message={saveConfiguration.error.message} />
          ) : null}
          {saveButton}
        </div>
      ) : null}
    </div>
  );
}
