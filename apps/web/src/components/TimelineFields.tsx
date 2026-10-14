import { type TimelineKey, timelineFields } from "../lib/event-fields";
import { Field, TextInput } from "./ui";

/** Six IST datetime-local inputs; values are `YYYY-MM-DDTHH:mm` in IST. */
export function TimelineFields({
  value,
  onChange,
}: {
  value: Record<TimelineKey, string>;
  onChange: (key: TimelineKey, value: string) => void;
}) {
  return (
    <div className="grid items-start gap-4 sm:grid-cols-2">
      {timelineFields.map(([key, label]) => (
        <Field
          label={label}
          key={key}
          required
          {...(key === "registrationClosesAt" ? { hint: "Teams lock at this time." } : {})}
        >
          <TextInput
            type="datetime-local"
            value={value[key]}
            onChange={(event) => onChange(key, event.target.value)}
          />
        </Field>
      ))}
    </div>
  );
}
