import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { Link, type LinkProps } from "react-router-dom";

export function Panel({
  title,
  label,
  action,
  children,
  className = "",
}: PropsWithChildren<{
  title: string;
  label?: string;
  action?: ReactNode;
  className?: string;
}>) {
  return (
    <section className={`terminal-panel ${className}`}>
      <header className="panel-titlebar">
        <div>
          {label ? <span className="panel-label">{label}</span> : null}
          <h2>{title}</h2>
        </div>
        {action ? <div className="panel-action">{action}</div> : null}
      </header>
      <div className="panel-content">{children}</div>
    </section>
  );
}

export function ActionButton({
  children,
  className = "",
  tone = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "secondary" | "danger" | "quiet";
}) {
  return (
    <button className={`btn terminal-action action-${tone} ${className}`} type="button" {...props}>
      <span aria-hidden="true">[</span>
      <span>{children}</span>
      <span aria-hidden="true">]</span>
    </button>
  );
}

export function ActionLink({
  children,
  className = "",
  tone = "primary",
  ...props
}: LinkProps & {
  tone?: "primary" | "secondary" | "danger" | "quiet";
}) {
  return (
    <Link className={`btn terminal-action action-${tone} ${className}`} {...props}>
      <span aria-hidden="true">[</span>
      <span>{children}</span>
      <span aria-hidden="true">]</span>
    </Link>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: PropsWithChildren<{ tone?: "success" | "warning" | "error" | "neutral" | "info" }>) {
  const symbols = { success: "✓", warning: "~", error: "×", neutral: "·", info: "i" };
  return (
    <span className={`terminal-badge badge-${tone}`}>
      <span aria-hidden="true">{symbols[tone]}</span>
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: PropsWithChildren<{
  label: string;
  hint?: string;
  error?: string;
  className?: string;
}>) {
  return (
    <fieldset className={`terminal-field ${className}`}>
      <legend className="field-label">
        <span aria-hidden="true">›</span> {label}
      </legend>
      {children}
      {error ? <span className="field-error">{error}</span> : null}
      {!error && hint ? <span className="field-hint">{hint}</span> : null}
    </fieldset>
  );
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input terminal-input ${className}`} {...props} />;
}

export function TextArea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea terminal-input ${className}`} {...props} />;
}

export function SelectInput({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`select terminal-input ${className}`} {...props} />;
}

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <div className="terminal-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: PropsWithChildren<{ title: string; action?: ReactNode }>) {
  return (
    <div className="empty-state">
      <span className="empty-glyph" aria-hidden="true">
        ◌
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="loading loading-dots loading-sm" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <div>
        <strong>Request failed</strong>
        <p>{message}</p>
      </div>
      {retry ? <ActionButton onClick={retry}>Retry</ActionButton> : null}
    </div>
  );
}

export function StepRail({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="step-rail" aria-label="Progress">
      {steps.map((step, index) => (
        <li
          className={index === current ? "step-current" : index < current ? "step-done" : ""}
          key={step}
          aria-current={index === current ? "step" : undefined}
        >
          <span>{index < current ? "✓" : String(index + 1).padStart(2, "0")}</span>
          <strong>{step}</strong>
        </li>
      ))}
    </ol>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div className="terminal-progress">
      <div>
        <span>{label}</span>
        <strong>{Math.round(value)}%</strong>
      </div>
      <progress className="progress" value={value} max="100" aria-label={label} />
    </div>
  );
}

export function ScoreBar({ value, target = 5 }: { value: number; target?: number }) {
  const segmentCount = 10;
  const filled = Math.round((Math.min(value, 5) / 5) * segmentCount);
  return (
    <span className="score-bar">
      <span className="visually-hidden">
        Skill evidence level {value.toFixed(1)} out of {target.toFixed(1)}
      </span>
      <span aria-hidden="true">
        {"█".repeat(filled)}
        <i>{"░".repeat(segmentCount - filled)}</i>
      </span>
      <strong>{value.toFixed(1)}</strong>
      <small>/ {target.toFixed(1)}</small>
    </span>
  );
}

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <p>{eyebrow}</p>
        <h1>{title}</h1>
        <span>{description}</span>
      </div>
      {action ? <div className="page-actions">{action}</div> : null}
    </header>
  );
}
