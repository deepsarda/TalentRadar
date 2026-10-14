import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
  window.sessionStorage.setItem("talentradar.booted", "1");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [] }),
    }),
  );
});

describe("TalentRadar application shell", () => {
  it("renders the public product without demo records", async () => {
    renderApp();

    expect(
      screen.getByRole("heading", { name: /shortlist teams by the work/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/no events are published yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/fixture/i)).not.toBeInTheDocument();
  });

  it("provides a separate organizer console and complete event wizard", () => {
    window.history.pushState({}, "", "/organizer/events/new");
    renderApp();

    expect(
      screen.getByRole("heading", { name: /create a hackathon workspace/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText(/teams lock at this time/i)).toBeInTheDocument();
  });

  it("provides a separate participant portal", () => {
    window.history.pushState({}, "", "/participant");
    renderApp();

    expect(screen.getByRole("heading", { name: /your applications/i })).toBeInTheDocument();
    expect(screen.getByText(/no applications yet/i)).toBeInTheDocument();
  });
});
