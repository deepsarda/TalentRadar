import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ReportProblem } from "../components/ReportProblem";
import { useStatusLine } from "../components/statusline";
import {
  ActionAnchor,
  ActionButton,
  ActionLink,
  Bar,
  CheckRow,
  countdown,
  Details,
  EmptyState,
  ErrorState,
  Field,
  formatDate,
  formatDateTime,
  KeyValue,
  LoadingState,
  LogView,
  Notice,
  Pane,
  Prompt,
  RequiredMark,
  ScreenHead,
  SelectInput,
  SkillGroups,
  Stat,
  StateTag,
  Status,
  Steps,
  TextAction,
  TextInput,
} from "../components/ui";
import {
  createParticipantTeam,
  deleteParticipantAccount,
  getCurrentUser,
  getParticipantApplication,
  getParticipantOverview,
  getParticipantProfile,
  getParticipantRepositories,
  getParticipantRsvp,
  getParticipantTeam,
  getParticipantTeamFit,
  getPublicEvent,
  getPublicEvents,
  getTeammateSuggestions,
  joinParticipantTeam,
  leaveParticipantTeam,
  type ParticipantOverview,
  participantDataExportUrl,
  rebuildParticipantProfile,
  removeParticipantTeamMember,
  resetParticipantTeamInvite,
  respondParticipantRsvp,
  revokeGithubAccess,
  saveParticipantDetails,
  setParticipantLookingForTeam,
  submitParticipantApplication,
  submitParticipantTeam,
  uploadParticipantCv,
} from "../lib/api";
import { evidenceUrl } from "../lib/evidence";
import { skillLabel, splitSkills } from "../lib/skills";

// CV first, so the details step can prefill what the CV states (spec: participant flow step 3).
const onboardingSteps = ["cv", "details", "repos", "review"] as const;
type DetailField = "name" | "college" | "year" | "branch";

/** Section label used between stacked blocks on single-column screens. */
function SectionLabel({ children }: { children: string }) {
  return <h2 className="font-display text-dim text-xl">{children}</h2>;
}

function SignInNotice({ returnTo }: { returnTo?: string }) {
  return (
    <Notice
      action={
        <ActionLink
          to={returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login"}
          tone="primary"
        >
          Sign in with GitHub
        </ActionLink>
      }
    >
      You're signed out.
    </Notice>
  );
}

/** The single most useful thing to do next, or null when nothing needs the participant. */
function nextStep(
  overview: ParticipantOverview,
): { text: string; label: string; to: string } | null {
  const { applications, profile } = overview;
  const selected = applications.find((application) => application.status === "selected");
  if (selected) {
    return {
      text: `${selected.eventName} selected your team.`,
      label: "RSVP",
      to: `/participant/applications/${selected.id}`,
    };
  }
  // A profile needs no event, so it comes first; applying later reuses it.
  if (!profile)
    return { text: "Profile not built.", label: "Build it", to: "/participant/onboarding" };
  if (applications.length === 0)
    return { text: "No applications yet.", label: "Find an event", to: "/" };
  if (profile.status === "failed") {
    return { text: "Profile build failed.", label: "See why", to: "/participant/profile" };
  }
  const draft = applications.find((application) => application.status === "draft");
  if (draft) {
    return {
      text: `${draft.eventName} isn't submitted yet.`,
      label: "Open",
      to: `/participant/applications/${draft.id}`,
    };
  }
  return null;
}

/** One clickable row: `name  [STATE]  date  ›`. */
const rowClass =
  "grid grid-cols-[minmax(0,1fr)_auto_2ch] items-center gap-x-4 px-3 py-2.5 no-underline hover:bg-raised sm:grid-cols-[minmax(0,1fr)_auto_7rem_2ch]";

export function ParticipantDashboard() {
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const overview = useQuery({
    queryKey: ["participant-overview"],
    queryFn: getParticipantOverview,
    enabled: Boolean(account.data),
    retry: false,
  });
  const applications = overview.data?.applications ?? [];
  const signedOut = !account.data && !account.isPending;
  const next = overview.data ? nextStep(overview.data) : null;
  const profile = overview.data?.profile;
  const firstName = (overview.data?.account.name ?? account.data?.name ?? "").split(" ")[0];

  return (
    <div className="mx-auto grid max-w-3xl gap-10">
      <ScreenHead title={firstName ? `Hi, ${firstName}` : "Hi"} />

      {signedOut ? (
        <EmptyState
          title="Sign in to see your applications"
          action={
            <ActionLink to="/login" tone="primary">
              Sign in with GitHub
            </ActionLink>
          }
        />
      ) : null}
      {overview.isError ? (
        <ErrorState message={overview.error.message} retry={() => void overview.refetch()} />
      ) : null}
      {overview.isPending && account.data ? <LoadingState label="loading" /> : null}

      {next ? (
        <div className="flex flex-wrap items-center justify-between gap-4 border border-(--frame) px-6 py-5">
          <p className="font-display text-2xl">{next.text}</p>
          <ActionLink to={next.to} tone="primary">
            {next.label}
          </ActionLink>
        </div>
      ) : null}

      {applications.length > 0 ? (
        <section className="grid gap-2">
          <SectionLabel>applications</SectionLabel>
          <ul className="-mx-3 grid">
            {applications.map((application) => (
              <li key={application.id}>
                <Link className={rowClass} to={`/participant/applications/${application.id}`}>
                  <span className="truncate font-bold">{application.eventName}</span>
                  <StateTag state={application.status} />
                  <span className="dim hidden sm:block">{formatDate(application.updatedAt)}</span>
                  <span className="text-accent" aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {overview.data ? (
        <section className="grid gap-2">
          <SectionLabel>profile</SectionLabel>
          {profile?.summary ? (
            <p className="max-w-[72ch] text-lg leading-snug">{profile.summary}</p>
          ) : null}
          {profile && profile.skills.length > 0 ? (
            <div className="grid gap-6 py-2 sm:grid-cols-2">
              {splitSkills(profile.skills, (skill) => skill.id).map((group) => (
                <div className="grid content-start gap-1" key={group.label}>
                  <p className="dim text-sm">top {group.label}</p>
                  {group.items.slice(0, group.label === "areas" ? 3 : 5).map((skill) => (
                    <p
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-[1ch]"
                      key={skill.id}
                    >
                      <span className="truncate">{skillLabel(skill.id)}</span>
                      <Bar value={skill.level} cells={6} label={skillLabel(skill.id)} />
                    </p>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
          <Link
            className={`-mx-3 ${rowClass}`}
            to={profile ? "/participant/profile" : "/participant/onboarding"}
          >
            <span className="dim">{profile ? `version ${profile.version}` : "not built"}</span>
            {profile ? <StateTag state={profile.status} /> : <span />}
            <span className="hidden sm:block">{profile ? "see profile" : "build"}</span>
            <span className="text-accent" aria-hidden="true">
              ›
            </span>
          </Link>
        </section>
      ) : null}
    </div>
  );
}

export function ParticipantOnboarding() {
  const { slug: slugFromLink } = useParams();
  // Opened from a generic link ("Build it", "Change inputs") there is no event yet; the review
  // step then asks which open event to apply to.
  const [chosenSlug, setChosenSlug] = useState("");
  const slug = slugFromLink ?? (chosenSlug || undefined);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [consented, setConsented] = useState(false);
  const [details, setDetails] = useState({ name: "", college: "", year: "", branch: "" });
  const [selectedRepositories, setSelectedRepositories] = useState<string[]>([]);
  const [uploadedCv, setUploadedCv] = useState<{ id: string; name: string; size: number } | null>(
    null,
  );
  // Fields prefilled from the CV (marked until the person edits them), and fields they typed.
  const [fromCv, setFromCv] = useState<Partial<Record<DetailField, true>>>({});
  const [edited, setEdited] = useState<Partial<Record<DetailField, true>>>({});
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const overview = useQuery({
    queryKey: ["participant-overview"],
    queryFn: getParticipantOverview,
    enabled: Boolean(account.data),
    retry: false,
  });
  // Only for the title: the event name, shared with the event page's cache.
  const event = useQuery({
    queryKey: ["public-event", slug],
    queryFn: () => getPublicEvent(slug ?? ""),
    enabled: Boolean(slug),
    retry: false,
  });
  const openEvents = useQuery({
    queryKey: ["public-events"],
    queryFn: getPublicEvents,
    enabled: !slugFromLink,
    select: (events) => events.filter((candidate) => candidate.status === "open"),
  });
  const repositories = useQuery({
    queryKey: ["participant-repositories"],
    queryFn: getParticipantRepositories,
    enabled: Boolean(account.data) && step >= 2,
    retry: false,
  });
  const uploadCv = useMutation({
    mutationFn: uploadParticipantCv,
    onSuccess: async ({ cv, details: found }) => {
      setUploadedCv(cv);
      // A first-time applicant's fields hold only GitHub defaults, so the CV wins there; a
      // returning one's saved details win. Anything the person typed is never overwritten.
      const firstTime = !overview.data?.account.college;
      const applied: Partial<Record<DetailField, true>> = {};
      const next = { ...details };
      for (const field of ["name", "college", "year", "branch"] as const) {
        const value = found[field];
        if (value && !edited[field] && (firstTime || !details[field])) {
          next[field] = value;
          applied[field] = true;
        }
      }
      setDetails(next);
      setFromCv(applied);
      await queryClient.invalidateQueries({ queryKey: ["participant-overview"] });
    },
  });
  const saveDetails = useMutation({
    mutationFn: saveParticipantDetails,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["participant-overview"] }),
  });
  // Returning participants start from the repos their last profile used.
  const lastProfile = useQuery({
    queryKey: ["participant-profile"],
    queryFn: getParticipantProfile,
    enabled: Boolean(account.data),
    retry: false,
  });
  const [reposPrefilled, setReposPrefilled] = useState(false);
  useEffect(() => {
    if (reposPrefilled || !repositories.data || !lastProfile.isFetched) return;
    setReposPrefilled(true);
    const eligible = new Set(
      repositories.data.filter((repo) => repo.eligible).map((repo) => repo.fullName),
    );
    const previous = (lastProfile.data?.profile.repos ?? [])
      .map((repo) => repo.fullName)
      .filter((fullName) => eligible.has(fullName))
      .slice(0, 6);
    if (previous.length > 0) {
      setSelectedRepositories((current) => (current.length > 0 ? current : previous));
    }
  }, [reposPrefilled, repositories.data, lastProfile.isFetched, lastProfile.data]);
  // With an event this applies (and builds); without one it only builds the profile, which
  // carries over to later applications.
  const submitApplication = useMutation({
    mutationFn: async () => {
      if (!slug) {
        await rebuildParticipantProfile({ repositories: selectedRepositories, consent: true });
        return null;
      }
      return submitParticipantApplication(slug, {
        details,
        repositories: selectedRepositories,
        consent: true,
      });
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["participant-overview"] }),
        queryClient.invalidateQueries({ queryKey: ["participant-profile"] }),
      ]);
      navigate(
        result ? `/participant/applications/${result.application.id}` : "/participant/profile",
      );
    },
  });

  useEffect(() => {
    if (!overview.data) return;
    setDetails((current) => ({
      name: current.name || overview.data.account.name,
      college: current.college || overview.data.account.college || "",
      year: current.year || overview.data.account.year || "",
      branch: current.branch || overview.data.account.branch || "",
    }));
  }, [overview.data]);

  const updateDetail = (field: DetailField, value: string) => {
    setDetails((current) => ({ ...current, [field]: value }));
    setEdited((current) => ({ ...current, [field]: true }));
    setFromCv(({ [field]: _removed, ...rest }) => rest);
  };
  const cvHint = (field: DetailField) => (fromCv[field] ? { hint: "from your CV" } : {});

  const storedCv = overview.data?.account.cv;
  const cvReady = Boolean(uploadedCv || overview.data?.account.hasCv);
  const stepValid = [
    cvReady,
    Object.values(details).every((value) => value.trim().length > 0),
    selectedRepositories.length > 0 && selectedRepositories.length <= 6,
    consented && cvReady && selectedRepositories.length > 0,
  ];
  const lastStep = step === onboardingSteps.length - 1;
  // Why Apply is disabled, in a few words, so the button never just sits there greyed out.
  const applyBlocker = !cvReady
    ? "upload a CV"
    : selectedRepositories.length === 0
      ? "pick a repo"
      : !consented
        ? "tick the agreement"
        : null;

  const toggleRepository = (fullName: string) => {
    setSelectedRepositories((current) =>
      current.includes(fullName)
        ? current.filter((repository) => repository !== fullName)
        : current.length < 6
          ? [...current, fullName]
          : current,
    );
  };

  return (
    <div className="mx-auto grid max-w-2xl gap-10">
      <ScreenHead title={slug ? `Apply to ${event.data?.name ?? slug}` : "Build your profile"} />

      {!account.data && !account.isPending ? (
        <SignInNotice {...(slug ? { returnTo: `/participant/apply/${slug}` } : {})} />
      ) : null}

      <Steps steps={onboardingSteps} current={step} onSelect={setStep} />

      <div className="grid gap-6">
        <Pane
          title={
            step === 2 ? (
              <>
                repos
                <RequiredMark />
              </>
            ) : (
              (onboardingSteps[step] ?? onboardingSteps[0])
            )
          }
          meta={step === 2 ? `${selectedRepositories.length} / 6` : undefined}
          flush={step === 2 && Boolean(repositories.data?.length)}
          active
        >
          {step === 1 ? (
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field label="Full name" required {...cvHint("name")}>
                <TextInput
                  value={details.name}
                  onChange={(event) => updateDetail("name", event.target.value)}
                  autoComplete="name"
                />
              </Field>
              <Field label="College" required {...cvHint("college")}>
                <TextInput
                  value={details.college}
                  onChange={(event) => updateDetail("college", event.target.value)}
                  autoComplete="organization"
                />
              </Field>
              <Field label="Year of study" required {...cvHint("year")}>
                <SelectInput
                  value={details.year}
                  onChange={(event) => updateDetail("year", event.target.value)}
                >
                  <option value="">Select</option>
                  <option value="1">First year</option>
                  <option value="2">Second year</option>
                  <option value="3">Third year</option>
                  <option value="4">Fourth year</option>
                  <option value="5+">Fifth year or later</option>
                  <option value="graduate">Graduate</option>
                </SelectInput>
              </Field>
              <Field label="Branch" required {...cvHint("branch")}>
                <TextInput
                  value={details.branch}
                  onChange={(event) => updateDetail("branch", event.target.value)}
                />
              </Field>
            </div>
          ) : null}

          {step === 0 ? (
            <div className="grid gap-4">
              <Field label="CV file" hint="PDF, max 2 MB" required={!cvReady}>
                <input
                  id="participant-cv"
                  className="file-input w-full"
                  type="file"
                  accept="application/pdf,.pdf"
                  disabled={uploadCv.isPending}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) uploadCv.mutate(file);
                  }}
                />
              </Field>
              {uploadCv.isPending ? <LoadingState label="uploading" /> : null}
              {uploadedCv ? (
                <p>
                  <Status tone="ok">uploaded</Status> {uploadedCv.name}
                </p>
              ) : storedCv ? (
                <p>
                  <Status tone="ok">on file</Status> {storedCv.name}
                  <span className="dim">
                    {" "}
                    · {Math.max(1, Math.round(storedCv.size / 1024))} KB · uploaded{" "}
                    {formatDate(storedCv.uploadedAt)}
                  </span>
                </p>
              ) : overview.data?.account.hasCv ? (
                <p>
                  <Status tone="ok">on file</Status>
                </p>
              ) : null}
              {uploadCv.isError ? (
                <Notice tone="error" tag="error">
                  {uploadCv.error.message}
                </Notice>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <>
              {!account.data ? <p className="dim">Sign in first.</p> : null}
              {repositories.isPending && account.data ? <LoadingState label="loading" /> : null}
              {repositories.isError ? (
                <ErrorState
                  message={repositories.error.message}
                  retry={() => void repositories.refetch()}
                />
              ) : null}
              {repositories.data?.length === 0 ? (
                <EmptyState title="No public repositories" />
              ) : null}
              {repositories.data && repositories.data.length > 0 ? (
                <ul className="grid">
                  {repositories.data.map((repository) => {
                    const checked = selectedRepositories.includes(repository.fullName);
                    const full = !checked && selectedRepositories.length >= 6;
                    const usable = repository.eligible && !full;
                    return (
                      <li key={repository.fullName}>
                        <label
                          className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-6 py-2 ${
                            usable ? "cursor-pointer hover:bg-raised" : "cursor-not-allowed"
                          } ${repository.eligible ? "" : "opacity-60"}`}
                        >
                          <input
                            type="checkbox"
                            className="checkbox tui-check checkbox-sm"
                            checked={checked}
                            disabled={!usable}
                            onChange={() => toggleRepository(repository.fullName)}
                          />
                          <span className="grid min-w-0">
                            <span className={`truncate ${checked ? "text-accent" : ""}`}>
                              {repository.fullName}
                            </span>
                            {repository.exclusionReason ? (
                              <span className="text-warn text-sm">
                                <span aria-hidden="true">✗ </span>
                                {repository.exclusionReason}
                              </span>
                            ) : null}
                          </span>
                          <span className="dim text-sm">
                            {repository.language ?? ""}
                            {repository.fork ? " · fork" : ""}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </>
          ) : null}

          {step === 3 ? (
            <div className="grid gap-6">
              <KeyValue
                items={[
                  ["name", details.name || "missing"],
                  ["college", details.college || "missing"],
                  ["CV", cvReady ? (uploadedCv?.name ?? storedCv?.name ?? "on file") : "missing"],
                  [
                    "repos",
                    selectedRepositories.length > 0
                      ? selectedRepositories.map((name) => name.split("/").pop()).join(", ")
                      : "none",
                  ],
                ]}
              />
              {slugFromLink ? null : (
                <Field label="Event" hint="optional">
                  <SelectInput
                    value={chosenSlug}
                    onChange={(change) => setChosenSlug(change.target.value)}
                  >
                    <option value="">
                      {openEvents.isPending
                        ? "loading…"
                        : openEvents.data?.length
                          ? "none — just build my profile"
                          : "no open events — just build my profile"}
                    </option>
                    {openEvents.data?.map((open) => (
                      <option value={open.slug} key={open.id}>
                        {open.name}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              )}
              <CheckRow checked={consented} onChange={setConsented} required>
                I agree to automated evaluation
              </CheckRow>
            </div>
          ) : null}
        </Pane>

        <div className="flex flex-wrap justify-between gap-2">
          <ActionButton
            tone="quiet"
            disabled={step === 0}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
          >
            Back
          </ActionButton>
          {lastStep ? (
            <span className="flex flex-wrap items-center gap-4">
              {applyBlocker ? <span className="dim">~ {applyBlocker}</span> : null}
              <ActionButton
                tone="primary"
                disabled={!stepValid.every(Boolean) || submitApplication.isPending}
                onClick={() => submitApplication.mutate()}
              >
                {slug
                  ? submitApplication.isPending
                    ? "Applying…"
                    : "Apply"
                  : submitApplication.isPending
                    ? "Building…"
                    : "Build profile"}
              </ActionButton>
            </span>
          ) : (
            <ActionButton
              tone="primary"
              disabled={!stepValid[step] || saveDetails.isPending}
              onClick={() => {
                const next = () =>
                  setStep((value) => Math.min(onboardingSteps.length - 1, value + 1));
                // Details are remembered as soon as they're confirmed, not only when applying.
                if (step === 1 && account.data) saveDetails.mutate(details, { onSuccess: next });
                else next();
              }}
            >
              {saveDetails.isPending ? "Saving…" : "Continue"}
            </ActionButton>
          )}
        </div>
        {saveDetails.isError ? <ErrorState message={saveDetails.error.message} /> : null}
        {submitApplication.isError ? (
          <Notice tone="error" tag="error">
            {submitApplication.error.message}
          </Notice>
        ) : null}
      </div>
    </div>
  );
}

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

const logTime = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});

export function ParticipantProfilePage() {
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const login = account.data?.login;
  const queryClient = useQueryClient();
  const { post } = useStatusLine();
  const cvInputRef = useRef<HTMLInputElement>(null);
  // Spec: "Replace CV" re-runs the profile build with the new CV and the same repositories.
  const replaceCv = useMutation({
    mutationFn: async (file: File) => {
      await uploadParticipantCv(file);
      return rebuildParticipantProfile();
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["participant-profile"] });
      post(result.profile.reused ? "CV unchanged." : "Rebuilding profile.");
    },
  });
  // Same repositories and CV; a failed profile is never reused, so this always starts a new build.
  const rebuild = useMutation({
    mutationFn: () => rebuildParticipantProfile(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["participant-profile"] });
      post("Rebuilding profile.");
    },
  });
  const profile = useQuery({
    queryKey: ["participant-profile"],
    queryFn: getParticipantProfile,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.profile.status === "pending" ||
      query.state.data?.profile.status === "building"
        ? 5000
        : false,
  });
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const allSkills = profile.data?.profile.skills ?? [];
  // Areas (taxonomy domains) first, then tools, each strongest first; the filter narrows both.
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const visible = allSkills
      .filter(
        (skill) => !needle || `${skillLabel(skill.id)} ${skill.id}`.toLowerCase().includes(needle),
      )
      .sort((left, right) => right.level - left.level);
    return splitSkills(visible, (skill) => skill.id);
  }, [allSkills, filter]);
  const skills = groups.flatMap((group) => group.items);
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? skills[0];
  const progress = (profile.data?.jobs ?? [])
    .flatMap((job) => job.progress)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

  // j/k and arrow keys walk the skills list, like lazygit, unless focus is in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/" && filterRef.current) {
        event.preventDefault();
        filterRef.current.focus();
        return;
      }
      const step =
        event.key === "j" || event.key === "ArrowDown"
          ? 1
          : event.key === "k" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (step === 0 || skills.length === 0) return;
      event.preventDefault();
      const index = skills.findIndex((skill) => skill.id === selectedSkill?.id);
      const next = skills[Math.max(0, Math.min(skills.length - 1, index + step))];
      if (next) {
        setSelectedSkillId(next.id);
        document.getElementById(`skill-${next.id}`)?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skills, selectedSkill?.id]);

  if (profile.isPending) return <LoadingState label="loading profile" />;
  if (profile.isError) {
    return (
      <div className="mx-auto grid max-w-2xl gap-10">
        <ScreenHead title="Profile" />
        <EmptyState
          title="No profile yet"
          action={
            <ActionLink to="/participant/onboarding" tone="primary">
              Build profile
            </ActionLink>
          }
        />
      </div>
    );
  }

  const data = profile.data.profile;
  const live = data.status === "pending" || data.status === "building";

  return (
    <div className="mx-auto grid max-w-6xl gap-10">
      <ScreenHead
        title="Profile"
        actions={
          <div className="flex flex-wrap items-center gap-4">
            <StateTag state={data.status} />
            <span className="dim">v{data.version}</span>
            <input
              ref={cvInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              aria-label="New CV (PDF)"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) replaceCv.mutate(file);
                event.target.value = "";
              }}
            />
            {data.status === "failed" ? (
              <ActionButton
                tone="primary"
                disabled={rebuild.isPending}
                onClick={() => rebuild.mutate()}
              >
                {rebuild.isPending ? "Starting…" : "Rebuild"}
              </ActionButton>
            ) : null}
            <ActionButton
              disabled={replaceCv.isPending || live}
              onClick={() => cvInputRef.current?.click()}
            >
              {replaceCv.isPending ? "Uploading…" : "Replace CV"}
            </ActionButton>
            <ActionLink to="/participant/onboarding">Change inputs</ActionLink>
          </div>
        }
      />
      {data.summary ? <p className="max-w-[72ch] text-lg leading-snug">{data.summary}</p> : null}
      {replaceCv.isError || rebuild.isError ? (
        <Notice tone="error" tag="error">
          {(replaceCv.error ?? rebuild.error)?.message}
        </Notice>
      ) : null}

      {allSkills.length === 0 ? (
        <EmptyState title={data.status === "failed" ? "Build failed" : "Building your profile"}>
          {data.error}
        </EmptyState>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Pane
            title="skills"
            meta={allSkills.length}
            foot={allSkills.length > 8 ? "/ filter · j/k move" : "j/k move"}
            flush
          >
            {allSkills.length > 8 ? (
              <div className="px-4 pb-2">
                <input
                  ref={filterRef}
                  className="input tui-input"
                  aria-label="Filter skills"
                  placeholder="filter…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setFilter("");
                      event.currentTarget.blur();
                    }
                  }}
                />
              </div>
            ) : null}
            <div className="max-h-[60vh] overflow-y-auto">
              {groups.length === 0 ? <p className="dim px-6 py-2">No match.</p> : null}
              {groups.map((group) => (
                <div key={group.label}>
                  <p className="dim px-6 pt-2 pb-1 text-sm">
                    {group.label} <span className="text-xs">{group.items.length}</span>
                  </p>
                  <div className="tui-list" role="listbox" aria-label={`Skills: ${group.label}`}>
                    {group.items.map((skill) => {
                      const selected = skill.id === selectedSkill?.id;
                      return (
                        <button
                          type="button"
                          role="option"
                          id={`skill-${skill.id}`}
                          aria-selected={selected}
                          key={skill.id}
                          className="py-1.5!"
                          onClick={() => setSelectedSkillId(skill.id)}
                        >
                          <span className="marker" aria-hidden="true">
                            {selected ? "▸" : ""}
                          </span>
                          <span className="truncate">{skillLabel(skill.id)}</span>
                          <Bar value={skill.level} cells={6} label={skillLabel(skill.id)} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Pane>

          {selectedSkill ? (
            <Pane title={skillLabel(selectedSkill.id)} active className="lg:sticky lg:top-4">
              <div className="grid gap-6">
                <div className="flex items-end gap-6">
                  <Stat value={selectedSkill.level.toFixed(1)} label="level of 5" />
                  <StateTag
                    state={selectedSkill.confidence}
                    label={`${selectedSkill.confidence} confidence`}
                  />
                </div>

                {selectedSkill.evidence.length === 0 ? (
                  <p className="dim">No files cited.</p>
                ) : (
                  <ul className="grid gap-4">
                    {selectedSkill.evidence.map((evidence) => (
                      <li className="grid gap-1" key={`${evidence.repository}-${evidence.path}`}>
                        <a
                          className="tui-link break-all text-fg!"
                          href={evidenceUrl(evidence)}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {evidence.path} ↗
                        </a>
                        <span className="dim border-line border-l pl-3">{evidence.note}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {selectedSkill.thought ? (
                  <div className="grid gap-1">
                    <h3 className="dim font-normal">reasoning</h3>
                    <p>{selectedSkill.thought}</p>
                  </div>
                ) : null}
                <div>
                  <ReportProblem key={selectedSkill.id} skill={selectedSkill.id} />
                </div>
              </div>
            </Pane>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap gap-x-10 gap-y-4 [&>[open]]:basis-full">
        <Details
          summary="build log"
          meta={live ? "live" : `${progress.length} events`}
          open={live || data.status === "failed"}
        >
          <div className="grid gap-2">
            <Prompt
              command={`talentradar profile build @${login ?? "me"}${live ? " --follow" : ""}`}
              {...(login ? { user: login } : {})}
            />
            {progress.length > 0 ? (
              <LogView
                live={live}
                lines={progress.map((event) => ({
                  key: `${event.at}-${event.code}`,
                  text: `${logTime.format(new Date(event.at))}  ${event.message}`,
                  ...(/fail|error/i.test(event.code) ? { tone: "error" as const } : {}),
                }))}
              />
            ) : (
              <p className="dim">Queued.</p>
            )}
          </div>
        </Details>
        <Details summary="repositories" meta={data.repos.length}>
          <ul className="grid gap-1">
            {data.repos.map((repository) => (
              <li className="flex flex-wrap gap-x-[1ch]" key={repository.fullName}>
                <span aria-hidden="true" className={repository.included ? "text-accent" : "dim"}>
                  {repository.included ? "✓" : "·"}
                </span>
                <span className={repository.included ? "" : "dim"}>
                  {repository.fullName}
                  {repository.included ? null : " (not used)"}
                </span>
              </li>
            ))}
          </ul>
        </Details>
      </div>
    </div>
  );
}

/** One hackathon's team: a person has exactly one per event, so it lives on that application. */
function TeamSection({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient();
  const { post } = useStatusLine();
  const [mode, setMode] = useState<"choose" | "create" | "join">("choose");
  const [teamName, setTeamName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const context = useQuery({
    queryKey: ["participant-team", eventId],
    queryFn: () => getParticipantTeam(eventId),
    retry: false,
  });

  const refreshTeam = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["participant-team", eventId] }),
      queryClient.invalidateQueries({ queryKey: ["participant-overview"] }),
      queryClient.invalidateQueries({ queryKey: ["participant-application"] }),
    ]);
  };
  const createTeam = useMutation({
    mutationFn: () => createParticipantTeam(context.data?.event.id ?? "", teamName),
    onSuccess: async () => {
      post("Team created.");
      setTeamName("");
      await refreshTeam();
    },
  });
  const joinTeam = useMutation({
    mutationFn: () => joinParticipantTeam(inviteCode),
    onSuccess: async () => {
      post("Joined the team.");
      setInviteCode("");
      await refreshTeam();
    },
  });
  const lookingForTeam = useMutation({
    mutationFn: (enabled: boolean) => setParticipantLookingForTeam(eventId, enabled),
    onSuccess: async (enabled) => {
      post(enabled ? "Listed as looking." : "No longer listed.");
      await refreshTeam();
    },
  });
  const submitTeam = useMutation({
    mutationFn: (id: string) => submitParticipantTeam(id),
    onSuccess: async () => {
      post("Team submitted.");
      await refreshTeam();
    },
  });
  const resetInvite = useMutation({
    mutationFn: (id: string) => resetParticipantTeamInvite(id),
    onSuccess: async () => {
      post("New invite code.");
      await refreshTeam();
    },
  });
  const removeMember = useMutation({
    mutationFn: ({ id, memberId }: { id: string; memberId: string }) =>
      removeParticipantTeamMember(id, memberId),
    onSuccess: async () => {
      post("Member removed.");
      await refreshTeam();
    },
  });
  const leaveTeam = useMutation({
    mutationFn: (id: string) => leaveParticipantTeam(id),
    onSuccess: async () => {
      post("You left.");
      await refreshTeam();
    },
  });
  const mutationError =
    createTeam.error ??
    joinTeam.error ??
    lookingForTeam.error ??
    submitTeam.error ??
    resetInvite.error ??
    removeMember.error ??
    leaveTeam.error;
  const team = context.data?.team;
  const isCaptain = Boolean(team && context.data?.personId === team.captainId);
  const notReady = team?.members.find((member) => member.profileStatus !== "ready");
  const validTeamSize = Boolean(
    team &&
      context.data &&
      team.members.length >= context.data.event.teamSize.min &&
      team.members.length <= context.data.event.teamSize.max,
  );
  // The first thing stopping submission, in a few words.
  const submitBlocker = !validTeamSize
    ? `needs ${context.data?.event.teamSize.min ?? "—"}–${context.data?.event.teamSize.max ?? "—"} members`
    : notReady
      ? `${notReady.name.split(" ")[0]}'s profile is ${notReady.profileStatus === "failed" ? "failed" : "building"}`
      : null;

  if (context.isPending) return <LoadingState label="loading team" />;
  if (context.isError) {
    return <ErrorState message={context.error.message} retry={() => void context.refetch()} />;
  }

  const event = context.data.event;
  const listed = context.data.registration.lookingForTeam;
  const errorNotice = mutationError ? (
    <ErrorState
      message={mutationError instanceof Error ? mutationError.message : "The team action failed"}
    />
  ) : null;

  if (team) {
    const draft = team.status === "draft";
    return (
      <section className="grid gap-6" aria-label="Team">
        <div className="grid gap-4">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <h2 className="font-display text-3xl">
                <span className="dim">team · </span>
                {team.name}
              </h2>
              <StateTag state={team.status} />
            </div>
            {isCaptain && draft ? (
              <ActionButton
                tone="primary"
                disabled={Boolean(submitBlocker) || submitTeam.isPending}
                onClick={() => submitTeam.mutate(team.id)}
              >
                {submitTeam.isPending ? "Submitting…" : "Submit team"}
              </ActionButton>
            ) : null}
          </header>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            {draft ? (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="dim">invite code</span>
                <span className="font-display text-2xl text-accent tracking-widest">
                  {team.inviteCode}
                </span>
                <TextAction
                  onClick={() => {
                    navigator.clipboard.writeText(team.inviteCode).then(
                      () => post("Code copied."),
                      () => post("Copy failed.", "error"),
                    );
                  }}
                >
                  copy
                </TextAction>
                {isCaptain ? (
                  <TextAction
                    disabled={resetInvite.isPending}
                    onClick={() => resetInvite.mutate(team.id)}
                  >
                    reset
                  </TextAction>
                ) : null}
              </p>
            ) : (
              <p className="dim">
                {team.submittedAt ? `submitted ${formatDateTime(team.submittedAt)}` : event.name}
              </p>
            )}
            {draft ? (
              <p className={submitBlocker ? "text-warn" : "dim"}>
                {submitBlocker
                  ? `~ ${submitBlocker}`
                  : isCaptain
                    ? "Ready to submit"
                    : "Captain submits"}
              </p>
            ) : null}
          </div>
        </div>

        {errorNotice}

        <Pane title="members" meta={`${team.members.length}/${event.teamSize.max}`} flush>
          <ul className="grid">
            {team.members.map((member) => (
              <li
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-6 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_6ch]"
                key={member.id}
              >
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                  <span className="font-bold">{member.name}</span>
                  <span className="dim">@{member.github}</span>
                  {member.id === team.captainId ? <span className="text-info">captain</span> : null}
                </span>
                <StateTag state={member.profileStatus} />
                <span className="col-span-2 sm:col-span-1 sm:text-right">
                  {isCaptain && member.id !== team.captainId && draft ? (
                    <TextAction
                      tone="danger"
                      disabled={removeMember.isPending}
                      aria-label={`Remove ${member.name} from the team`}
                      onClick={() => removeMember.mutate({ id: team.id, memberId: member.id })}
                    >
                      remove
                    </TextAction>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Pane>

        <TeamFitPane teamId={team.id} />
        {draft && team.members.length < event.teamSize.max ? (
          <TeammateSuggestions eventId={eventId} />
        ) : null}

        {draft ? (
          <div>
            <TextAction
              tone="danger"
              disabled={leaveTeam.isPending}
              onClick={() => leaveTeam.mutate(team.id)}
            >
              {leaveTeam.isPending ? "leaving…" : "leave team"}
            </TextAction>
          </div>
        ) : null}
      </section>
    );
  }

  const choiceClass =
    "grid gap-2 border border-(--frame) p-6 text-left font-display text-2xl hover:border-accent aria-[expanded=true]:border-accent aria-[expanded=true]:text-accent aria-[pressed=true]:border-accent disabled:opacity-60";

  return (
    <section className="grid gap-6" aria-label="Team">
      <h2 className="font-display text-3xl">
        team{" "}
        <span className="dim text-xl">
          teams of {event.teamSize.min}–{event.teamSize.max}
        </span>
      </h2>
      {errorNotice}
      <div className="grid gap-4 sm:grid-cols-3">
        <button
          type="button"
          className={choiceClass}
          aria-expanded={mode === "create"}
          onClick={() => setMode("create")}
        >
          Create a team
        </button>
        <button
          type="button"
          className={choiceClass}
          aria-expanded={mode === "join"}
          onClick={() => setMode("join")}
        >
          Join with a code
        </button>
        <button
          type="button"
          className={choiceClass}
          aria-pressed={listed}
          disabled={lookingForTeam.isPending}
          onClick={() => lookingForTeam.mutate(!listed)}
        >
          Looking for a team
          {listed ? <StateTag state="ready" label="listed" /> : null}
        </button>
      </div>

      {mode === "create" ? (
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            if (teamName.trim().length >= 2) createTeam.mutate();
          }}
        >
          <Field label="Team name" className="min-w-0 flex-[1_1_20rem]" required>
            <TextInput
              value={teamName}
              maxLength={80}
              onChange={(changeEvent) => setTeamName(changeEvent.target.value)}
            />
          </Field>
          <ActionButton
            tone="primary"
            type="submit"
            disabled={teamName.trim().length < 2 || createTeam.isPending}
          >
            {createTeam.isPending ? "Creating…" : "Create team"}
          </ActionButton>
        </form>
      ) : null}
      {mode === "join" ? (
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            if (inviteCode.replace(/[^A-Z0-9]/g, "").length === 8) joinTeam.mutate();
          }}
        >
          <Field label="Invite code" className="min-w-0 flex-[1_1_20rem]" required>
            <TextInput
              value={inviteCode}
              maxLength={12}
              autoCapitalize="characters"
              onChange={(changeEvent) => setInviteCode(changeEvent.target.value.toUpperCase())}
            />
          </Field>
          <ActionButton
            tone="primary"
            type="submit"
            disabled={inviteCode.replace(/[^A-Z0-9]/g, "").length !== 8 || joinTeam.isPending}
          >
            {joinTeam.isPending ? "Joining…" : "Join team"}
          </ActionButton>
        </form>
      ) : null}
      <TeammateSuggestions eventId={eventId} />
    </section>
  );
}

/** Covered / missing per published requirement, best member and level. Never a score or rank. */
function TeamFitPane({ teamId }: { teamId: string }) {
  const fit = useQuery({
    queryKey: ["participant-team-fit", teamId],
    queryFn: () => getParticipantTeamFit(teamId),
    retry: false,
  });
  if (fit.isPending) return <LoadingState label="checking fit" />;
  if (fit.isError)
    return <ErrorState message={fit.error.message} retry={() => void fit.refetch()} />;
  if (fit.data.length === 0) return null;
  const missing = fit.data.filter((row) => !row.covered);
  return (
    <Pane title="team fit" meta={`${fit.data.length - missing.length}/${fit.data.length} covered`}>
      <div className="grid gap-4">
        {missing.length > 0 ? (
          <p className="text-warn">
            ~ missing {missing.map((row) => skillLabel(row.skill)).join(", ")}
          </p>
        ) : (
          <p className="text-accent">✓ every requirement covered</p>
        )}
        <SkillGroups items={fit.data} idOf={(row) => row.skill}>
          {(row) => (
            <div
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[18ch_auto_minmax(0,1fr)]"
              key={row.skill}
            >
              <span className="truncate">{skillLabel(row.skill)}</span>
              <Bar
                value={row.level}
                target={row.target}
                label={skillLabel(row.skill)}
                {...(row.covered ? {} : { tone: "warn" as const })}
              />
              <span className={`col-span-2 sm:col-span-1 ${row.covered ? "dim" : "text-warn"}`}>
                {row.covered
                  ? row.best?.name
                  : row.best
                    ? `~ best ${row.best.name}`
                    : "~ no evidence yet"}
              </span>
            </div>
          )}
        </SkillGroups>
      </div>
    </Pane>
  );
}

/** Opted-in, teamless applicants of the same event who would fill this team's gaps. */
function TeammateSuggestions({ eventId }: { eventId: string }) {
  const suggestions = useQuery({
    queryKey: ["participant-teammates", eventId],
    queryFn: () => getTeammateSuggestions(eventId),
    retry: false,
  });
  if (!suggestions.data?.length) return null;
  return (
    <Details summary="suggested teammates" meta={suggestions.data.length}>
      <ul className="grid gap-4">
        {suggestions.data.map((person) => (
          <li className="grid gap-1" key={person.id}>
            <p className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-bold">{person.name}</span>
              {person.college ? <span className="dim">{person.college}</span> : null}
              <span className="text-accent">
                + {person.fills.map((skill) => skillLabel(skill)).join(", ")}
              </span>
            </p>
            <p className="flex flex-wrap gap-x-4">
              {splitSkills(person.topSkills, (skill) => skill.id).map((group) => (
                <span key={group.label}>
                  <span className="dim">{group.label} </span>
                  {group.items.map((skill) => (
                    <span className="mr-3 whitespace-nowrap" key={skill.id}>
                      {skillLabel(skill.id)} {skill.level.toFixed(1)}
                    </span>
                  ))}
                </span>
              ))}
            </p>
          </li>
        ))}
      </ul>
    </Details>
  );
}

/** Confirm or decline a selected place before the RSVP deadline. */
function RsvpBlock({ applicationId }: { applicationId: string }) {
  const queryClient = useQueryClient();
  const { post } = useStatusLine();
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const rsvp = useQuery({
    queryKey: ["participant-rsvp", applicationId],
    queryFn: () => getParticipantRsvp(applicationId),
    retry: false,
  });
  const respond = useMutation({
    mutationFn: (answer: "confirm" | "decline") => respondParticipantRsvp(applicationId, answer),
    onSuccess: async (result) => {
      post(result.status === "confirmed" ? "Attendance confirmed." : "Place declined.");
      setConfirmDecline(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["participant-rsvp", applicationId] }),
        queryClient.invalidateQueries({ queryKey: ["participant-application"] }),
        queryClient.invalidateQueries({ queryKey: ["participant-overview"] }),
      ]);
    },
  });
  if (rsvp.isPending) return <LoadingState label="loading RSVP" />;
  if (rsvp.isError) {
    return <ErrorState message={rsvp.error.message} retry={() => void rsvp.refetch()} />;
  }
  const deadline = rsvp.data.rsvpDeadlineAt;
  const remaining = deadline ? countdown(deadline, now) : null;
  if (!rsvp.data.canRespond || !remaining || !deadline) {
    return <Notice tone="warn">RSVP closed.</Notice>;
  }
  return (
    <Pane title="rsvp" meta={`by ${formatDateTime(deadline)}`} active>
      <div className="grid gap-6">
        <p className="grid">
          <span className="font-display text-4xl leading-none text-warn glow sm:text-5xl">
            {remaining}
          </span>
          <span className="dim">until RSVP closes</span>
        </p>
        {respond.error ? (
          <ErrorState
            message={respond.error instanceof Error ? respond.error.message : "RSVP failed"}
          />
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-4">
          {confirmDecline ? (
            <>
              <span className="text-error">Give up your place?</span>
              <TextAction onClick={() => setConfirmDecline(false)}>keep it</TextAction>
              <ActionButton
                tone="danger"
                disabled={respond.isPending}
                onClick={() => respond.mutate("decline")}
              >
                {respond.isPending ? "Declining…" : "Yes, decline"}
              </ActionButton>
            </>
          ) : (
            <>
              <ActionButton
                tone="danger"
                disabled={respond.isPending}
                onClick={() => setConfirmDecline(true)}
              >
                Decline
              </ActionButton>
              <ActionButton
                tone="primary"
                disabled={respond.isPending}
                onClick={() => respond.mutate("confirm")}
              >
                {respond.isPending ? "Confirming…" : "Confirm attendance"}
              </ActionButton>
            </>
          )}
        </div>
      </div>
    </Pane>
  );
}

const statusCopy = {
  draft: "Not submitted yet.",
  submitted: "Waiting for the shortlist.",
  under_review: "Registration closed. Under review.",
  selected: "You're in. RSVP before the deadline.",
  waitlisted: "On the waitlist. We'll email you if a place opens.",
  not_selected: "Not selected this time.",
  confirmed: "You're confirmed. See you there.",
  declined: "You declined your place.",
} as const;

export function ParticipantApplicationPage() {
  const { applicationId } = useParams();
  const hasApplication = applicationId && applicationId !== "current";
  const application = useQuery({
    queryKey: ["participant-application", applicationId],
    queryFn: () => getParticipantApplication(applicationId ?? ""),
    enabled: Boolean(hasApplication),
    retry: false,
  });
  const data = application.data;
  const timeline = data?.event.timeline;
  const now = Date.now();
  const milestones: Array<[string, string]> = timeline
    ? [
        ["registration closes", timeline.registrationClosesAt],
        ["shortlist published", timeline.shortlistPublishesAt],
        ["RSVP deadline", timeline.rsvpDeadlineAt],
        ["event starts", timeline.eventStartsAt],
      ]
    : [];

  return (
    <div className="mx-auto grid max-w-3xl gap-12">
      <ScreenHead title={data?.event.name ?? "Application"} />

      {application.isPending && hasApplication ? <LoadingState label="loading" /> : null}
      {application.isError || !hasApplication ? (
        <EmptyState
          title={hasApplication ? "Application not found" : "Start with a published event"}
          action={
            <ActionLink to={hasApplication ? "/participant" : "/"}>
              {hasApplication ? "Your applications" : "Browse events"}
            </ActionLink>
          }
        />
      ) : null}

      {data ? (
        <div className="grid gap-4">
          <StateTag state={data.status} size="lg" />
          <p className="text-lg">{statusCopy[data.status]}</p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link className="tui-link" to="/participant/profile">
              profile
            </Link>
            <Link className="tui-link" to={`/h/${data.event.slug}`}>
              event page
            </Link>
          </div>
        </div>
      ) : null}

      {data?.status === "selected" ? <RsvpBlock applicationId={data.id} /> : null}

      {data ? <TeamSection eventId={data.event.id} /> : null}

      {timeline ? (
        <Details summary="deadlines">
          <ol className="grid gap-2">
            {milestones.map(([label, at]) => {
              const passed = Date.parse(at) <= now;
              return (
                <li
                  className="grid grid-cols-[2ch_1fr] gap-x-2 sm:grid-cols-[2ch_1fr_auto]"
                  key={label}
                >
                  <span aria-hidden="true" className={passed ? "dim" : "text-accent"}>
                    {passed ? "●" : "○"}
                  </span>
                  <span className={passed ? "dim" : undefined}>
                    {label}
                    <span className="sr-only">{passed ? " (passed)" : ""}</span>
                  </span>
                  <time className="dim col-start-2 sm:col-start-3" dateTime={at}>
                    {formatDateTime(at)}
                  </time>
                </li>
              );
            })}
          </ol>
        </Details>
      ) : null}
    </div>
  );
}

export function ParticipantDataPage() {
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { post } = useStatusLine();
  const [confirmation, setConfirmation] = useState("");
  // Both actions end the session; drop every cached participant screen with it.
  const signedOut = (message: string) => {
    queryClient.setQueryData(["current-user"], null);
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "current-user" });
    post(message);
    navigate("/");
  };
  const revoke = useMutation({
    mutationFn: revokeGithubAccess,
    onSuccess: () => signedOut("GitHub access revoked."),
  });
  const deletion = useMutation({
    mutationFn: deleteParticipantAccount,
    onSuccess: (result) =>
      signedOut(result.githubRevoked ? "Account deleted." : "Deleted. Revoke on GitHub."),
  });

  return (
    <div className="mx-auto grid max-w-2xl gap-10">
      <ScreenHead title="Your data" />
      {account.isPending ? <LoadingState label="loading" /> : null}
      {account.data ? (
        <>
          <Pane title="account">
            <div className="grid gap-6">
              <KeyValue
                items={[
                  ["github", `@${account.data.login}`],
                  ["name", account.data.name],
                  ["email", account.data.email ?? "not shared"],
                  ["access", "public repos, read-only"],
                ]}
              />
              <div className="flex flex-wrap gap-2">
                <ActionAnchor href={participantDataExportUrl} download>
                  Download my data
                </ActionAnchor>
                <ActionButton disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                  {revoke.isPending ? "Revoking…" : "Revoke GitHub access"}
                </ActionButton>
              </div>
              {revoke.isError ? (
                <Notice tone="error" tag="error">
                  {revoke.error.message}
                </Notice>
              ) : null}
            </div>
          </Pane>
          <Details summary="delete account">
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (confirmation === "delete") deletion.mutate();
              }}
            >
              <Field label='Type "delete" to confirm' hint="Cannot be undone" required>
                <TextInput
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <div className="flex justify-end">
                <ActionButton
                  type="submit"
                  tone="danger"
                  disabled={confirmation !== "delete" || deletion.isPending}
                >
                  {deletion.isPending ? "Deleting…" : "Delete my account"}
                </ActionButton>
              </div>
              {deletion.isError ? (
                <Notice tone="error" tag="error">
                  {deletion.error.message}
                </Notice>
              ) : null}
            </form>
          </Details>
        </>
      ) : null}
      {!account.isPending && !account.data ? (
        <EmptyState
          title="No GitHub account connected"
          action={
            <ActionLink to="/login" tone="primary">
              Sign in with GitHub
            </ActionLink>
          }
        />
      ) : null}
    </div>
  );
}
