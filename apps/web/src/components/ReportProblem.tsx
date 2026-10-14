import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { type CorrectionReason, reportProfileProblem } from "../lib/api";
import { useStatusLine } from "./statusline";
import { ActionButton, ErrorState, Field, SelectInput, TextAction, TextArea } from "./ui";

const reasons: Array<[CorrectionReason, string]> = [
  ["not_my_repo", "This repo isn't mine"],
  ["missing_repo", "A repo is missing"],
  ["level_off", "This level seems off"],
];

/** "Something wrong?" for one skill on the participant's own profile; reports go to organizers. */
export function ReportProblem({ skill }: { skill: string }) {
  const { post } = useStatusLine();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<CorrectionReason>("level_off");
  const [note, setNote] = useState("");
  const report = useMutation({
    mutationFn: () =>
      reportProfileProblem({ skill, reason, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => {
      setOpen(false);
      post("Report sent.");
    },
  });

  if (report.isSuccess && !open) return <span className="dim">~ reported</span>;
  if (!open) return <TextAction onClick={() => setOpen(true)}>something wrong?</TextAction>;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        report.mutate();
      }}
    >
      <Field label="What's wrong" required>
        <SelectInput
          value={reason}
          onChange={(event) => setReason(event.target.value as CorrectionReason)}
        >
          {reasons.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectInput>
      </Field>
      <Field label="Note">
        <TextArea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          maxLength={500}
        />
      </Field>
      {report.isError ? <ErrorState message={report.error.message} /> : null}
      <div className="flex items-center justify-end gap-4">
        <TextAction onClick={() => setOpen(false)}>cancel</TextAction>
        <ActionButton type="submit" size="sm" disabled={report.isPending}>
          {report.isPending ? "Sending…" : "Send report"}
        </ActionButton>
      </div>
    </form>
  );
}
