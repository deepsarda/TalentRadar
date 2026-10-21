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
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === "/api/me") {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({ error: "authentication_required", message: "Sign in required" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ events: [] }),
      });
    }),
  );
});

describe("TalentRadar application shell", () => {
  it("renders the public product without demo records", async () => {
    renderApp();

    expect(
      await screen.findByRole("heading", { name: /skill profiles from real code/i, level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/0 live events/i)).toBeInTheDocument();
    expect(screen.queryByText(/fixture/i)).not.toBeInTheDocument();
    // Fixture people and teams live in tests only; none may render in the shipped page.
    expect(document.body.textContent).not.toMatch(/Team (Alpha|Beta)|Riya|Kabir|Arjun|Meera/);
  });

  it("provides a separate organizer console and validates the event wizard", async () => {
    window.history.pushState({}, "", "/organizer/events/new");
    renderApp();

    expect(
      await screen.findByRole("heading", { name: /create a hackathon workspace/i }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /event name/i }), {
      target: { value: "Build Night" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /tagline/i }), {
      target: { value: "Build a useful product" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /description/i }), {
      target: { value: "A focused overnight hackathon." },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /venue/i }), {
      target: { value: "Innovation Centre" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText(/teams lock at this time/i)).toBeInTheDocument();
  });

  it("provides a separate participant portal", async () => {
    window.history.pushState({}, "", "/participant");
    renderApp();

    expect(
      await screen.findByRole("heading", { level: 1, name: /^\$? ?hi$/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/sign in to see your applications/i)).toBeInTheDocument();
  });
});
