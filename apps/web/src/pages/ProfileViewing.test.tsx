import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ProfileModal } from "../components/ProfileModal";
import { StatusProvider } from "../components/statusline";
import type { OrganizerShortlistData, ShortlistRunPerson } from "../lib/api";
import { profileFixture } from "../test/profile-fixture";
import { EventSectionPage } from "./OrganizerPages";
import { ShortlistWorkspacePage } from "./ShortlistPages";

afterEach(() => vi.unstubAllGlobals());

function mockApi(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    return Response.json(routes[path] ?? { user: { login: "organizer" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function showPage(path: string, route: string, element: ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <StatusProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={element} />
          </Routes>
        </MemoryRouter>
      </StatusProvider>
    </QueryClientProvider>,
  );
}

it("opens a participant profile from the participants page", async () => {
  mockApi({
    "/api/organizer/events/evt": { event: { id: "evt", name: "Build Night" } },
    "/api/organizer/events/evt/corrections": { corrections: [] },
    "/api/organizer/events/evt/operations": {
      participants: [
        {
          ...profileFixture.person,
          registrationId: "registration",
          verified: true,
          profileStatus: "ready",
          status: "submitted",
        },
      ],
      teams: [],
    },
    "/api/organizer/events/evt/participants/riya/profile": profileFixture,
  });
  showPage(
    "/organizer/events/evt/participants",
    "organizer/events/:eventId/participants",
    <EventSectionPage section="participants" />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "View profile" }));
  const modal = await screen.findByRole("dialog", { name: "Riya Patel · profile" });
  expect(await within(modal).findByText("Original work")).toBeInTheDocument();
  fireEvent.click(within(modal).getByText(/3\.0\/5/));
  expect(within(modal).getByRole("link", { name: /riya\/app\/server.ts/ })).toHaveAttribute(
    "href",
    "https://github.com/riya/app/blob/abc1234/server.ts",
  );
  fireEvent.click(within(modal).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("opens team and individual member profiles from the Teams page", async () => {
  const api = mockApi({
    "/api/organizer/events/evt": { event: { id: "evt", name: "Build Night" } },
    "/api/organizer/events/evt/operations": {
      participants: [],
      teams: [
        {
          id: "team",
          name: "Null Pointers",
          captainId: "riya",
          status: "submitted",
          members: [
            { id: "riya", name: "Riya Patel", github: "riya", profileStatus: "ready" },
            { id: "dev", name: "Dev", github: "dev", profileStatus: "building" },
          ],
        },
      ],
    },
    "/api/organizer/events/evt/participants/riya/profile": profileFixture,
    "/api/organizer/events/evt/participants/dev/profile": {
      person: { personId: "dev", name: "Dev", github: "dev" },
      profile: { ...profileFixture.profile, status: "building", displayName: "Dev" },
    },
  });
  showPage(
    "/organizer/events/evt/teams",
    "organizer/events/:eventId/teams",
    <EventSectionPage section="teams" />,
  );
  const teamButton = await screen.findByRole("button", { name: "Null Pointers" });
  teamButton.focus();
  fireEvent.click(teamButton);
  const teamModal = screen.getByRole("dialog", { name: "Null Pointers · profiles" });
  expect(await within(teamModal).findByText("Original work")).toBeInTheDocument();
  fireEvent.click(within(teamModal).getByRole("button", { name: "Dev" }));
  expect(
    await within(teamModal).findByText(/This profile is still being built/),
  ).toBeInTheDocument();
  fireEvent.click(within(teamModal).getByRole("button", { name: "Close" }));
  expect(teamButton).toHaveFocus();

  fireEvent.click(screen.getByRole("button", { name: "Dev" }));
  const memberModal = screen.getByRole("dialog", { name: "Dev · profile" });
  expect(
    await within(memberModal).findByText(/This profile is still being built/),
  ).toBeInTheDocument();
  expect(
    within(memberModal).queryByRole("navigation", { name: "Team member profiles" }),
  ).not.toBeInTheDocument();
  fireEvent.click(within(memberModal).getByRole("button", { name: "Close" }));

  fireEvent.click(screen.getByRole("row", { name: /Null Pointers/ }));
  expect(screen.getByRole("dialog", { name: "Null Pointers · profiles" })).toBeInTheDocument();
  expect(api.mock.calls.some(([path]) => String(path).endsWith("/participants/dev/profile"))).toBe(
    true,
  );
});

it("opens the team's profiles from shortlisting, switches members, and restores focus after Escape", async () => {
  const ranking = {
    requirements: [
      { skill: "backend", target: 3, weight: 1, coverage: { mode: "any_member" as const } },
    ],
    alpha: 0.7,
    noveltyWeight: 10,
    minFit: 0,
    minTeamSize: 1,
    maxTeamSize: 4,
    confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
  };
  const team = {
    teamId: "team",
    name: "Null Pointers",
    memberIds: ["riya", "dev"],
    submittedAt: "2026-10-01T00:00:00Z",
  };
  const shortlist: OrganizerShortlistData = {
    event: { id: "evt", name: "Build Night", capacity: 10, ranking, quotas: [] },
    profiles: [{ ...profileFixture.profile, personId: "riya" }],
    teams: [
      {
        ...team,
        members: [
          { ...profileFixture.person, profileStatus: "ready", topSkills: [], flags: [] },
          {
            personId: "dev",
            name: "Dev",
            github: "dev",
            profileStatus: "building",
            topSkills: [],
            flags: [],
          },
        ],
      },
    ],
    rankingTeams: [team],
    unmappedColleges: [],
    runs: [],
  };
  const api = mockApi({
    "/api/organizer/events/evt/shortlist": shortlist,
    "/api/organizer/events/evt/shortlist/failures": { failures: [] },
    "/api/organizer/events/evt/participants/riya/profile": profileFixture,
    "/api/organizer/events/evt/participants/dev/profile": {
      person: { personId: "dev", name: "Dev", github: "dev" },
      profile: { ...profileFixture.profile, status: "building", displayName: "Dev" },
    },
  });
  showPage(
    "/organizer/events/evt/shortlist",
    "organizer/events/:eventId/shortlist",
    <ShortlistWorkspacePage />,
  );
  // Blind evaluation is on by default and pseudonymizes team names; turn it off to see real names.
  fireEvent.click(await screen.findByRole("button", { name: /Blind: ON/ }));
  const teamButton = await screen.findByRole("button", { name: "Null Pointers" });
  teamButton.focus();
  fireEvent.click(teamButton);
  const modal = await screen.findByRole("dialog", { name: "Null Pointers · profiles" });
  expect(await within(modal).findByText("Original work")).toBeInTheDocument();
  fireEvent.click(within(modal).getByRole("button", { name: "Dev" }));
  expect(await within(modal).findByText(/This profile is still being built/)).toBeInTheDocument();
  expect(within(modal).queryByText("Original work")).not.toBeInTheDocument();
  expect(api.mock.calls.some(([path]) => String(path).endsWith("/participants/dev/profile"))).toBe(
    true,
  );
  fireEvent(modal, new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(teamButton).toHaveFocus();
  const explain = screen.getByRole("button", { name: "Explain Null Pointers" });
  fireEvent.click(explain);
  expect(explain).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("uses frozen profiles in saved runs without fetching current data", async () => {
  const api = mockApi({});
  const frozen: ShortlistRunPerson = {
    ...profileFixture.person,
    verified: true,
    profileStatus: "ready",
    profile: {
      profileId: "frozen",
      version: 1,
      skills: profileFixture.profile.skills,
      novelty: profileFixture.profile.novelty,
      flags: profileFixture.profile.flags,
      taxonomyVersion: "v3",
      summary: "Frozen assessment",
    },
  };
  function Preview() {
    const [open, setOpen] = useState(true);
    return open ? (
      <ProfileModal
        eventId="evt"
        title="Saved profiles"
        members={[profileFixture.person]}
        frozenPeople={[frozen]}
        onClose={() => setOpen(false)}
      />
    ) : null;
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Preview />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Frozen assessment")).toBeInTheDocument();
  expect(screen.getByText("Profiles from this saved run.")).toBeInTheDocument();
  expect(screen.queryByText("repositories reviewed")).not.toBeInTheDocument();
  expect(api).not.toHaveBeenCalled();
});

it("shows a load error inside the modal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ message: "Participant not found in this event" }, { status: 404 }),
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProfileModal
        eventId="evt"
        title="Profile"
        members={[profileFixture.person]}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Participant not found in this event");
});
