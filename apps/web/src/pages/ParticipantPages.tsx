import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
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
  TextInput,
} from "../components/ui";

const onboardingSteps = ["Your details", "CV", "Repositories", "Consent", "Review"] as const;

function ParticipantNotice() {
  return (
    <div className="context-notice">
      <span aria-hidden="true">i</span>
      <p>
        This workspace contains no sample account or application. Sign in with GitHub to load your
        own data.
      </p>
      <ActionLink to="/login" tone="secondary">
        Sign in
      </ActionLink>
    </div>
  );
}

export function ParticipantDashboard() {
  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="PARTICIPANT / OVERVIEW"
        title="Your applications"
        description="Apply to an event, build one reusable evidence profile, and manage your team."
        action={<ActionLink to="/">Browse public events</ActionLink>}
      />
      <ParticipantNotice />

      <div className="metric-strip" role="group" aria-label="Application summary">
        <div>
          <span>APPLICATIONS</span>
          <strong>0</strong>
          <small>No account data loaded</small>
        </div>
        <div>
          <span>OPEN ACTIONS</span>
          <strong>0</strong>
          <small>Nothing requires attention</small>
        </div>
        <div>
          <span>PROFILE</span>
          <strong>—</strong>
          <small>Sign in to check status</small>
        </div>
        <div>
          <span>TEAM</span>
          <strong>—</strong>
          <small>No event selected</small>
        </div>
      </div>

      <div className="dashboard-grid">
        <Panel label="01 / APPLICATIONS" title="Active events" className="span-two">
          <EmptyState
            title="No applications yet"
            action={<ActionLink to="/">Find an event</ActionLink>}
          >
            Applications appear here after you open a published event and start its participant
            flow.
          </EmptyState>
        </Panel>
        <Panel label="02 / PROFILE" title="Evidence profile">
          <div className="profile-readiness">
            <ProgressBar value={0} label="Profile completeness" />
            <dl className="compact-definition-list">
              <div>
                <dt>Identity</dt>
                <dd>Not connected</dd>
              </div>
              <div>
                <dt>CV</dt>
                <dd>Not provided</dd>
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
  const [step, setStep] = useState(0);
  const [consented, setConsented] = useState(false);
  const [details, setDetails] = useState({ name: "", college: "", year: "", branch: "" });

  const updateDetail = (field: keyof typeof details, value: string) => {
    setDetails((current) => ({ ...current, [field]: value }));
  };

  return (
    <div className="portal-page wizard-page">
      <PageHeading
        eyebrow={slug ? `APPLICATION / ${slug.toUpperCase()}` : "PARTICIPANT / ONBOARDING"}
        title="Build your evidence profile"
        description="Confirm your details, choose public work you want assessed, and control consent before processing starts."
      />
      <StepRail steps={onboardingSteps} current={step} />

      <div className="wizard-layout">
        <Panel
          label={`STEP ${step + 1} / ${onboardingSteps.length}`}
          title={onboardingSteps[step]}
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
              <input id="participant-cv" type="file" accept="application/pdf,.pdf" />
              <label className="btn terminal-action action-secondary" htmlFor="participant-cv">
                [ Choose PDF ]
              </label>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="repository-step">
              <div className="context-notice compact">
                <span aria-hidden="true">i</span>
                <p>
                  Connect GitHub to load your public repositories. Private repository permission is
                  never requested.
                </p>
                <ActionLink to="/login" tone="secondary">
                  Connect GitHub
                </ActionLink>
              </div>
              <EmptyState title="No repositories loaded">
                After sign-in, choose up to six public repositories. Pinned repositories are
                selected first, and you remain in control of the final list.
              </EmptyState>
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
                  <dd>Not selected</dd>
                </div>
                <div>
                  <dt>Repositories</dt>
                  <dd>None selected</dd>
                </div>
                <div>
                  <dt>Consent</dt>
                  <dd>
                    <Badge tone={consented ? "success" : "warning"}>
                      {consented ? "Granted" : "Required"}
                    </Badge>
                  </dd>
                </div>
              </dl>
              <div className="submission-note">
                <strong>Nothing has been submitted.</strong>
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
                onClick={() => setStep((value) => Math.min(onboardingSteps.length - 1, value + 1))}
              >
                Continue
              </ActionButton>
            ) : (
              <ActionButton disabled>Build profile</ActionButton>
            )}
          </div>
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
  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="PARTICIPANT / PROFILE"
        title="Your evidence profile"
        description="Every skill must be traceable to repository files at a fixed commit."
        action={<ActionLink to="/participant/onboarding">Complete profile</ActionLink>}
      />
      <ParticipantNotice />
      <div className="two-column-layout">
        <Panel label="EVIDENCE / SKILLS" title="Detected skills" className="span-two">
          <EmptyState title="No profile has been built">
            Connect GitHub, choose repositories, provide consent, and start the profile build to see
            evidence here.
          </EmptyState>
        </Panel>
        <Panel label="INPUT / CV" title="Current CV">
          <EmptyState title="No CV on file">
            A PDF can be added during onboarding. Replacing it later starts a new profile build.
          </EmptyState>
        </Panel>
        <Panel label="INPUT / REPOSITORIES" title="Selected repositories">
          <EmptyState title="No repositories selected">
            Up to six public repositories can be included in the evidence profile.
          </EmptyState>
        </Panel>
      </div>
    </div>
  );
}

export function ParticipantTeamPage() {
  const { teamId } = useParams();
  const [mode, setMode] = useState<"choose" | "create" | "join">("choose");
  const isCurrentPlaceholder = !teamId || teamId === "current";

  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="PARTICIPANT / TEAM"
        title="Build your team"
        description="Create, join, or opt into the event's looking-for-team pool before registration closes."
      />
      {isCurrentPlaceholder ? (
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
              <button type="button" className="choice-card">
                <span>03</span>
                <strong>Looking for a team</strong>
                <p>Share your name, college, and top three skills with applicants in this event.</p>
              </button>
            </div>
            {mode === "create" ? (
              <div className="inline-form">
                <Field label="Team name">
                  <TextInput placeholder="Enter a team name" />
                </Field>
                <ActionButton disabled>Create team</ActionButton>
              </div>
            ) : null}
            {mode === "join" ? (
              <div className="inline-form">
                <Field label="Invite code">
                  <TextInput placeholder="RADAR-XXX" maxLength={10} />
                </Field>
                <ActionButton disabled>Join team</ActionButton>
              </div>
            ) : null}
          </Panel>
          <Panel label="RULES / EVENT" title="Before you submit">
            <ul className="terminal-list">
              <li>One team per person for each event.</li>
              <li>Only the captain can submit or remove members.</li>
              <li>The team locks when registration closes.</li>
              <li>Team size is checked at submission.</li>
            </ul>
          </Panel>
        </div>
      ) : (
        <EmptyState
          title="Team not found"
          action={<ActionLink to="/participant/team/current">Return to team setup</ActionLink>}
        >
          No team is available at this address for the signed-in participant.
        </EmptyState>
      )}
    </div>
  );
}

export function ParticipantStatusPage() {
  const { applicationId } = useParams();
  const hasApplication = applicationId && applicationId !== "current";
  return (
    <div className="portal-page">
      <PageHeading
        eyebrow="PARTICIPANT / STATUS"
        title="Application status"
        description="Your team decision, deadlines, and RSVP appear here when an application exists."
      />
      <Panel
        label="APPLICATION / DECISION"
        title={hasApplication ? "Application unavailable" : "No active application"}
      >
        <EmptyState
          title={hasApplication ? "Application not found" : "Start with a published event"}
          action={<ActionLink to="/">Browse events</ActionLink>}
        >
          {hasApplication
            ? "This application could not be loaded for the signed-in account."
            : "Your application status will never expose another team's rank or score."}
        </EmptyState>
      </Panel>
      <div className="status-legend" role="group" aria-label="Possible application states">
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
      </div>
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
