import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ComponentProps,
  CSSProperties,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cloneElement, isValidElement, useId } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { splitSkills } from "../lib/skills";

type Tone = "primary" | "default" | "danger" | "quiet";

/** A bordered box whose title sits in the top border, lazygit style. */
export function Pane({
  title,
  meta,
  foot,
  active,
  flush,
  className = "",
  children,
}: PropsWithChildren<{
  title: ReactNode;
  /** Short right-aligned note in the top border: a count, a state. */
  meta?: ReactNode;
  /** Bottom-border note, e.g. "3 of 12". */
  foot?: ReactNode;
  active?: boolean;
  /** Remove inner padding so lists and tables run edge to edge. */
  flush?: boolean;
  className?: string;
}>) {
  return (
    <section className={`pane ${className}`} data-active={active ? "true" : undefined}>
      <header className="pane-title">
        <h2>{title}</h2>
        {meta ? <span className="pane-meta">{meta}</span> : null}
      </header>
      <div className={flush ? "pane-body flush" : "pane-body"}>{children}</div>
      {foot ? <footer className="pane-foot">{foot}</footer> : null}
    </section>
  );
}

/**
 * A GitHub avatar, fetched at half its display size and drawn with hard pixels to sit with the
 * terminal type. Hidden (not a broken-image icon) if the login has no avatar.
 */
export function Avatar({ login, size = 32 }: { login: string; size?: number }) {
  return (
    <img
      className="tui-avatar"
      src={`https://github.com/${encodeURIComponent(login)}.png?size=${Math.ceil(size / 2)}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={(event) => {
        event.currentTarget.style.visibility = "hidden";
      }}
    />
  );
}

export function ScreenHead({
  title,
  children,
  actions,
}: PropsWithChildren<{ title: string; actions?: ReactNode }>) {
  return (
    <header className="screen-head">
      <div className="grid gap-1">
        <h1>{title}</h1>
        {children ? <p>{children}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function ActionButton({
  tone = "default",
  size,
  className = "",
  ...props
}: ComponentProps<"button"> & { tone?: Tone; size?: "sm" }) {
  return (
    <button
      className={`btn tui-btn ${className}`}
      data-tone={tone}
      data-size={size}
      type="button"
      {...props}
    />
  );
}

export function ActionLink({
  tone = "default",
  size,
  className = "",
  ...props
}: LinkProps & { tone?: Tone; size?: "sm" }) {
  return (
    <Link className={`btn tui-btn ${className}`} data-tone={tone} data-size={size} {...props} />
  );
}

/** For server routes (OAuth, CSV downloads) that must leave the SPA router. */
export function ActionAnchor({
  tone = "default",
  className = "",
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { tone?: Tone }) {
  return <a className={`btn tui-btn ${className}`} data-tone={tone} {...props} />;
}

export function TextAction({
  tone,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "danger" }) {
  return <button className="tui-link" data-tone={tone} type="button" {...props} />;
}

export type StatusTone = "ok" | "warn" | "error" | "info" | "neutral";

const toneSymbol: Record<StatusTone, string> = {
  ok: "✓",
  warn: "~",
  error: "✗",
  info: "i",
  neutral: "·",
};

export function Status({
  tone = "neutral",
  size,
  children,
}: PropsWithChildren<{ tone?: StatusTone; size?: "lg" }>) {
  return (
    <span className="tui-status" data-tone={tone} data-size={size}>
      <span aria-hidden="true">{toneSymbol[tone]}</span>
      {children}
    </span>
  );
}

/** Every lifecycle word the API returns, mapped once to a tone. */
const knownStates: Record<string, StatusTone> = {
  selected: "ok",
  confirmed: "ok",
  ready: "ok",
  done: "ok",
  published: "ok",
  submitted: "ok",
  locked: "ok",
  open: "ok",
  verified: "ok",
  high: "ok",
  waitlisted: "warn",
  building: "warn",
  pending: "warn",
  running: "warn",
  queued: "warn",
  profiling: "warn",
  draft: "neutral",
  upcoming: "info",
  under_review: "info",
  medium: "neutral",
  low: "warn",
  unverified: "warn",
  not_selected: "error",
  failed: "error",
  ineligible: "error",
  declined: "error",
  closed: "neutral",
};

export function StateTag({ state, label, size }: { state: string; label?: string; size?: "lg" }) {
  return (
    <Status tone={knownStates[state] ?? "neutral"} {...(size ? { size } : {})}>
      {label ?? state.replaceAll("_", " ")}
    </Status>
  );
}

/** The `*` after a compulsory field's label. Screen readers get `required` from the control instead. */
export function RequiredMark() {
  return (
    <span className="text-warn" aria-hidden="true">
      {" *"}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className = "",
}: PropsWithChildren<{
  label: string;
  hint?: string;
  error?: string;
  /** Compulsory: shows `*` and marks the control `required`. */
  required?: boolean;
  className?: string;
}>) {
  const generatedId = useId();
  const control = isValidElement<{
    id?: string;
    "aria-describedby"?: string;
    required?: boolean;
  }>(children)
    ? children
    : null;
  const controlId = control?.props.id ?? generatedId;
  const descriptionId = `${controlId}-description`;
  const labelledControl = control
    ? cloneElement(control, {
        id: controlId,
        ...(required ? { required: true } : {}),
        ...((error || hint) && !control.props["aria-describedby"]
          ? { "aria-describedby": descriptionId }
          : {}),
      })
    : children;
  return (
    <div className={`field ${className}`}>
      <label className="field-label" htmlFor={controlId}>
        {label}
        {required ? <RequiredMark /> : null}
      </label>
      {labelledControl}
      {error || hint ? (
        <span className="field-note" data-tone={error ? "error" : undefined} id={descriptionId}>
          {error ?? hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input tui-input ${className}`} {...props} />;
}

export function TextArea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea tui-input ${className}`} {...props} />;
}

export function SelectInput({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`select tui-input ${className}`} {...props} />;
}

export function CheckRow({
  checked,
  onChange,
  disabled,
  required,
  children,
}: PropsWithChildren<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  required?: boolean;
}>) {
  return (
    <label className="check-row">
      <input
        className="checkbox tui-check"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        required={required}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {children}
        {required ? <RequiredMark /> : null}
      </span>
    </label>
  );
}

/** A real range input read as `label [=====|---] value`. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (current) => String(current),
  hint,
  compact,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  hint?: string;
  /** Narrow label column, for sliders inside table-like rows. */
  compact?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <div className={compact ? "slider compact" : "slider"}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className="range tui-range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={format(value)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <output htmlFor={id}>{format(value)}</output>
      </div>
      {hint ? <small className="field-note">{hint}</small> : null}
    </div>
  );
}

export function KeyValue({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([key, value], index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and static per render
        <div className="contents" key={index}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({
  tone = "info",
  tag,
  children,
  action,
}: PropsWithChildren<{
  tone?: "info" | "warn" | "error" | "ok";
  tag?: string;
  action?: ReactNode;
}>) {
  return (
    <div className="notice" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      {tag ? <span className="notice-tag">{tag}</span> : null}
      <p>{children}</p>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: PropsWithChildren<{ title: string; action?: ReactNode }>) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <p className="loading-line" role="status">
      {label}
    </p>
  );
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Notice
      tone="error"
      tag="error"
      action={retry ? <ActionButton onClick={retry}>Retry</ActionButton> : undefined}
    >
      {message}
    </Notice>
  );
}

/** `████████░░ 3.6 / 3` in block characters, with a screen-reader sentence. */
export function Bar({
  value,
  max = 5,
  target,
  cells = 10,
  tone,
  label,
  showValue = true,
}: {
  value: number;
  max?: number;
  target?: number;
  cells?: number;
  tone?: "warn" | "error";
  label?: string;
  showValue?: boolean;
}) {
  const filled = Math.max(0, Math.min(cells, Math.round((value / max) * cells)));
  return (
    <span className="bar" data-tone={tone}>
      <span className="sr-only">
        {label ? `${label}: ` : ""}
        {value.toFixed(1)}
        {target === undefined ? ` of ${max}` : `, target ${target.toFixed(1)}`}
      </span>
      <span className="bar-cells" aria-hidden="true">
        {"█".repeat(filled)}
        <i>{"░".repeat(cells - filled)}</i>
      </span>
      {showValue ? (
        <span aria-hidden="true">
          {value.toFixed(1)}
          {target === undefined ? null : <small> / {target.toFixed(1)}</small>}
        </span>
      ) : null}
    </span>
  );
}

/** Real worker events only. Never a fake log line. */
export function LogView({
  lines,
  live,
}: {
  lines: Array<{ key: string; text: string; tone?: "error" }>;
  live?: boolean;
}) {
  return (
    <div className="mockup-code tui-log" aria-live={live ? "polite" : undefined}>
      {lines.map((line, index) => (
        <pre data-prefix={String(index + 1).padStart(3, " ")} data-tone={line.tone} key={line.key}>
          <code>{line.text}</code>
        </pre>
      ))}
    </div>
  );
}

const dateTime = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});
const dateOnly = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

/** Events run in IST (spec: entered in IST, stored in UTC), so render in IST everywhere. */
export function formatDateTime(iso: string) {
  return `${dateTime.format(new Date(iso))} IST`;
}

export function formatDate(iso: string) {
  return dateOnly.format(new Date(iso));
}

/** `T-minus 04d 12h 33m`, or null once the moment has passed. */
export function countdown(iso: string, now: number): string | null {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `T-minus ${pad(Math.floor(minutes / 1440))}d ${pad(Math.floor((minutes % 1440) / 60))}h ${pad(minutes % 60)}m`;
}

/** `deep@talentradar:~/events$ talentradar ls --live`, typed once when `typed`. */
export function Prompt({
  command,
  user = "guest",
  path = "~",
  typed,
}: {
  command: string;
  user?: string;
  path?: string;
  typed?: boolean;
}) {
  return (
    <p className="prompt">
      <span className="prompt-user">{user}@talentradar</span>:
      <span className="prompt-path">{path}</span>${" "}
      <span
        className={typed ? "prompt-cmd typed align-bottom" : "prompt-cmd"}
        style={typed ? ({ "--chars": command.length } as CSSProperties) : undefined}
        key={command}
      >
        {command}
      </span>
    </p>
  );
}

/** A terminal window with session tabs; each tab shows the command that produced it. */
export function TermTabs<Id extends string>({
  label,
  tabs,
  active,
  onChange,
  command,
  user,
  children,
}: PropsWithChildren<{
  label: string;
  tabs: Array<{ id: Id; label: string; count?: number }>;
  active: Id;
  onChange: (id: Id) => void;
  command: string;
  user?: string;
}>) {
  const id = useId();
  const move = (offset: number) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    if (next) onChange(next.id);
  };
  return (
    <section className="term" aria-label={label}>
      <div
        className="tui-tabs"
        role="tablist"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") move(1);
          if (event.key === "ArrowLeft") move(-1);
        }}
      >
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            className="tui-tab"
            id={`${id}-${tab.id}`}
            aria-selected={tab.id === active}
            aria-controls={`${id}-panel`}
            tabIndex={tab.id === active ? 0 : -1}
            key={tab.id}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count === undefined ? null : <kbd>({tab.count})</kbd>}
          </button>
        ))}
      </div>
      <div
        className="term-body"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${active}`}
      >
        <Prompt command={command} typed {...(user ? { user } : {})} />
        {children}
      </div>
    </section>
  );
}

/** Horizontal wizard stepper: `✓ details ── 2 cv ── 3 repos ── 4 review`. */
export function Steps({
  steps,
  current,
  onSelect,
}: {
  steps: readonly string[];
  current: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <ol className="steps-bar" aria-label="Progress">
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "current" : "todo";
        return (
          <li key={step} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <button
              type="button"
              disabled={!onSelect || index > current}
              onClick={() => onSelect?.(index)}
            >
              <span aria-hidden="true">{state === "done" ? "✓" : index + 1}</span> {step}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** `▸ build log  13 events` — secondary content, one click away. */
export function Details({
  summary,
  meta,
  open,
  children,
}: PropsWithChildren<{ summary: string; meta?: ReactNode; open?: boolean }>) {
  return (
    <details className="tui-details" open={open}>
      <summary>
        {summary}
        {meta === undefined ? null : <span className="dim"> {meta}</span>}
      </summary>
      <div className="tui-details-body">{children}</div>
    </details>
  );
}

/** A number the screen is about, big, with a small label under it. */
export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: "warn" }) {
  return (
    <div className="grid">
      <span
        className={`font-display text-6xl leading-none ${tone === "warn" ? "text-warn" : "text-accent"} glow`}
      >
        {value}
      </span>
      <span className="dim">{label}</span>
    </div>
  );
}

/** Renders skill-keyed items in "areas" then "tools" groups, each with a small dim label. */
export function SkillGroups<T>({
  items,
  idOf,
  className = "grid gap-2",
  labelled,
  children,
}: {
  items: readonly T[];
  idOf: (item: T) => string;
  className?: string;
  /** Show the group label even when only one group exists (e.g. next to other labelled groups). */
  labelled?: boolean;
  children: (item: T) => ReactNode;
}) {
  const groups = splitSkills(items, idOf);
  return (
    <div className="grid gap-4">
      {groups.map((group) => (
        <section className="grid gap-2" key={group.label} aria-label={group.label}>
          {labelled || groups.length > 1 ? (
            <h3 className="dim text-sm font-normal">
              {group.label} <span className="text-xs">{group.items.length}</span>
            </h3>
          ) : null}
          <div className={className}>{group.items.map(children)}</div>
        </section>
      ))}
    </div>
  );
}
