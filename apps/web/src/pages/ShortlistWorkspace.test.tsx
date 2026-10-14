import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { StatusProvider } from "../components/statusline";
import { ShortlistWorkspacePage } from "./ShortlistPages";

it("a draft event without requirements shows an empty state, not a crash", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.endsWith("/shortlist")
        ? {
            event: {
              id: "evt",
              name: "Draft",
              capacity: 10,
              ranking: { requirements: [], alpha: 0.7, noveltyWeight: 10, minFit: 0 },
              quotas: [],
            },
            profiles: [],
            teams: [],
            rankingTeams: [],
            unmappedColleges: [],
            runs: [],
          }
        : path.endsWith("/failures")
          ? { failures: [] }
          : { user: { login: "deep" } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StatusProvider>
        <MemoryRouter initialEntries={["/organizer/events/evt/shortlist"]}>
          <Routes>
            <Route
              path="organizer/events/:eventId/shortlist"
              element={<ShortlistWorkspacePage />}
            />
          </Routes>
        </MemoryRouter>
      </StatusProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Add requirements first")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Open requirements/ })).toHaveAttribute(
    "href",
    "/organizer/events/evt/requirements",
  );
});
