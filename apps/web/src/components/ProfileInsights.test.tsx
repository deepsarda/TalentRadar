import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { profileFixture } from "../test/profile-fixture";
import { ProfileInsights } from "./ProfileInsights";

it("shows originality, authorship and review flags without presenting novelty as a percentage", () => {
  render(<ProfileInsights profile={profileFixture.profile} />);
  expect(screen.getByText("Original work")).toBeInTheDocument();
  const repositories = screen.getByRole("list", { name: "Repository originality" });
  expect(within(repositories).getByText("4/5 · Original")).toBeInTheDocument();
  expect(within(repositories).getByRole("link")).toHaveAttribute(
    "href",
    "https://github.com/riya/app/tree/abc1234",
  );
  expect(screen.getByText(/GitHub commit share: 75%/)).toBeInTheDocument();
  expect(screen.getByText("README claims exceed the code evidence.")).toBeInTheDocument();
  expect(screen.queryByText(/25%/)).not.toBeInTheDocument();
});

it("explains when an original repository does not qualify for the novelty signal", () => {
  render(
    <ProfileInsights
      profile={{
        ...profileFixture.profile,
        novelty: 0,
        assessment: {
          thoughts: "Limited code evidence.",
          repositories: profileFixture.profile.assessment.repositories.map((repository) => ({
            ...repository,
            originality: 5,
            qualifiesForNovelty: false,
          })),
        },
      }}
    />,
  );
  expect(screen.getByText("No qualifying evidence")).toBeInTheDocument();
  expect(screen.getByText(/needs level 3\+ skill evidence/)).toBeInTheDocument();
});

it("explains missing saved details without inventing a repository score", () => {
  const { assessment: _, ...profile } = profileFixture.profile;
  render(<ProfileInsights profile={profile} />);
  expect(
    screen.getByText("Repository originality scores are unavailable for this build."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Repository originality" })).not.toBeInTheDocument();
});
