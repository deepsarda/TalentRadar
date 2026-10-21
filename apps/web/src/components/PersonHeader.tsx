import { Avatar } from "./ui";

export function PersonHeader({
  name,
  login,
  summary,
}: {
  name: string;
  login: string | undefined;
  summary: string | undefined;
}) {
  return (
    <section className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-5 gap-y-3">
      {login ? <Avatar login={login} size={72} /> : <span />}
      <div className="grid min-w-0 gap-1">
        <p className="font-display text-3xl leading-none">{name}</p>
        {login ? (
          <a
            className="dim w-fit"
            href={`https://github.com/${encodeURIComponent(login)}`}
            target="_blank"
            rel="noreferrer"
          >
            @{login} ↗
          </a>
        ) : null}
      </div>
      {summary ? (
        <p className="col-span-2 max-w-[72ch] text-lg leading-snug sm:col-span-1 sm:col-start-2">
          {summary}
        </p>
      ) : null}
    </section>
  );
}
