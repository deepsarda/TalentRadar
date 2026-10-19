import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import {
  getOrganizerParticipantProfile,
  type OrganizerParticipantProfile,
  type ParticipantProfileResponse,
  type ShortlistRunPerson,
} from "../lib/api";
import { evidenceUrl } from "../lib/evidence";
import { skillLabel, splitSkills } from "../lib/skills";
import { PersonHeader } from "./PersonHeader";
import { ProfileInsights } from "./ProfileInsights";
import { ActionButton, Details, EmptyState, LoadingState, Notice, StateTag } from "./ui";

export interface ProfileMember {
  personId: string;
  name: string;
}

function ProfileContent({
  data,
  frozen = false,
}: {
  data: OrganizerParticipantProfile;
  frozen?: boolean;
}) {
  const { person, profile } = data;
  return (
    <div className="grid gap-6">
      <PersonHeader name={person.name} login={person.github} summary={profile?.summary} />
      <p className="dim">
        {[person.college, person.year ? `Year ${person.year}` : undefined, person.branch]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {profile ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <StateTag state={profile.status} />
            <span className="dim">v{profile.version}</span>
          </div>
          {profile.status === "ready" ? (
            <ReadOnlyProfile profile={profile} frozen={frozen} />
          ) : (
            <Notice tone={profile.status === "failed" ? "warn" : "info"}>
              {profile.status === "failed"
                ? "This profile build failed. Scores are unavailable."
                : "This profile is still being built. Scores will appear when it is ready."}
            </Notice>
          )}
        </>
      ) : (
        <EmptyState title="No profile yet" />
      )}
    </div>
  );
}

function ReadOnlyProfile({
  profile,
  frozen,
}: {
  profile: ParticipantProfileResponse["profile"];
  frozen: boolean;
}) {
  return (
    <>
      <ProfileInsights profile={profile} showRepositoryCount={!frozen} />
      {splitSkills(
        [...profile.skills].sort((left, right) => right.level - left.level),
        (skill) => skill.id,
      ).map((group) => (
        <section className="grid gap-3" key={group.label} aria-label={group.label}>
          <h3>
            {group.label} <span className="dim">{group.items.length}</span>
          </h3>
          {group.items.map((skill) => (
            <Details
              key={skill.id}
              summary={`${skillLabel(skill.id)} · ${skill.level.toFixed(1)}/5`}
              meta={`${skill.confidence} confidence`}
            >
              <div className="grid gap-3">
                <p>{skill.thought}</p>
                {skill.evidence.length ? (
                  <ul className="grid gap-3">
                    {skill.evidence.map((evidence) => (
                      <li
                        className="grid gap-1"
                        key={`${evidence.repository}-${evidence.commitSha}-${evidence.path}`}
                      >
                        <a
                          className="tui-link break-all"
                          href={evidenceUrl(evidence)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {evidence.repository}/{evidence.path} ↗
                        </a>
                        <span className="dim">{evidence.note}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="dim">No files cited.</p>
                )}
              </div>
            </Details>
          ))}
        </section>
      ))}
    </>
  );
}

function LiveProfile({ eventId, personId }: { eventId: string; personId: string }) {
  const query = useQuery({
    queryKey: ["organizer-participant-profile", eventId, personId],
    queryFn: () => getOrganizerParticipantProfile(eventId, personId),
    retry: false,
    refetchInterval: (result) =>
      result.state.data?.profile?.status === "pending" ||
      result.state.data?.profile?.status === "building"
        ? 5000
        : false,
  });
  if (query.isPending) return <LoadingState label="loading profile" />;
  if (query.isError) return <Notice tone="error">{query.error.message}</Notice>;
  return <ProfileContent data={query.data} />;
}

function FrozenProfile({ person }: { person: ShortlistRunPerson | undefined }) {
  if (!person) return <Notice>Profile details were not saved for this participant.</Notice>;
  const profile = person.profile;
  if (!profile)
    return (
      <div className="grid gap-4">
        <PersonHeader name={person.name} login={person.github} summary={undefined} />
        <StateTag state={person.profileStatus} />
        <Notice>
          This profile was {person.profileStatus} when the run was saved. Scores were unavailable.
        </Notice>
      </div>
    );
  return (
    <ProfileContent
      frozen
      data={{
        person,
        profile: {
          ...profile,
          id: profile.profileId,
          status: "ready",
          displayName: person.name,
          repos: [],
        },
      }}
    />
  );
}

export function ProfileModal({
  eventId,
  title,
  members,
  onClose,
  frozenPeople,
}: {
  eventId: string;
  title: string;
  members: ProfileMember[];
  onClose: () => void;
  /** Defined for saved runs: never replace frozen evidence with a current profile. */
  frozenPeople?: ShortlistRunPerson[] | null;
}) {
  const [selected, setSelected] = useState(members[0]?.personId ?? "");
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal tui-modal"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-box w-11/12! max-w-5xl! max-h-[90dvh]!">
        <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b border-line bg-bg p-4">
          <h2 id={titleId}>{title}</h2>
          <ActionButton onClick={onClose}>Close</ActionButton>
        </header>
        <div className="grid gap-6 p-4 sm:p-6">
          {frozenPeople !== undefined ? <p className="dim">Profiles from this saved run.</p> : null}
          {members.length > 1 ? (
            <nav className="flex flex-wrap gap-2" aria-label="Team member profiles">
              {members.map((member) => (
                <ActionButton
                  key={member.personId}
                  tone={selected === member.personId ? "primary" : "default"}
                  aria-pressed={selected === member.personId}
                  onClick={() => setSelected(member.personId)}
                >
                  {member.name}
                </ActionButton>
              ))}
            </nav>
          ) : null}
          {frozenPeople !== undefined ? (
            <FrozenProfile
              key={selected}
              person={frozenPeople?.find((person) => person.personId === selected)}
            />
          ) : selected ? (
            <LiveProfile key={selected} eventId={eventId} personId={selected} />
          ) : (
            <EmptyState title="No team members" />
          )}
        </div>
      </div>
      <button
        type="button"
        className="modal-backdrop"
        aria-label="Dismiss profiles"
        onClick={onClose}
      />
    </dialog>
  );
}
