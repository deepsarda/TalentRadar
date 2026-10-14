import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { type PromoteQuickInput, promoteQuickShortlist } from "../lib/api";
import { istDateTimeToIso, slugify, type TimelineKey, timelineFields } from "../lib/event-fields";
import { useStatusLine } from "./statusline";
import { TimelineFields } from "./TimelineFields";
import { ActionButton, Details, Field, Notice, SelectInput, TextArea, TextInput } from "./ui";

/**
 * "Promote to event": asks for what a quick run lacks (public page fields and timeline) and turns
 * it into a draft event that keeps its people, profiles and runs.
 */
export function PromoteQuickForm({ quickId, name }: { quickId: string; name: string }) {
  const navigate = useNavigate();
  const { post } = useStatusLine();
  const [slug, setSlug] = useState(slugify(name));
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<PromoteQuickInput["mode"]>("in_person");
  const [venue, setVenue] = useState("");
  const [dates, setDates] = useState(
    () =>
      Object.fromEntries(timelineFields.map(([key]) => [key, ""])) as Record<TimelineKey, string>,
  );

  const missing = !slug
    ? "a slug"
    : !tagline.trim()
      ? "a tagline"
      : !description.trim()
        ? "a description"
        : mode !== "online" && !venue.trim()
          ? "a venue"
          : timelineFields.find(([key]) => !dates[key])?.[1].toLowerCase();

  const promote = useMutation({
    mutationFn: () =>
      promoteQuickShortlist(quickId, {
        slug,
        tagline: tagline.trim(),
        description: description.trim(),
        mode,
        ...(venue.trim() ? { venue: venue.trim() } : {}),
        timeline: {
          timezone: "Asia/Kolkata",
          ...(Object.fromEntries(
            timelineFields.map(([key]) => [key, istDateTimeToIso(dates[key])]),
          ) as Record<TimelineKey, string>),
        },
      }),
    onSuccess: (event) => {
      post("Promoted to event");
      navigate(`/organizer/events/${event.id}`);
    },
  });

  return (
    <Details summary="promote to event">
      <form
        className="grid max-w-2xl gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!missing) promote.mutate();
        }}
      >
        <Field label="slug" hint={`/h/${slug || "…"}`} required>
          <TextInput
            value={slug}
            maxLength={40}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
          />
        </Field>
        <Field label="tagline" required>
          <TextInput
            value={tagline}
            maxLength={140}
            onChange={(event) => setTagline(event.target.value)}
          />
        </Field>
        <Field label="description" hint="Markdown" required>
          <TextArea
            value={description}
            maxLength={5000}
            rows={4}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="mode" required>
            <SelectInput
              value={mode}
              onChange={(event) => setMode(event.target.value as PromoteQuickInput["mode"])}
            >
              <option value="in_person">in person</option>
              <option value="online">online</option>
              <option value="hybrid">hybrid</option>
            </SelectInput>
          </Field>
          {mode === "online" ? null : (
            <Field label="venue" required>
              <TextInput
                value={venue}
                maxLength={200}
                onChange={(event) => setVenue(event.target.value)}
              />
            </Field>
          )}
          <div className="sm:col-span-2">
            <TimelineFields
              value={dates}
              onChange={(key, value) => setDates((current) => ({ ...current, [key]: value }))}
            />
          </div>
        </div>
        {promote.isError ? (
          <Notice tone="error" tag="error">
            {promote.error.message}
          </Notice>
        ) : null}
        <div className="flex items-baseline justify-end gap-4">
          {missing ? <span className="text-warn">~ add {missing}</span> : null}
          <ActionButton
            tone="primary"
            type="submit"
            disabled={Boolean(missing) || promote.isPending}
          >
            {promote.isPending ? "Promoting…" : "Promote to event"}
          </ActionButton>
        </div>
      </form>
    </Details>
  );
}
