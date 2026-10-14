import { taxonomy } from "@talentradar/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ActionButton,
  ActionLink,
  Badge,
  EmptyState,
  ErrorState,
  Field,
  PageHeading,
  Panel,
  ProgressBar,
  SelectInput,
  StepRail,
  TextInput,
} from "../components/ui";
import {
  ApiError,
  createParticipantTeam,
  getCurrentUser,
  getParticipantApplication,
  getParticipantOverview,
  getParticipantProfile,
  getParticipantRepositories,
  getParticipantTeam,
  getRuntimeConfig,
  joinParticipantTeam,
  leaveParticipantTeam,
  removeParticipantTeamMember,
  resetParticipantTeamInvite,
  setParticipantLookingForTeam,
  submitParticipantApplication,
  submitParticipantTeam,
  uploadParticipantCv,
} from "../lib/api";

const onboardingSteps = ["Your details", "CV", "Repositories", "Consent", "Review"] as const;

function ParticipantNotice() {
  return (
    <div className="context-notice">
      <span aria-hidden="true">i</span>
      <p>Sign in with GitHub to load your profile, applications, and event teams.</p>
      <ActionLink to="/login" tone="secondary">
        Sign in
      </ActionLink>
    </div>
  );
}

export function ParticipantDashboard() {
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const overview = useQuery({
    queryKey: ["participant-overview"],
    queryFn: getParticipantOverview,
    enabled: Boolean(account.data),
    retry: false,
  });
  const applications = overview.data?.applications ?? [];

  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="PARTICIPANT / OVERVIEW"
        title="Your applications"
        description="Apply to an event, build one reusable evidence profile, and manage your team."
        action={<ActionLink to="/">Browse public events</ActionLink>}
      />
      {!account.data && !account.isPending ? <ParticipantNotice /> : null}

      <section className="metric-strip" aria-label="Application summary">
        <div>
          <span>APPLICATIONS</span>
          <strong>{applications.length}</strong>
          <small>{account.data ? "Saved applications" : "Sign in to load"}</small>
        </div>
        <div>
          <span>OPEN ACTIONS</span>
          <strong>
            {applications.filter((application) => application.status === "draft").length}
          </strong>
          <small>Drafts needing action</small>
        </div>
        <div>
          <span>PROFILE</span>
          <strong>{overview.data?.profile?.status ?? "—"}</strong>
          <small>
            {overview.data?.profile
              ? `Build version ${overview.data.profile.version}`
              : "Not built"}
          </small>
        </div>
        <div>
          <span>TEAM</span>
          <strong>{applications.length > 0 ? "OPEN" : "—"}</strong>
          <small>{applications.length > 0 ? "Open an application" : "No event selected"}</small>
        </div>
      </section>

      <div className="dashboard-grid">
        <Panel label="01 / APPLICATIONS" title="Active events" className="span-two">
          {overview.isPending && account.data ? (
            <div className="loading-state">Loading applications…</div>
          ) : null}
          {!account.isPending && !account.data ? (
            <EmptyState title="Sign in to see your applications">
              This workspace only loads applications owned by your connected GitHub account.
            </EmptyState>
          ) : null}
          {account.data && applications.length === 0 && !overview.isPending ? (
            <EmptyState
              title="No applications yet"
              action={<ActionLink to="/">Find an event</ActionLink>}
            >
              Applications appear here after you open a published event and start its participant
              flow.
            </EmptyState>
          ) : null}
          {applications.length > 0 ? (
            <div className="event-table participant-application-table">
              <div className="table-row table-head">
                <span>EVENT</span>
                <span>STATUS</span>
                <span>UPDATED</span>
                <span />
              </div>
              {applications.map((application) => (
                <div className="table-row" key={application.id}>
                  <strong>{application.eventName}</strong>
                  <Badge tone={application.status === "selected" ? "success" : "neutral"}>
                    {application.status.replace("_", " ")}
                  </Badge>
                  <span>{new Date(application.updatedAt).toLocaleDateString()}</span>
                  <ActionLink
                    to={`/participant/applications/${application.id}/status`}
                    tone="quiet"
                  >
                    Open
                  </ActionLink>
                </div>
              ))}
            </div>
          ) : null}
        </Panel>
        <Panel label="02 / PROFILE" title="Evidence profile">
          <div className="profile-readiness">
            <ProgressBar
              value={overview.data?.profile?.status === "ready" ? 100 : overview.data ? 50 : 0}
              label="Profile completeness"
            />
            <dl className="compact-definition-list">
              <div>
                <dt>Identity</dt>
                <dd>{overview.data?.account.login ?? "Not connected"}</dd>
              </div>
              <div>
                <dt>CV</dt>
                <dd>{overview.data?.account.hasCv ? "Uploaded" : "Not provided"}</dd>
              </div>
              <div>
                <dt>Repositories</dt>
                <dd>None selected</dd>
              </div>
            </dl>
            <ActionLink to="/participant/onboarding" tone="secondary">
              Open onboarding
            </ActionLink>
          </div>
        </Panel>
      </div>
    </div>
  );
}

export function ParticipantOnboarding() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [consented, setConsented] = useState(false);
  const [syntheticCvConfirmed, setSyntheticCvConfirmed] = useState(false);
  const [details, setDetails] = useState({ name: "", college: "", year: "", branch: "" });
  const [selectedRepositories, setSelectedRepositories] = useState<string[]>([]);
  const [uploadedCv, setUploadedCv] = useState<{ id: string; name: string; size: number } | null>(
    null,
  );
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const overview = useQuery({
    queryKey: ["participant-overview"],
    queryFn: getParticipantOverview,
    enabled: Boolean(account.data),
    retry: false,
  });
  const repositories = useQuery({
    queryKey: ["participant-repositories"],
    queryFn: getParticipantRepositories,
    enabled: Boolean(account.data) && step >= 2,
    retry: false,
  });
  const runtimeConfig = useQuery({ queryKey: ["runtime-config"], queryFn: getRuntimeConfig });
  const uploadCv = useMutation({
    mutationFn: uploadParticipantCv,
    onSuccess: async (cv) => {
      setUploadedCv(cv);
      await queryClient.invalidateQueries({ queryKey: ["participant-overview"] });
    },
  });
  const submitApplication = useMutation({
    mutationFn: () => {
      if (!slug) throw new Error("Open a published event before submitting an application");
      return submitParticipantApplication(slug, {
        details,
        repositories: selectedRepositories,
        consent: true,
        syntheticCv: syntheticCvConfirmed,
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["participant-overview"] });
      navigate(`/participant/applications/${result.application.id}/status`);
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

  const updateDetail = (field: keyof typeof details, value: string) => {
    setDetails((current) => ({ ...current, [field]: value }));
  };

  const cvReady = Boolean(uploadedCv || overview.data?.account.hasCv);
  const privacyReady =
    consented && (runtimeConfig.data?.modelDataPolicy !== "synthetic_only" || syntheticCvConfirmed);
  const stepValid = [
    Object.values(details).every((value) => value.trim().length > 0),
    cvReady,
    selectedRepositories.length > 0 && selectedRepositories.length <= 6,
    privacyReady,
    Boolean(slug) && privacyReady && cvReady && selectedRepositories.length > 0,
  ];

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
    <div className="portal-page wizard-page">
      <PageHeading
        eyebrow={slug ? `APPLICATION / ${slug.toUpperCase()}` : "PARTICIPANT / ONBOARDING"}
        title="Build your evidence profile"
        description="Confirm your details, choose public work you want assessed, and control consent before processing starts."
      />
      <StepRail steps={onboardingSteps} current={step} />

      {!account.data && !account.isPending ? <ParticipantNotice /> : null}

      <div className="wizard-layout">
        <Panel
          label={`STEP ${step + 1} / ${onboardingSteps.length}`}
          title={onboardingSteps[step] ?? onboardingSteps[0]}
          className="wizard-main"
        >
          {step === 0 ? (
            <div className="form-grid">
              <Field
                label="Full name"
                hint="Pulled from your CV when available; always confirm it."
              >
                <TextInput
                  value={details.name}
                  onChange={(event) => updateDetail("name", event.target.value)}
                  autoComplete="name"
                  placeholder="Your full name"
                />
              </Field>
              <Field label="College or university">
                <TextInput
                  value={details.college}
                  onChange={(event) => updateDetail("college", event.target.value)}
                  placeholder="Institution name"
                />
              </Field>
              <Field label="Year of study">
                <SelectInput
                  value={details.year}
                  onChange={(event) => updateDetail("year", event.target.value)}
                >
                  <option value="">Select year</option>
                  <option value="1">First year</option>
                  <option value="2">Second year</option>
                  <option value="3">Third year</option>
                  <option value="4">Fourth year</option>
                  <option value="5+">Fifth year or later</option>
                  <option value="graduate">Graduate</option>
                </SelectInput>
              </Field>
              <Field label="Branch or course">
                <TextInput
                  value={details.branch}
                  onChange={(event) => updateDetail("branch", event.target.value)}
                  placeholder="e.g. Computer Science"
                />
              </Field>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="upload-zone">
              <span aria-hidden="true">PDF</span>
              <h3>Choose your current CV</h3>
              <p>PDF only, up to 2 MB. You can inspect and replace it before processing.</p>
              <input
                id="participant-cv"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) uploadCv.mutate(file);
                }}
              />
              <label className="btn terminal-action action-secondary" htmlFor="participant-cv">
                [ {uploadCv.isPending ? "Uploading…" : cvReady ? "Replace PDF" : "Choose PDF"} ]
              </label>
              {uploadedCv ? (
                <p className="muted-copy">
                  Uploaded {uploadedCv.name} · {(uploadedCv.size / 1024).toFixed(0)} KB
                </p>
              ) : overview.data?.account.hasCv ? (
                <p className="muted-copy">A CV is already stored for this profile.</p>
              ) : null}
              {uploadCv.isError ? (
                <div className="error-state" role="alert">
                  {uploadCv.error.message}
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="repository-step">
              {!account.data ? (
                <div className="context-notice compact">
                  <span aria-hidden="true">i</span>
                  <p>Connect GitHub to load the public repositories owned by your account.</p>
                  <ActionLink
                    to={`/login?returnTo=${encodeURIComponent(`/participant/apply/${slug ?? ""}`)}`}
                    tone="secondary"
                  >
                    Connect GitHub
                  </ActionLink>
                </div>
              ) : null}
              {repositories.isPending && account.data ? (
                <div className="loading-state">Reading public repositories…</div>
              ) : null}
              {repositories.isError ? (
                <div className="error-state" role="alert">
                  {repositories.error.message}
                </div>
              ) : null}
              {repositories.data?.length === 0 ? (
                <EmptyState title="No repositories available">
                  GitHub did not return an eligible public repository for this account.
                </EmptyState>
              ) : null}
              {repositories.data && repositories.data.length > 0 ? (
                <div className="repository-picker">
                  <div className="repository-picker-heading">
                    <span>SELECTED {selectedRepositories.length} / 6</span>
                    <small>Fork authorship is verified during processing.</small>
                  </div>
                  {repositories.data.map((repository) => (
                    <label
                      className={`repository-choice ${repository.eligible ? "" : "disabled"}`}
                      key={repository.fullName}
                    >
                      <input
                        type="checkbox"
                        checked={selectedRepositories.includes(repository.fullName)}
                        disabled={!repository.eligible}
                        onChange={() => toggleRepository(repository.fullName)}
                      />
                      <span>
                        <strong>{repository.fullName}</strong>
                        <small>
                          {repository.language ?? "Language unavailable"} ·{" "}
                          {(repository.sizeKb / 1024).toFixed(1)} MB
                          {repository.fork ? " · fork" : ""}
                        </small>
                        {repository.description ? <p>{repository.description}</p> : null}
                        {repository.exclusionReason ? <em>{repository.exclusionReason}</em> : null}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="consent-copy">
              <h3>Review before automated evaluation</h3>
              <p>
                TalentRadar will analyze the public repositories you select and the CV you upload to
                produce skill evidence, confidence, and model reasoning for event organizers.
              </p>
              <ul className="terminal-list">
                <li>Only the selected public repositories are assessed.</li>
                <li>Evidence links point to the exact commit that was evaluated.</li>
                <li>You can report incorrect evidence and request deletion from Data settings.</li>
                <li>Model reasoning can be wrong; cited files remain the source of proof.</li>
              </ul>
              <label className="terminal-check">
                <input
                  type="checkbox"
                  checked={consented}
                  onChange={(event) => setConsented(event.target.checked)}
                />
                <span>I understand and consent to this automated evaluation.</span>
              </label>
              {runtimeConfig.data?.modelDataPolicy === "synthetic_only" ? (
                <label className="terminal-check">
                  <input
                    type="checkbox"
                    checked={syntheticCvConfirmed}
                    onChange={(event) => setSyntheticCvConfirmed(event.target.checked)}
                  />
                  <span>
                    This free-tier deployment accepts synthetic CVs only. I confirm this PDF does
                    not contain a real person's personal data.
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          {step === 4 ? (
            <div className="review-grid">
              <dl className="review-list">
                <div>
                  <dt>Name</dt>
                  <dd>{details.name || "Not provided"}</dd>
                </div>
                <div>
                  <dt>College</dt>
                  <dd>{details.college || "Not provided"}</dd>
                </div>
                <div>
                  <dt>Year</dt>
                  <dd>{details.year || "Not provided"}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{details.branch || "Not provided"}</dd>
                </div>
                <div>
                  <dt>CV</dt>
                  <dd>{cvReady ? (uploadedCv?.name ?? "Stored PDF") : "Not selected"}</dd>
                </div>
                <div>
                  <dt>Repositories</dt>
                  <dd>{selectedRepositories.length || "None selected"}</dd>
                </div>
                <div>
                  <dt>Consent</dt>
                  <dd>
                    <Badge tone={privacyReady ? "success" : "warning"}>
                      {privacyReady ? "Granted" : "Required"}
                    </Badge>
                  </dd>
                </div>
              </dl>
              <div className="submission-note">
                <strong>
                  {slug ? "Ready to create the application." : "Choose an event first."}
                </strong>
                <p>
                  Profile processing begins only after required details, a repository selection, and
                  consent are present.
                </p>
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
            {step < onboardingSteps.length - 1 ? (
              <ActionButton
                disabled={!stepValid[step]}
                onClick={() => setStep((value) => Math.min(onboardingSteps.length - 1, value + 1))}
              >
                Continue
              </ActionButton>
            ) : (
              <ActionButton
                disabled={!stepValid.every(Boolean) || submitApplication.isPending}
                onClick={() => submitApplication.mutate()}
              >
                {submitApplication.isPending ? "Submitting…" : "Apply and build profile"}
              </ActionButton>
            )}
          </div>
          {submitApplication.isError ? (
            <div className="error-state" role="alert">
              {submitApplication.error.message}
            </div>
          ) : null}
        </Panel>

        <aside className="wizard-aside">
          <Panel label="DATA / ACCESS" title="What GitHub shares">
            <dl className="compact-definition-list">
              <div>
                <dt>Identity</dt>
                <dd>read:user</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>user:email</dd>
              </div>
              <div>
                <dt>Code</dt>
                <dd>Public only</dd>
              </div>
              <div>
                <dt>Write access</dt>
                <dd>Never</dd>
              </div>
            </dl>
          </Panel>
          <Panel label="PROFILE / TIME" title="Build happens in the background">
            <p className="prose-copy">
              Once submitted, you can create or join a team while your profile is built. Only real
              processing events appear in the build log.
            </p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

export function ParticipantProfilePage() {
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
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
  const selectedSkill = profile.data?.profile.skills.find((skill) => skill.id === selectedSkillId);
  const progress = (profile.data?.jobs ?? [])
    .flatMap((job) => job.progress)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

  if (profile.isPending) return <div className="loading-state">Loading evidence profile…</div>;
  if (profile.isError) {
    return (
      <div className="portal-page">
        <PageHeading
          eyebrow="PARTICIPANT / PROFILE"
          title="Your evidence profile"
          description="Every skill must be traceable to repository files at a fixed commit."
          action={<ActionLink to="/participant/onboarding">Complete profile</ActionLink>}
        />
        <EmptyState title="No profile has been built">
          Open a published event, choose repositories, provide consent, and submit the application
          to start a real profile build.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="PARTICIPANT / PROFILE"
        title="Your evidence profile"
        description="Every skill must be traceable to repository files at a fixed commit."
        action={<ActionLink to="/participant/onboarding">Change inputs</ActionLink>}
      />
      <div className="event-identity">
        <span>PROFILE</span>
        <strong>VERSION {profile.data.profile.version}</strong>
        <Badge tone={profile.data.profile.status === "ready" ? "success" : "warning"}>
          {profile.data.profile.status}
        </Badge>
        <small>
          {profile.data.profile.builtAt
            ? new Date(profile.data.profile.builtAt).toLocaleString()
            : "Build not complete"}
        </small>
      </div>
      <div className="two-column-layout">
        <Panel label="EVIDENCE / SKILLS" title="Detected skills" className="span-two">
          {profile.data.profile.skills.length === 0 ? (
            <EmptyState
              title={
                profile.data.profile.status === "failed"
                  ? "Profile build failed"
                  : "No skills available yet"
              }
            >
              {profile.data.profile.error ??
                "Real worker progress appears below while repository and CV processing continues."}
            </EmptyState>
          ) : (
            <div className="profile-skill-list">
              {profile.data.profile.skills.map((skill) => (
                <button
                  type="button"
                  className={selectedSkillId === skill.id ? "selected" : ""}
                  key={skill.id}
                  onClick={() => setSelectedSkillId(skill.id)}
                >
                  <span>
                    <strong>
                      {taxonomy.technologies[skill.id]?.label ??
                        taxonomy.domains[skill.id]?.label ??
                        skill.id}
                    </strong>
                    <small>{skill.evidence.length} cited files</small>
                  </span>
                  <span>LVL {skill.level.toFixed(2)}</span>
                  <Badge tone={skill.confidence === "high" ? "success" : "neutral"}>
                    {skill.confidence} confidence
                  </Badge>
                  <b>{skill.effective.toFixed(2)} effective</b>
                </button>
              ))}
            </div>
          )}
        </Panel>
        <Panel
          label="EVIDENCE / DETAIL"
          title={selectedSkill ? "Selected skill" : "Choose a skill"}
        >
          {selectedSkill ? (
            <div className="skill-evidence-detail">
              <p>{selectedSkill.thought}</p>
              {selectedSkill.evidence.map((evidence) => (
                <a
                  href={`https://github.com/${evidence.repository}/blob/${evidence.commitSha}/${evidence.path}`}
                  key={`${evidence.repository}-${evidence.path}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  <strong>{evidence.path}</strong>
                  <span>
                    {evidence.repository}@{evidence.commitSha.slice(0, 8)}
                  </span>
                  <small>{evidence.note}</small>
                </a>
              ))}
            </div>
          ) : (
            <p className="muted-copy">
              Select a skill to inspect its proof, interpretation, and frozen commit.
            </p>
          )}
        </Panel>
        <Panel label="INPUT / REPOSITORIES" title="Selected repositories">
          <dl className="compact-definition-list">
            {profile.data.profile.repos.map((repository) => (
              <div key={repository.fullName}>
                <dt>{repository.fullName}</dt>
                <dd>{repository.sha?.slice(0, 10) ?? "Processing"}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel label="BUILD / REAL EVENTS" title="Profile processing" className="span-two">
          {progress.length > 0 ? (
            <div className="mockup-code real-build-log" aria-live="polite">
              {progress.map((event, index) => (
                <pre
                  data-prefix={String(index + 1).padStart(2, "0")}
                  key={`${event.at}-${event.code}`}
                >
                  <code>{event.message}</code>
                </pre>
              ))}
            </div>
          ) : (
            <EmptyState title="No worker events yet">
              The queued build has not been claimed.
            </EmptyState>
          )}
        </Panel>
      </div>
    </div>
  );
}

export function ParticipantTeamPage() {
  const { teamId } = useParams();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"choose" | "create" | "join">("choose");
  const [teamName, setTeamName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const context = useQuery({
    queryKey: ["participant-team"],
    queryFn: getParticipantTeam,
    retry: false,
  });

  const refreshTeam = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["participant-team"] }),
      queryClient.invalidateQueries({ queryKey: ["participant-overview"] }),
    ]);
  };
  const createTeam = useMutation({
    mutationFn: () => createParticipantTeam(context.data?.event.id ?? "", teamName),
    onSuccess: async () => {
      setNotice("Team created. Share the invite code only with people you want to add.");
      setTeamName("");
      await refreshTeam();
    },
  });
  const joinTeam = useMutation({
    mutationFn: () => joinParticipantTeam(inviteCode),
    onSuccess: async () => {
      setNotice("You joined the team.");
      setInviteCode("");
      await refreshTeam();
    },
  });
  const lookingForTeam = useMutation({
    mutationFn: (enabled: boolean) => setParticipantLookingForTeam(enabled),
    onSuccess: async (enabled) => {
      setNotice(
        enabled
          ? "Your name, college, and top three skills are visible to applicants in this event."
          : "You are no longer listed in the looking-for-team pool.",
      );
      await refreshTeam();
    },
  });
  const submitTeam = useMutation({
    mutationFn: (id: string) => submitParticipantTeam(id),
    onSuccess: async () => {
      setNotice("Team submitted. Membership is now locked for shortlisting.");
      await refreshTeam();
    },
  });
  const resetInvite = useMutation({
    mutationFn: (id: string) => resetParticipantTeamInvite(id),
    onSuccess: async () => {
      setNotice("The old invite code is invalid. Share the new code with intended teammates.");
      await refreshTeam();
    },
  });
  const removeMember = useMutation({
    mutationFn: ({ id, memberId }: { id: string; memberId: string }) =>
      removeParticipantTeamMember(id, memberId),
    onSuccess: async () => {
      setNotice("Member removed from the roster.");
      await refreshTeam();
    },
  });
  const leaveTeam = useMutation({
    mutationFn: (id: string) => leaveParticipantTeam(id),
    onSuccess: async () => {
      setNotice(
        "You left the team. If you were captain, captaincy moved to the earliest joined member.",
      );
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
  const explicitTeamMismatch =
    teamId && teamId !== "current" && context.data && context.data.team?.id !== teamId;
  const isCaptain = Boolean(team && context.data?.personId === team.captainId);
  const allProfilesReady =
    team?.members.every((member) => member.profileStatus === "ready") ?? false;
  const validTeamSize = Boolean(
    team &&
      context.data &&
      team.members.length >= context.data.event.teamSize.min &&
      team.members.length <= context.data.event.teamSize.max,
  );
  const submitBlockers = [
    !validTeamSize
      ? `Team size must be ${context.data?.event.teamSize.min ?? "—"}–${context.data?.event.teamSize.max ?? "—"}.`
      : null,
    !allProfilesReady ? "Every member needs a completed evidence profile." : null,
  ].filter((blocker): blocker is string => Boolean(blocker));

  if (context.isPending) {
    return (
      <div className="portal-page">
        <PageHeading
          eyebrow="PARTICIPANT / TEAM"
          title="Build your team"
          description="Loading your active event and team membership."
        />
        <div className="loading-state">Loading team workspace…</div>
      </div>
    );
  }

  if (context.isError) {
    const needsApplication = context.error instanceof ApiError && context.error.status === 404;
    return (
      <div className="portal-page">
        <PageHeading
          eyebrow="PARTICIPANT / TEAM"
          title="Build your team"
          description="Create, join, or enter the looking-for-team pool before registration closes."
        />
        {needsApplication ? (
          <EmptyState
            title="Apply to an event first"
            action={<ActionLink to="/">Browse events</ActionLink>}
          >
            A team belongs to one event. Start an application from its public page, then return
            here.
          </EmptyState>
        ) : (
          <ErrorState message={context.error.message} retry={() => void context.refetch()} />
        )}
      </div>
    );
  }

  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="PARTICIPANT / TEAM"
        title="Build your team"
        description="Create, join, or opt into the event's looking-for-team pool before registration closes."
      />
      {notice ? (
        <div className="context-notice team-notice" role="status">
          <span aria-hidden="true">✓</span>
          <p>{notice}</p>
          <ActionButton tone="quiet" onClick={() => setNotice(null)}>
            Dismiss
          </ActionButton>
        </div>
      ) : null}
      {mutationError ? (
        <ErrorState
          message={
            mutationError instanceof Error ? mutationError.message : "The team action failed"
          }
        />
      ) : null}
      {explicitTeamMismatch ? (
        <EmptyState
          title="Team not found"
          action={<ActionLink to="/participant/team/current">Open your team</ActionLink>}
        >
          This address does not match your active team for the event.
        </EmptyState>
      ) : team ? (
        <div className="team-workspace-layout">
          <Panel
            label="TEAM / ROSTER"
            title={team.name}
            className="span-two"
            action={
              <Badge tone={team.status === "submitted" ? "success" : "neutral"}>
                {team.status}
              </Badge>
            }
          >
            <div className="team-summary-strip">
              <div>
                <span>EVENT</span>
                <strong>{context.data.event.name}</strong>
              </div>
              <div>
                <span>MEMBERS</span>
                <strong>
                  {team.members.length} / {context.data.event.teamSize.max}
                </strong>
              </div>
              <div>
                <span>CLOSES</span>
                <strong>
                  {context.data.event.registrationClosesAt
                    ? new Date(context.data.event.registrationClosesAt).toLocaleString()
                    : "Not scheduled"}
                </strong>
              </div>
            </div>
            <ol className="team-roster">
              {team.members.map((member, index) => (
                <li className="team-member-row" key={member.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{member.name}</strong>
                    <small>@{member.github}</small>
                  </div>
                  {member.id === team.captainId ? <Badge tone="info">captain</Badge> : <span />}
                  <Badge
                    tone={
                      member.profileStatus === "ready"
                        ? "success"
                        : member.profileStatus === "failed"
                          ? "error"
                          : "warning"
                    }
                  >
                    profile {member.profileStatus}
                  </Badge>
                  {isCaptain && member.id !== team.captainId && team.status === "draft" ? (
                    <button
                      type="button"
                      className="roster-remove"
                      disabled={removeMember.isPending}
                      onClick={() => removeMember.mutate({ id: team.id, memberId: member.id })}
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
          </Panel>
          <Panel label="INVITE / PRIVATE" title="Add teammates">
            {team.status === "draft" ? (
              <div className="invite-code-block">
                <span>INVITE CODE</span>
                <strong>{team.inviteCode}</strong>
                <p>
                  Share this code privately. A teammate must already have an application for{" "}
                  {context.data.event.name}.
                </p>
                <ActionButton
                  tone="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(team.inviteCode).then(() => {
                      setNotice("Invite code copied.");
                    });
                  }}
                >
                  Copy code
                </ActionButton>
                {isCaptain ? (
                  <ActionButton
                    tone="quiet"
                    disabled={resetInvite.isPending}
                    onClick={() => resetInvite.mutate(team.id)}
                  >
                    {resetInvite.isPending ? "Resetting…" : "Reset code"}
                  </ActionButton>
                ) : null}
              </div>
            ) : (
              <p className="muted-copy">Invites are disabled after the captain submits the team.</p>
            )}
          </Panel>
          <Panel label="SUBMISSION / CAPTAIN" title="Lock this team">
            {!isCaptain ? (
              <p className="muted-copy">Only the team captain can submit the roster.</p>
            ) : team.status !== "draft" ? (
              <div className="submission-confirmed">
                <Badge tone="success">submitted</Badge>
                <p>
                  This roster is locked for organizer review
                  {team.submittedAt ? ` since ${new Date(team.submittedAt).toLocaleString()}` : ""}.
                </p>
              </div>
            ) : (
              <div className="team-submit-block">
                {submitBlockers.length > 0 ? (
                  <ul className="terminal-list team-blockers">
                    {submitBlockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted-copy">
                    The roster and all evidence profiles are ready. Submission locks membership.
                  </p>
                )}
                <ActionButton
                  disabled={submitBlockers.length > 0 || submitTeam.isPending}
                  onClick={() => submitTeam.mutate(team.id)}
                >
                  {submitTeam.isPending ? "Submitting…" : "Submit team"}
                </ActionButton>
              </div>
            )}
            {team.status === "draft" ? (
              <div className="team-leave-row">
                <p>
                  Leaving removes you from this roster. If you are captain, captaincy transfers to
                  the earliest joined member.
                </p>
                <ActionButton
                  tone="danger"
                  disabled={leaveTeam.isPending}
                  onClick={() => leaveTeam.mutate(team.id)}
                >
                  {leaveTeam.isPending ? "Leaving…" : "Leave team"}
                </ActionButton>
              </div>
            ) : null}
          </Panel>
        </div>
      ) : (
        <div className="team-choice-layout">
          <Panel label="TEAM / START" title="Choose a path" className="span-two">
            <div className="choice-grid">
              <button
                type="button"
                className={mode === "create" ? "choice-card selected" : "choice-card"}
                onClick={() => setMode("create")}
              >
                <span>01</span>
                <strong>Create a team</strong>
                <p>Become captain and receive a private invite code and link.</p>
              </button>
              <button
                type="button"
                className={mode === "join" ? "choice-card selected" : "choice-card"}
                onClick={() => setMode("join")}
              >
                <span>02</span>
                <strong>Join with a code</strong>
                <p>Use the eight-character code shared by a team captain.</p>
              </button>
              <button
                type="button"
                className={
                  context.data.registration.lookingForTeam ? "choice-card selected" : "choice-card"
                }
                onClick={() => lookingForTeam.mutate(!context.data.registration.lookingForTeam)}
                disabled={lookingForTeam.isPending}
              >
                <span>03</span>
                <strong>
                  {context.data.registration.lookingForTeam
                    ? "Listed for teammates"
                    : "Looking for a team"}
                </strong>
                <p>
                  {context.data.registration.lookingForTeam
                    ? "Select again to leave the pool."
                    : "Share your name, college, and top three skills with applicants in this event."}
                </p>
              </button>
            </div>
            {mode === "create" ? (
              <div className="inline-form">
                <Field label="Team name" hint="2–80 characters. You become captain.">
                  <TextInput
                    placeholder="Enter a team name"
                    value={teamName}
                    maxLength={80}
                    onChange={(event) => setTeamName(event.target.value)}
                  />
                </Field>
                <ActionButton
                  disabled={teamName.trim().length < 2 || createTeam.isPending}
                  onClick={() => createTeam.mutate()}
                >
                  {createTeam.isPending ? "Creating…" : "Create team"}
                </ActionButton>
              </div>
            ) : null}
            {mode === "join" ? (
              <div className="inline-form">
                <Field label="Invite code">
                  <TextInput
                    placeholder="8-character code"
                    value={inviteCode}
                    maxLength={12}
                    onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                  />
                </Field>
                <ActionButton
                  disabled={inviteCode.replace(/[^A-Z0-9]/g, "").length !== 8 || joinTeam.isPending}
                  onClick={() => joinTeam.mutate()}
                >
                  {joinTeam.isPending ? "Joining…" : "Join team"}
                </ActionButton>
              </div>
            ) : null}
          </Panel>
          <Panel label="RULES / EVENT" title={context.data.event.name}>
            <ul className="terminal-list">
              <li>One team per person for each event.</li>
              <li>Only the captain can submit or remove members.</li>
              <li>The team locks when registration closes.</li>
              <li>
                This event requires {context.data.event.teamSize.min}–
                {context.data.event.teamSize.max} members.
              </li>
            </ul>
            {context.data.event.registrationClosesAt ? (
              <div className="deadline-readout">
                <span>REGISTRATION CLOSES</span>
                <strong>
                  {new Date(context.data.event.registrationClosesAt).toLocaleString()}
                </strong>
              </div>
            ) : null}
          </Panel>
        </div>
      )}
    </div>
  );
}

export function ParticipantStatusPage() {
  const { applicationId } = useParams();
  const hasApplication = applicationId && applicationId !== "current";
  const application = useQuery({
    queryKey: ["participant-application", applicationId],
    queryFn: () => getParticipantApplication(applicationId ?? ""),
    enabled: Boolean(hasApplication),
    retry: false,
  });
  const statusCopy = {
    draft: "Your evidence profile and team can still be completed before registration closes.",
    submitted:
      "Your team is submitted. You can review your own evidence while the organizer prepares the shortlist.",
    under_review:
      "The organizer is reviewing submitted teams. Rank and implied odds remain private.",
    selected: "Your team was selected. Confirm attendance before the RSVP deadline.",
    waitlisted:
      "Your team is on the waitlist. Other teams and hidden shortlist parameters remain private.",
    not_selected:
      "Your team was not selected for this event. Your own evidence profile remains available.",
    confirmed: "Your attendance is confirmed for this event.",
    declined: "Your team declined its selected place.",
  } as const;

  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="PARTICIPANT / STATUS"
        title="Application status"
        description="Your team decision, deadlines, and RSVP appear here when an application exists."
      />
      <Panel
        label="APPLICATION / DECISION"
        title={
          application.data?.event.name ??
          (hasApplication ? "Loading application" : "No active application")
        }
      >
        {application.isPending && hasApplication ? (
          <div className="loading-state">Loading application…</div>
        ) : null}
        {application.isError || !hasApplication ? (
          <EmptyState
            title={hasApplication ? "Application not found" : "Start with a published event"}
            action={<ActionLink to="/">Browse events</ActionLink>}
          >
            {hasApplication
              ? "This application could not be loaded for the signed-in account."
              : "Your application status will never expose another team's rank or score."}
          </EmptyState>
        ) : null}
        {application.data ? (
          <div className="application-decision">
            <Badge
              tone={
                application.data.status === "selected" || application.data.status === "confirmed"
                  ? "success"
                  : "neutral"
              }
            >
              {application.data.status.replace("_", " ")}
            </Badge>
            <h2>{statusCopy[application.data.status]}</h2>
            <dl className="compact-definition-list">
              <div>
                <dt>Last updated</dt>
                <dd>{new Date(application.data.updatedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Team</dt>
                <dd>{application.data.teamId ? "Connected" : "Not formed"}</dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{application.data.event.timeline?.timezone ?? "Unavailable"}</dd>
              </div>
            </dl>
            {!application.data.teamId && application.data.status === "draft" ? (
              <ActionLink to="/participant/team/current">Create or join a team</ActionLink>
            ) : null}
          </div>
        ) : null}
      </Panel>
      <section className="status-legend" aria-label="Possible application states">
        <span>Possible states</span>
        {[
          "draft",
          "submitted",
          "under review",
          "selected",
          "waitlisted",
          "not selected",
          "confirmed",
          "declined",
        ].map((status) => (
          <code key={status}>{status}</code>
        ))}
      </section>
    </div>
  );
}

export function ParticipantDataPage() {
  const actions = useMemo(
    () => [
      {
        title: "Download your data",
        detail: "Export your profile, applications, team memberships, and reports.",
      },
      {
        title: "Revoke profile consent",
        detail: "Stop future automated processing. Existing event decisions remain auditable.",
      },
      {
        title: "Delete your account",
        detail: "Request deletion subject to event audit and legal retention requirements.",
      },
    ],
    [],
  );

  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="PARTICIPANT / DATA"
        title="Data and consent"
        description="See what the product uses, correct evidence, export your records, or request deletion."
      />
      <div className="data-settings-grid">
        <Panel label="ACCESS / GITHUB" title="Connected account">
          <EmptyState
            title="No GitHub account connected"
            action={<ActionLink to="/login">Connect GitHub</ActionLink>}
          >
            TalentRadar requests identity and email scopes only.
          </EmptyState>
        </Panel>
        <Panel label="CONTROL / REQUESTS" title="Your controls">
          <div className="settings-actions">
            {actions.map((action, index) => (
              <div key={action.title}>
                <span>0{index + 1}</span>
                <div>
                  <strong>{action.title}</strong>
                  <p>{action.detail}</p>
                </div>
                <ActionButton tone={index === 2 ? "danger" : "secondary"} disabled>
                  Open
                </ActionButton>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
