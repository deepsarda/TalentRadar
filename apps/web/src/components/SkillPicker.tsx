import { useEffect, useId, useState } from "react";
import { fuzzyMatch } from "../layouts/TerminalFrame";
import { isArea, skillOptions, splitSkills } from "../lib/skills";

/** Best matches first: exact/prefix, then word start, then substring, then in-order letters. */
export function rankSkills(query: string, exclude: readonly string[] = []) {
  const needle = query.trim().toLowerCase();
  const score = (label: string, id: string) => {
    const text = label.toLowerCase();
    if (!needle) return 0;
    if (text === needle || id === needle) return 0;
    if (text.startsWith(needle) || id.startsWith(needle)) return 1;
    if (text.split(/[^a-z0-9]+/).some((word) => word.startsWith(needle))) return 2;
    if (text.includes(needle) || id.includes(needle)) return 3;
    return fuzzyMatch(needle, `${label} ${id}`) ? 4 : null;
  };
  return skillOptions
    .filter((option) => !exclude.includes(option.id))
    .map((option) => ({ option, rank: score(option.label, option.id) }))
    .filter(
      (entry): entry is { option: (typeof skillOptions)[number]; rank: number } =>
        entry.rank !== null,
    )
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.option);
}

/**
 * A dropdown that turns into a search: click shows the full list (areas and tools grouped),
 * typing filters it. Enter or click adds; already-used ids are hidden.
 */
export function SkillPicker({
  exclude,
  onPick,
  label = "Add skill",
  kind,
}: {
  exclude: readonly string[];
  onPick: (id: string) => void;
  label?: string;
  /** Limit results to areas (taxonomy domains) or tools (technologies). */
  kind?: "area" | "tool";
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  // Like a native select: open upward when there isn't room for the list below.
  const [upward, setUpward] = useState(false);
  const show = (input: HTMLInputElement) => {
    const box = input.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    setUpward(below < 320 && box.top > below);
    setOpen(true);
  };
  const top = rankSkills(query, exclude).filter(
    (option) => kind === undefined || (kind === "area") === isArea(option.id),
  );
  // Group into areas / tools; the group holding the best match comes first, and the
  // cursor walks the list in the order it is drawn.
  const firstIndex = (items: typeof top) => (items[0] ? top.indexOf(items[0]) : -1);
  const groups = splitSkills(top, (option) => option.id).sort(
    (left, right) => firstIndex(left.items) - firstIndex(right.items),
  );
  const matches = groups.flatMap((group) => group.items);

  // Keep the highlighted option visible while arrowing through a long list.
  useEffect(() => {
    if (open) document.getElementById(`${id}-${cursor}`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, id, open]);

  const pick = (skillId: string | undefined) => {
    if (!skillId) return;
    onPick(skillId);
    setQuery("");
    setCursor(0);
    // Close after a pick, so the list never sits over the content that follows.
    setOpen(false);
  };

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          className="input tui-input cursor-pointer pr-8 focus:cursor-text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[cursor] ? `${id}-${cursor}` : undefined}
          autoComplete="off"
          placeholder={
            kind === "area"
              ? "choose an area…"
              : kind === "tool"
                ? "choose a tool…"
                : "choose a skill…"
          }
          value={query}
          onMouseDown={(event) => (open ? setOpen(false) : show(event.currentTarget))}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
            if (!open) show(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!open) {
                show(event.currentTarget);
                return;
              }
              setCursor((value) => Math.min(matches.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (open) pick(matches[cursor]?.id);
              else show(event.currentTarget);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        <span
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-dim"
          aria-hidden="true"
        >
          {open ? "▴" : "▾"}
        </span>
        {open ? (
          <div
            className={`picker-list tui-list ${upward ? "top-auto! bottom-full" : ""}`}
            id={`${id}-list`}
            role="listbox"
          >
            {matches.length === 0 ? <p className="dim px-4 py-1">No match.</p> : null}
            {matches.map((option, index) => [
              groups.length > 1 && groups.some((group) => group.items[0] === option) ? (
                <p className="dim px-4 pt-1 text-sm" key={`label-${option.id}`} aria-hidden="true">
                  {groups.find((group) => group.items[0] === option)?.label}
                </p>
              ) : null,
              <div
                id={`${id}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === cursor}
                key={option.id}
                // mousedown, not click: it fires before the input's blur closes the list
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(option.id);
                }}
                onMouseEnter={() => setCursor(index)}
              >
                <span className="marker">›</span>
                <span>{option.label}</span>
                <span className="dim">{option.id}</span>
              </div>,
            ])}
          </div>
        ) : null}
      </div>
    </div>
  );
}
