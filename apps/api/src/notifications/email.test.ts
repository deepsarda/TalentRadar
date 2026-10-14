import { describe, expect, it, vi } from "vitest";
import { buildEmail, createEmailNotifier } from "./email.js";

const base = {
  to: "riya@example.edu",
  name: "Riya Shah",
  eventName: "HackSVNIT 2026",
  statusUrl: "https://talentradar.example/participant/applications/abc",
};

describe("email notices", () => {
  it("asks selected teams to RSVP before their deadline", () => {
    const email = buildEmail({
      ...base,
      kind: "selected",
      rsvpDeadlineAt: new Date("2026-11-21T18:29:00Z"),
    });
    expect(email.subject).toBe("You're selected for HackSVNIT 2026");
    expect(email.text).toContain("Hi Riya,");
    expect(email.text).toContain("before 21 Nov 2026");
    expect(email.text).toContain(base.statusUrl);
  });

  it("tells a promoted team a seat was freed", () => {
    const email = buildEmail({ ...base, kind: "promoted" });
    expect(email.subject).toBe("A place opened up at HackSVNIT 2026");
    expect(email.text).toContain("off the waitlist");
  });

  it("builds the waitlist, not-selected and confirmation messages", () => {
    expect(buildEmail({ ...base, kind: "waitlisted" }).subject).toContain("waitlist");
    expect(buildEmail({ ...base, kind: "not_selected" }).text).toContain("not selected");
    expect(buildEmail({ ...base, kind: "rsvp_confirmed" }).subject).toBe(
      "Attendance confirmed: HackSVNIT 2026",
    );
  });

  it("only logs without a Resend key, and posts to Resend with one", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await createEmailNotifier(
      { EMAIL_FROM: "TalentRadar <a@b.c>" },
      fetchSpy as unknown as typeof fetch,
    )({ ...base, kind: "waitlisted" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain("r***@example.edu");
    log.mockRestore();

    await createEmailNotifier(
      { RESEND_API_KEY: "re_test", EMAIL_FROM: "TalentRadar <a@b.c>" },
      fetchSpy as unknown as typeof fetch,
    )({ ...base, kind: "waitlisted" });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(init.body))).toMatchObject({
      to: [base.to],
      from: "TalentRadar <a@b.c>",
    });
  });
});
