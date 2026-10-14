import type { Environment } from "../config/environment.js";

export type NoticeKind = "selected" | "promoted" | "waitlisted" | "not_selected" | "rsvp_confirmed";

export interface Notice {
  kind: NoticeKind;
  to: string;
  name: string;
  eventName: string;
  /** Absolute link to the participant's status page, when the public origin is known. */
  statusUrl?: string;
  rsvpDeadlineAt?: Date;
  eventStartsAt?: Date;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Sends one notice. Resolves once delivered (or logged); rejects when delivery failed. */
export type Notify = (notice: Notice) => Promise<void>;

const when = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

function ist(date: Date): string {
  return `${when.format(date)} IST`;
}

export function buildEmail(notice: Notice): Email {
  const greeting = `Hi ${notice.name.split(" ")[0] || notice.name},`;
  const link = notice.statusUrl ? `\n\nYour status page: ${notice.statusUrl}` : "";
  const rsvp = notice.rsvpDeadlineAt
    ? `\n\nPlease confirm or decline your place before ${ist(notice.rsvpDeadlineAt)}. Unconfirmed places are released to the waitlist.`
    : "";
  const bodies: Record<NoticeKind, [string, string]> = {
    selected: [
      `You're selected for ${notice.eventName}`,
      `Your team has been selected for ${notice.eventName}.${rsvp}`,
    ],
    promoted: [
      `A place opened up at ${notice.eventName}`,
      `A seat was freed and your team has moved off the waitlist for ${notice.eventName}.${rsvp}`,
    ],
    waitlisted: [
      `You're on the waitlist for ${notice.eventName}`,
      `Your team is on the waitlist for ${notice.eventName}. If a selected team declines, we will email you straight away.`,
    ],
    not_selected: [
      `Your ${notice.eventName} application`,
      `Thank you for applying to ${notice.eventName}. Your team was not selected this time.`,
    ],
    rsvp_confirmed: [
      `Attendance confirmed: ${notice.eventName}`,
      `Your attendance at ${notice.eventName} is confirmed.${notice.eventStartsAt ? ` The event starts ${ist(notice.eventStartsAt)}.` : ""}`,
    ],
  };
  const [subject, body] = bodies[notice.kind];
  return { to: notice.to, subject, text: `${greeting}\n\n${body}${link}\n\n— TalentRadar` };
}

function maskAddress(address: string): string {
  const [local = "", domain = ""] = address.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Resend over plain fetch when RESEND_API_KEY is set; otherwise logs the subject only, so local
 * development and tests never send mail. No retries here: the caller's outbox (registration
 * `notifiedStatus`) re-attempts on the next sweep when this rejects.
 */
export function createEmailNotifier(
  environment: Pick<Environment, "RESEND_API_KEY" | "EMAIL_FROM">,
  fetchImplementation: typeof fetch = fetch,
): Notify {
  return async (notice) => {
    const email = buildEmail(notice);
    if (!environment.RESEND_API_KEY) {
      console.log(`[email:log-only] ${notice.kind} to ${maskAddress(email.to)}: ${email.subject}`);
      return;
    }
    const response = await fetchImplementation("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: environment.EMAIL_FROM,
        to: [email.to],
        subject: email.subject,
        text: email.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Resend rejected the email with ${response.status}`);
  };
}
