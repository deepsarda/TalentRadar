# TalentRadar — Full Implementation Plan

Status: draft for review. This document changes the plan only; it does not authorize implementation.

## 1. Source of truth

`TalentRadar — Product & Build Spec.md` is the controlling product and design document.

- If this plan conflicts with that specification, the specification wins.
- A later explicit instruction from the user overrides both.
- Before implementing a feature, re-read its specification section instead of relying on this summary.
- Each pull request or implementation handoff names the specification sections it implements.
- Do not invent product behavior, content, sample users, events, activity, scores, or logs.

User instructions that already override or clarify the specification:

1. Deliver a full production-quality interface, not a component gallery or ranking demo.
2. Public, participant, and organizer experiences must be separate, complete route trees with distinct navigation and layouts.
3. The terminal design applies throughout the product, not only on the shortlist screen.
4. The shipped application contains no demo data. Automated fixtures may exist only in tests and must never be imported into production code.
5. Use Biome for formatting and linting.
6. Deployment must be easy and initially free.

## 2. Build scope

The build includes every must-have and should-have in the specification. Features explicitly listed as cut remain out of scope unless the user changes that decision.

### Must-have product

- GitHub sign-in for participants and organizers.
- GitHub + CV profile pipeline with one cached LLM assessment per participant input set.
- Full versioned taxonomy, proficiency rubric, originality rubric, and few-shot prompt set.
- Quick Shortlist: CSV + optional CV ZIP → mapped import → profiles → shortlist → export.
- Organizer dashboard and complete four-step hackathon wizard.
- Stable public hackathon page with timeline and countdown.
- Participant application, CV upload, repository picker, consent, profile progress, and evidence profile.
- Team creation, joining, captain controls, looking-for-team, submission, and registration locking.
- Organizer shortlist workspace with instant local re-ranking, explanations, saved runs, overrides, publishing, and exports.
- Participant application status with the eight states defined in the specification.
- Complete dark terminal/radar design system across all surfaces.

### Should-have product

- Participant team-fit card.
- Teammate suggestions from the looking-for-team pool.
- Quotas and college aliases.
- Email notifications, RSVP, and waitlist promotion.
- Live model reasoning backed by actual streamed worker output.
- Command palette and documented keyboard shortcuts.
- Print-friendly/PDF export.
- Saved-run comparison.

### Explicitly excluded

- Hackathon recommendation engine.
- Custom registration-form builder.
- Uploaded organizer branding assets; HTTPS image links only.
- Team chat.
- Multiple organizer roles.
- A literal command-line interface.
- Light theme.
- Gemini Batch API.

## 3. Existing repository treatment

Treat the current implementation as a discarded spike.

- Preserve the product specification, Git history, remote configuration, and this plan.
- Replace the current web UI and CSS.
- Replace the undersized taxonomy.
- Regenerate the package lock from a clean dependency graph.
- Rebuild API, worker, persistence, and deployment code from the specification rather than extending empty shells.
- Audit the ranking formula/tests before deciding whether to rewrite or retain them.
- Do not copy an existing file into the new build without reviewing it against the relevant specification section.

Before replacement, preserve the spike in Git so it remains recoverable. The working branch then contains only the new implementation.

## 4. Toolchain and dependency baseline

Use a current, internally consistent toolchain:

- Latest patch of Node.js 24 LTS.
- Current pnpm 12, pinned through `packageManager` and Corepack.
- TypeScript, React, Vite, Tailwind CSS, daisyUI, TanStack Query, Express, MongoDB driver, Zod, Vitest, and Biome resolved to current compatible stable versions when implementation begins.
- `@types/node` matches the Node runtime major.
- Exact dependency versions and a committed lockfile.
- Same Node and pnpm versions locally, in CI, and in both Docker stages.

Dependency work:

1. Re-query registries for every direct dependency.
2. Review migrations and peer compatibility before selecting versions.
3. Generate the lockfile from an empty package store.
4. Run audit, license, duplicate-package, and outdated reports.
5. Keep dependencies only when they reduce meaningful work or risk.
6. Use Renovate or Dependabot for small, isolated update pull requests after launch.

Biome owns formatting, linting, import organization, and CI enforcement. TypeScript uses strict mode with no unchecked implicit boundaries.

## 5. Product surfaces and routes

All three products share one deployment and session, but each has its own application shell.

### Public website

| Route | Content and behavior |
| --- | --- |
| `/` | Clear product explanation, evidence methodology, separate participant/organizer entry points, and real published events |
| `/h/:slug` | Hackathon description, links, venue/mode, requirements and targets, team rules, timeline, live registration state, and countdown |
| `/login` | GitHub permission explanation and sign-in action |
| `/privacy` | Data sources, LLM processing, consent, retention, export, and deletion |
| `/terms` | Service limitations and organizer responsibility |

The public copy is written directly from verified product behavior. It contains no vague slogan, fake statistics, fake testimonial, fake organization, or unsupported capability claim.

### Participant portal

| Route | Content and behavior |
| --- | --- |
| `/participant` | Current applications, profile readiness, team state, deadlines, and next actions |
| `/participant/apply/:slug` | First-time onboarding: details, CV, repositories, consent, and review |
| `/participant/applications/:registrationId/progress` | Real profile build progress, retries, and actionable failure states |
| `/participant/profile` | Own skills, levels, confidence, evidence links, model reasoning, repo selection, CV replacement, and corrections |
| `/participant/profile/:skillId` | Complete evidence and aggregation explanation for one skill |
| `/participant/team/:teamId` | Members, captain controls, invite code/link, build status, team-fit card, and submission state |
| `/participant/looking-for-team/:eventId` | Opt-in pool and teammate suggestions limited to the same event |
| `/participant/applications/:registrationId/status` | Countdown, event details, eight application states, RSVP/decline where applicable |
| `/participant/settings/data` | Connected GitHub account, consent record, export, and deletion |

### Organizer console

| Route | Content and behavior |
| --- | --- |
| `/organizer` | Upcoming/live/past events, registrations, teams, build progress, real failures, and quick runs |
| `/organizer/events/new` | Persisted four-step wizard covering every field in the specification |
| `/organizer/events/:eventId` | Event overview, public status, timeline, capacity, and operational summary |
| `/organizer/events/:eventId/requirements` | Taxonomy search, requirements, weights, targets, coverage, confidence factors, quotas, and aliases |
| `/organizer/events/:eventId/participants` | Registrations, verification, consent, profile state, flags, corrections, and retries |
| `/organizer/events/:eventId/teams` | Team membership, size validity, submission state, and deadline status |
| `/organizer/events/:eventId/shortlist` | Three-pane parameters/results/inspector workspace with local re-ranking |
| `/organizer/events/:eventId/runs/:runId` | Immutable run, explanations, overrides, comparison, publishing, CSV, and print view |
| `/organizer/events/:eventId/settings` | Visibility, timeline, public links, retention, and destructive actions |
| `/organizer/quick/new` | Create a quick shortlist run |
| `/organizer/quick/:quickId/import` | CSV upload, column mapping, validation, CV ZIP matching, and consent attestation |
| `/organizer/quick/:quickId/progress` | Real resumable import/profile progress and row-level failures |
| `/organizer/quick/:quickId/shortlist` | The same shortlist workspace used by full events |

Authorization is enforced by the API, not only by hidden links or client routing.

### Navigation model

The three surfaces are visually related but never mixed into one navigation system.

- **Public:** compact top navigation with Product, Published events, Organizer access, and Sign in. A signed-in account menu shows the portals the current user can actually access.
- **Participant:** event-aware shell with Overview, Profile, Team, Application status, and Data settings. The active event and its registration deadline remain visible.
- **Organizer:** persistent desktop rail with Events and Quick Shortlist, plus event-level tabs for Overview, Requirements, Participants, Teams, Shortlist, Runs, and Settings.
- Users who are both participants and organizers switch portals through the account menu. Switching portals changes the entire shell and preserves the return route.
- Mobile navigation uses a labelled drawer and page title, not a hidden icon-only interface.
- Breadcrumbs appear inside organizer event and quick-run workspaces where the hierarchy is more than one level deep.

### Public homepage composition

The homepage is a narrative page, not a dashboard and not a grid of generic feature cards.

1. **Header:** brand, product explanation link, published events, organizer access, GitHub sign-in.
2. **Opening section:** one factual headline and short paragraph explaining that selected GitHub repositories and a CV become an evidence-backed skill profile used against organizer-defined requirements. Two separate actions lead to published events and the organizer console.
3. **Evidence walkthrough:** one compact visual chain—repository/CV input → deterministic facts → judged quality → profile → team ranking—with clear labels showing which steps use code and which use the model.
4. **Participant path:** what the participant provides, what they can inspect/correct, and what remains private.
5. **Organizer path:** what organizers define, how ranking changes without new model calls, and how evidence/overrides remain traceable.
6. **Explainability section:** the three layers from the specification—evidence, breakdown, decision—shown as a connected drill-down, not fabricated scores.
7. **Published events:** real database results only. When none exist, show a concise empty state rather than invented events.
8. **Data and limits:** public-repository limitation, consent, model use, retention, and links to privacy/terms.
9. **Footer:** product links, privacy, terms, GitHub connection status where relevant.

The opening section must answer “what is this?” and “which path is mine?” without scrolling. It must not use `Build the shortlist`, `Show the proof`, `Evidence over instinct`, or similar slogan-led copy as a substitute for explaining the product.

### Public hackathon page composition

- Event identity, registration state, mode/venue, and primary Apply/Continue action appear first.
- Countdown labels the exact deadline it counts toward and includes the timezone.
- Description and organizer links render below the decision-critical event facts.
- Requirements show label, target, weight visibility, and coverage rule in plain language.
- Team-size/capacity rules and timeline are separate scannable sections.
- Signed-out Apply explains GitHub scopes before redirecting.
- Upcoming, open, closed, already-applied, and unavailable states have distinct copy/actions.
- On mobile, Apply/Continue becomes a sticky bottom action without obscuring content.

### Participant dashboard composition

- The first block shows the participant's current event, application state, deadline, and exactly one next action.
- Profile and team readiness appear as separate progress summaries because they can complete independently.
- Active applications come before completed/past applications.
- No organizer metrics, team rank, cutoff, or other participant data appear anywhere.
- Empty state directs the participant to a real published event list.

### Participant onboarding experience

Use a resumable five-part workflow rather than placing every field on one page:

1. **GitHub identity:** confirmed account and public-repository limitation.
2. **Participant details and CV:** upload state, validation, extraction, and editable name/college/year/branch.
3. **Repository selection:** up to six real public repositories, with fork/archive/size eligibility explained inline.
4. **Consent:** exact processing statement, data sources, model/privacy mode, and retention.
5. **Review and apply:** complete summary, missing requirements, and final submit.

The step rail shows current/completed steps but is not the only navigation. Back, Save and exit, and Continue are explicit. Upload and extraction failures keep the accepted fields and offer retry/replacement. Browser refresh resumes from the server state.

### Participant profile experience

- Profile summary starts with build version, last built time, selected inputs, and any neutral flags.
- Skills are grouped by the taxonomy's domains but remain individually searchable/filterable.
- Each skill row shows level, confidence, contributing repositories, and an explicit `View evidence` action.
- Skill detail follows the specification's order: evidence links at frozen SHAs, per-repository scores, aggregation weights, model reasoning, then the effective level.
- `Something wrong?` opens the three correction reasons from the specification plus a concise note field.
- Model reasoning is visually labelled as interpretation, while file evidence is labelled as proof.
- Rebuild actions explain which changed input invalidates the cache before the participant confirms.

### Team experience

- Team header shows name, submitted/locked state, member count against min/max, and captain.
- Member list shows real profile-build status and the actions allowed by the current user/deadline.
- Invite code and link have copy/reset controls; reset clearly invalidates the old code.
- Team-fit card maps each published requirement to the best member evidence and calls out gaps in plain language.
- Submit remains disabled until team size and required member profiles satisfy the event rules; every blocker is listed beside it.
- Leaving/removing/captain transfer uses explicit confirmation and explains the resulting captain assignment.
- Looking-for-team cards expose only the permitted name, college, and top three skills.

### Application status experience

- Each of the eight states gets distinct status copy, available actions, and a concise event timeline.
- Submitted and under-review states never reveal rank or implied odds.
- Selected shows RSVP deadline and Confirm/Decline actions.
- Waitlisted explains the state without showing other teams or hidden parameters.
- Not-selected remains neutral and links only to the participant's own profile/evidence.
- Confirmed and declined preserve the final choice and event details.

### Organizer dashboard composition

- Page header contains New Hackathon and Quick Shortlist as separate primary workflows.
- Upcoming, live, and past events are grouped into operational tables/cards with registrations, valid teams, ready/failed profiles, and next deadline.
- Real failures needing action appear before activity history.
- Quick runs are visually distinct from events because they have no public page or participant portal.
- Empty state explains both creation paths and does not show sample events or statistics.

### Event wizard experience

- Desktop uses a left step rail and a focused form panel; mobile uses a compact progress header.
- Draft saves after successful field validation and shows a real saved timestamp.
- Step 1 includes a live public-page text preview without inventing an event image.
- Step 2 shows entered event timezone and UTC conversion, and explains which deadline locks teams.
- Step 3 visualizes valid team-size range and capacity as participant seats.
- Step 4 uses taxonomy search results grouped as domain/technology, requirement rows with target/weight/coverage, a structured quota builder, and editable college aliases.
- Review screen summarizes all four steps and distinguishes Save draft from Publish event.
- Leaving with unsaved invalid edits triggers a clear warning; valid autosaved progress is never lost.

### Quick Shortlist import experience

1. **Upload:** separate CSV and optional ZIP controls with limits and selected-file metadata.
2. **Map:** side-by-side source headers and TalentRadar fields, mapping confidence, required-field errors, and sample values from the uploaded file only.
3. **Validate:** row-level error/warning table, normalized GitHub/team/college previews, unmatched CVs, and downloadable error CSV.
4. **Consent:** mandatory attestation with a record of who confirmed it and when.
5. **Process:** overall/row progress from real job events, retryable failures, and safe navigation away.
6. **Review:** summary of ready/failed/unverified profiles before opening the shortlist.

The Google Forms CV limitation from the specification appears before ZIP selection, not after an import fails.

### Shortlist workspace experience

The shortlist is the densest product surface and must remain understandable without hiding the explanation.

- **Workspace header:** event/run name, unsaved-parameter state, ready/incomplete profile counts, Save run, Compare, Export, and Publish.
- **Preflight strip:** unmapped colleges, incomplete profiles, unresolved correction reports, and quota warnings. Each item links to resolution.
- **Left parameter pane:** requirements, targets, weights, coverage, alpha, novelty weight, confidence factors, minimum fit, capacity, waitlist size, quotas, and a Reset-to-saved action.
- **Centre result pane:** rank/status, team/members, fit, depth, novelty, score, and compact flags. Sorting/filtering never changes the underlying rank.
- **Right inspector:** selected-team decision summary, points gained/lost by requirement, best member/evidence, novelty source, flags, cutoff gap, quota effect, override history, and largest-loss what-if.
- Parameter changes update ranks and explanations locally without loading states or network calls. A visible unsaved marker distinguishes exploration from the stored run.
- Saving sends parameters to the server, which recomputes and returns the canonical snapshot.
- Override uses a focused dialog with pin in/pin out, mandatory reason, resulting capacity impact, and immutable audit entry.
- Publish shows the number selected/waitlisted/not-selected, unresolved warnings, and the irreversible frozen-run consequence before confirmation.
- Keyboard selection and shortcuts supplement—not replace—clickable controls.

On mobile, the result list remains the main screen. Parameters and inspector open as full-height labelled drawers, and the selected team remains clear when returning to results.

### UX state and recovery model

Every data-backed route defines these states explicitly:

- initial loading with layout-preserving skeletons;
- true empty state with the next valid action;
- field and submission validation;
- recoverable network/service error with retry;
- authorization/ownership failure without leaking resource existence;
- deleted/closed/expired resource;
- partial processing with successful and failed items separated;
- success confirmation that states what changed and where to go next.

Long-running work is resumable and does not trap the browser on one page. Optimistic UI is limited to safe reversible actions; publishing, team membership, submissions, and overrides wait for server confirmation.

## 6. Interface and content system

Ground every visual decision in `Look and feel` from the specification.

### Full-screen terminal frame

The terminal is the application, not a decorative component placed inside a conventional website.

- Every route renders inside one full-viewport `TerminalFrame`: public website, login, public event, participant portal, organizer console, dialogs, drawers, and error pages.
- The near-black page background continues edge to edge. There is no floating browser mockup, centred dashboard card, or conventional marketing site outside the terminal.
- The frame contains five consistent regions:
  1. a once-per-session boot sequence, capped at 1.5 seconds and immediately skippable;
  2. a title bar with TalentRadar identity, current portal/context, and authenticated account controls;
  3. a navigation/command strip with clickable routes and contextual actions;
  4. the main pane workspace for the current route;
  5. a bottom status line for real feedback, current selection, available shortcuts, and connection/job state.
- Public pages use the same frame with larger whitespace and fewer panes. They do not switch to a separate glossy marketing design.
- Participant pages use the frame as a guided single-workspace flow with a persistent event/deadline context.
- Organizer pages use it like lazygit/btop: persistent navigation, dense panels, selectable rows, inspectors, and contextual status lines.
- Modal dialogs, drawers, menus, and toasts remain visually inside the terminal system even when implemented through React portals.
- Route changes update the title, navigation strip, workspace, and status line; the terminal frame itself remains stable.
- The interface stays fully clickable. Text input is used only for actual form fields and the optional command palette; users never need to type commands.

### daisyUI implementation

daisyUI provides accessible component behavior and state classes, while TalentRadar owns the visual language.

- Define one custom `talentradar` theme with radius, depth, and noise disabled and the specification's exact colour tokens.
- Apply `data-theme="talentradar"` at the application root so every page and portal stays inside the same theme.
- Use daisyUI primitives for buttons, inputs, selects, checkboxes, radios, ranges, file inputs, menus, tabs, tables, drawers, modals, dropdowns, progress, tooltips, alerts, and loading states.
- Use daisyUI `mockup-code` only for real worker logs and streamed reasoning. It is not used to fake the application frame or fabricate command output.
- Override default spacing, borders, focus states, and typography centrally; do not style individual pages into unrelated mini-themes.
- All daisyUI components receive square geometry, no shadows/gradients, high-contrast focus, and the terminal interaction treatments below.
- Build custom components only where the product specification requires behavior daisyUI does not provide: terminal frame/panes, score bars, countdown, evidence chain, explanation card, run comparison, and shortlist inspector.

### Identity

- Dark green-phosphor radar theme on near-black.
- JetBrains Mono throughout.
- Square corners, 1 px borders, no shadows, no gradients.
- Custom daisyUI theme using the specification's colour tokens.
- Full TUI structure without requiring typed commands.
- CSS borders for structure; decorative characters are hidden from assistive technology.

### Terminal interaction grammar

- Primary buttons render as `[ Action ]`; hover and focus invert foreground/background.
- Text fields use a prompt-style label and visible block-caret treatment without replacing the native input caret or semantics.
- Sliders remain native range inputs styled as segmented terminal tracks.
- Selected table rows invert colours; hover, keyboard focus, and selected states remain distinguishable.
- Panes have title bars containing section number/name, contextual status, and relevant actions.
- Tabs resemble terminal workspace tabs and remain real tab/list or navigation semantics.
- Statuses always combine symbol, colour, and word: selected, waitlisted, failed, building, ready, and so on.
- Score bars use block characters visually while exposing a plain numeric accessible label.
- Toasts append as real messages to the status line/history rather than floating rounded cards.
- Dialogs are bordered sub-terminals with a clear title, consequence, primary action, and cancel action.
- Drawers are full-height terminal panes, not rounded mobile sheets.
- The command palette opens as a `:` prompt but every command remains available through normal navigation.
- Keyboard hints appear only when the focused surface supports them; they are never decorative or misleading.

### Motion inside the terminal

- Boot sequence runs once per browser session, lasts no more than 1.5 seconds, and can be skipped with click, keypress, or reduced-motion preference.
- The public hackathon hero line may type once as specified; it immediately resolves to static text for reduced motion.
- Radar sweep/blink effects are subtle, never attached to fake processing, and stop under reduced motion.
- Profile/import logs animate only as actual worker events arrive.
- Live reasoning renders only actual streamed model output.
- Tables, scores, explanations, forms, and route content appear immediately without theatrical delays.

### Different density by surface

- Public website: spacious narrative, readable methodology, clear paths into the two portals.
- Participant portal: guided, reassuring, mobile-first, one primary action per state.
- Organizer console: dense tables, filters, panes, operational status, and evidence inspection.

### Core components

- Brand/header and separate portal navigation shells.
- Buttons, links, inputs, selects, text areas, checkboxes, radios, sliders, and file inputs.
- Field help, validation error, banner, toast, status badge, and progress indicator.
- Pane, table/card adaptive view, tabs, drawer/dialog, dropdown, command palette, and confirmation flow.
- Countdown, score bar, confidence indicator, build log, evidence citation, explanation card, and run diff.
- Skeleton, empty state, error state, permission state, and destructive state.

### Content rules

- Plain sentences, especially for explanations and errors.
- Status always uses a symbol, colour, and word.
- No decorative “system online” claims.
- No placeholder or lorem ipsum in shipped pages.
- No fake log line. Build logs render only persisted worker events.
- No bundled product data. Empty states are real empty states.
- Public copy explains the product before attempting to persuade.
- Participant copy is neutral and avoids framing low confidence or missing public work as low ability.
- Organizer copy is operational: state, consequence, and action.
- Confirmation copy names irreversible effects, especially Publish, Delete, Decline, Reset invite, and Override.
- Errors identify what failed, whether saved work is safe, and the next available action.

### Layout measurements

- Public narrative content uses a readable maximum line length; full-bleed rules and data demonstrations can exceed it.
- Participant forms remain narrow enough to scan and never stretch inputs across the full desktop.
- Organizer console uses the available viewport with a fixed-width navigation rail and independently scrollable panes only where necessary.
- Touch targets remain at least 44 px even when the visual treatment is compact.
- Sticky headers/actions never cover focused fields, validation messages, or the final table row.
- Bottom status bars reserve layout space rather than overlaying content.

### Responsive and accessibility behavior

- Design at 390 px, 768 px, and wide desktop sizes.
- Three-pane shortlist on desktop; explicit parameter and inspector drawers on phones.
- Tables become labelled cards where horizontal scrolling would obscure meaning.
- Complete keyboard operation and visible focus.
- Reduced motion removes typing, sweep, blink, and transition effects.
- WCAG AA contrast for text and interactive boundaries.
- Screen-reader names and live regions for asynchronous status changes.

## 7. Taxonomy and rubrics

Implement the exact two-level model from `Skill taxonomy and proficiency scale`:

1. Twelve fixed domains.
2. Approximately 150 technologies mapped to one or more domains.

The current 17-technology file is discarded.

### Taxonomy content

Cover the ecosystems represented in the specification and modern hackathon work:

- Languages and runtimes.
- Frontend frameworks, styling, state, testing, and build tools.
- Backend frameworks, API technologies, authentication, queues, and realtime tools.
- SQL/NoSQL databases, search, caches, ORMs, and analytics stores.
- Mobile native and cross-platform stacks.
- AI/ML frameworks, model tooling, data science, vision, NLP, and MLOps.
- Data processing, orchestration, warehouses, notebooks, and visualization.
- Cloud providers, containers, orchestration, IaC, CI/CD, and observability.
- Security, cryptography, CTF, reversing, and analysis tools.
- Blockchain languages, contract frameworks, clients, and indexing.
- Systems languages, networking, compilers, operating-system and performance tooling.
- Game engines and rendering/gameplay tools.
- Embedded platforms, RTOS, buses/protocols, and IoT frameworks.
- Design, prototyping, accessibility, and handoff tools where evidence comes mainly from CV/portfolio links.

Each technology stores id, label, aliases, domains, and ecosystem-specific detection rules. Detection supports npm, Python, Cargo, Go, Maven/Gradle, NuGet, Ruby, PHP, pub, Swift, GitHub languages, known files, and known paths.

### Taxonomy behavior

- The full list is versioned and included in the fixed LLM prompt prefix.
- Manifest matches are hints, not proof of proficiency and not limits on model output.
- LLM ids use an enum when supported; unknown ids are always dropped during validation.
- Alias normalization prevents duplicate skills such as React/ReactJS/react.js.
- Profiles, requirements, saved runs, assessments, and prompt caches store the taxonomy version.
- A validation command detects duplicate ids/aliases, invalid domains, and detector conflicts.
- A detector-report command explains why each technology matched a repository.

Implement the five anchored proficiency levels and five originality levels exactly as specified. Store rubric text beside the taxonomy and version both with assessments.

## 8. Authentication and persistence

### GitHub OAuth

- GitHub OAuth for all users.
- Participant scopes limited to `read:user` and `user:email`; only public repositories are processed.
- CSRF `state`, secure callback validation, token encryption at rest, session rotation, and logout invalidation.
- Mongo-backed HttpOnly sessions with `Secure` and appropriate `SameSite` settings.
- Organizer access is established when a signed-in user creates an event.

### MongoDB model

Implement the nine product collections from `Data model`:

- `users`
- `people`
- `assessments`
- `profiles`
- `hackathons`
- `teams`
- `registrations`
- `shortlist_runs`
- `jobs`

Session storage and GridFS are infrastructure collections. Create the specified unique and queue indexes plus TTL indexes for sessions and retained files.

### Data invariants

- One registration per person per hackathon.
- One team membership per person per hackathon.
- Unique public slug and invite code.
- Team size and captain transitions are atomic.
- Published shortlist runs are immutable.
- Overrides append to history; they never erase the calculated result.
- Every important organizer action records actor and timestamp.

## 9. Worker and profile pipeline

Implement the four specification stages without merging responsibilities.

### Fetch

- Participant selects up to six public repositories; Quick Shortlist selects the six most recently pushed valid repositories.
- Skip empty, profile-README, and unchanged forks. Archived repositories are allowed.
- Enforce the 50 MB repository metadata limit.
- Shallow clone with hooks disabled, timeout, symlink/path checks, and guaranteed cleanup.
- Fetch GitHub languages and contributor authorship.
- Validate CV as PDF, maximum 2 MB.
- Render first three pages at 150 DPI with Poppler.
- Extract hyperlinks and scan the hidden text layer with `pdfjs-dist`.

### Deterministic extraction

- Parse supported manifests and taxonomy detection rules.
- Record language mix, authorship, tests, CI, containers, and last push.
- Build the four-level file tree (up to 400 entries) and select up to 20 files per repository: 14 largest source files by nonblank lines, then technology and file-type coverage slots.
- Include small manifests, stylesheets, SQL, delivery and infrastructure files; accept eligible files up to 256 KB.
- Share the source budget across files, redistributing unused shares; mark beginning/middle/end excerpts with original line counts and truncation metadata.
- Exclude dependencies, builds, generated output, lockfiles, minified files, and notebook output.
- Enforce the 4,000–20,000 token range and 12,000 default per repository.

### LLM judgment

- One structured call per participant containing all selected repositories and CV inputs.
- Model-default temperature, medium thinking, pinned model, prompt version, taxonomy version, and 65,536 combined output/thinking-token limit.
- Fixed prefix contains the full review workflow, taxonomy with aliases, rubrics, five domain-diverse calibration examples and a sixth example for broad technology coverage.
- Reconcile each language and detector hint against citable evidence, assess every supported tool and area, and audit coverage before returning the result.
- Require all twelve domain keys per repository: 0 with no evidence, or 1–5 with valid citations. Reject omitted domains; aggregate positive evidence without counting zero-evidence repositories toward level or confidence.
- Reasoning fields precede verdict fields as far as the provider allows; test raw key order with the pinned model.
- Validate repository blocks independently.
- Drop citations to files that were not supplied.
- Drop unknown ids and invalid values.
- Check the provider finish reason before parsing and record response length and output/thinking token counts in progress logs.
- Retry incomplete, unparseable or missing-top-level output at most twice, using compact explanations while keeping medium native thinking, the complete evidence and the repository set.

### Aggregation and caching

- Weighted mean over the top three repositories for each skill.
- Apply authorship, recency, and originality weights exactly from the specification.
- Derive high/medium/low confidence and effective level with configurable factors.
- Derive person novelty only from originality 4/5 repositories showing level 3+ work.
- Cache by canonical hash of repository SHAs, selected input hashes, CV hash, model, prompt, taxonomy, and sampler versions.
- Same inputs return the stored assessment; changed inputs create a new assessment/profile version.

### Durable job system

- MongoDB job queue with atomic claim, attempts, `lockedUntil`, heartbeat, retry time, and terminal error.
- Job types: `fetch_repo`, `render_cv`, `judge_person`, `aggregate_profile`, and `import_row`.
- Concurrency one in the free deployment.
- Rate-limit GitHub by requests and Gemini by requests and tokens.
- Respect `Retry-After`; otherwise use exponential backoff with jitter.
- Store real progress events for the participant and organizer UIs.
- Recover unfinished work after process restarts or Render sleep.

## 10. Deterministic ranking and explanations

Implement `rank(profiles, teams, params)` in shared TypeScript so browser and server use identical code.

### Ranking

- Rank teams; solo applicants are teams of one only when allowed.
- Support domain or technology requirements.
- Support target 1–5 by 0.5, weight 0–5, and `any_member`/`min_members` coverage.
- Compute fit, depth, novelty, and final score exactly from the specification formula.
- Apply confidence-adjusted effective levels.
- Enforce minimum fit and team-size eligibility.
- Break ties by fit, depth, earlier submission, then stable id.
- Fill capacity in participant seats.
- Apply structured quotas after alias normalization and record every swap/shortfall.
- Flag the ±3-point borderline band for human review.

### Explainability

- Evidence layer: per-skill levels, confidence, repository scores, model thought, and fixed-commit file links.
- Breakdown layer: target, best member, coverage, points earned/lost, and novelty source.
- Decision layer: status, cutoff, gap, quota action, override, and what-if result for the largest lost requirement.
- Participants see only their own profile and published requirements/team fit.
- Organizers can inspect all evidence and record correction/override decisions.

### Saved runs

- Save the complete parameters and result snapshot under a name.
- Recompute on the server before persistence.
- Compare movement between two runs.
- Require a reason for pin-in/pin-out overrides.
- Publishing freezes the run and updates participant statuses.

## 11. Organizer implementation

### Dashboard

- Upcoming/live/past event sections.
- Real registration, team, and profile progress.
- Actionable failed jobs and unresolved corrections.
- New Hackathon and Quick Shortlist actions.

### Four-step wizard

Implement every field and validation rule in `Setup wizard — every field`:

1. Basics: name, slug, tagline, Markdown description, image URLs, links, mode, venue.
2. Timeline: all six timestamps entered in event timezone and stored in UTC.
3. Teams/seats: min/max team size, capacity, and CV requirement.
4. Requirements/quotas: taxonomy search, requirements, quotas, aliases, and visibility.

Draft progress persists after each step. Publishing validates the complete document and creates the stable `/h/:slug` page.

### Quick Shortlist

- Stream CSV up to 2,000 rows.
- Safe ZIP ingestion up to 200 MB with entry, decompressed-size, traversal, duplicate, and PDF checks.
- Suggest mappings but require organizer confirmation.
- Normalize GitHub handles and team names.
- Match CV files by mapped filename then email fallback.
- Require explicit consent attestation before creating profile jobs.
- Preserve resumable progress and row-level errors.
- Mark imported GitHub identities unverified.
- Reuse the exact same profile, ranking, run, override, and export services as full events.
- Allow promotion of a quick run into a full event.

### Exports

- UTF-8 BOM CSV with one row per participant and the specified fields.
- Formula-injection-safe cell encoding.
- Print-friendly run page for browser Save as PDF.

## 12. Participant implementation

Implement the full flow from `Participant app`:

1. Open public event and inspect requirements/timeline.
2. Sign in with GitHub and see the exact permissions requested.
3. Upload CV, confirm extracted identity fields, choose up to six repositories, and consent.
4. Continue while the profile builds; real progress remains visible.
5. Create a team, join by eight-character non-confusable invite code, or opt into looking-for-team.
6. Manage the team under captain/member rules.
7. Captain submits; edits remain possible until registration closes.
8. View status and RSVP/decline if selected.

Returning participants reuse their existing profile until inputs change. Replacing the CV or repository selection creates a new cached-input set and profile version.

Implement all eight application states: `draft`, `submitted`, `under_review`, `selected`, `waitlisted`, `not_selected`, `confirmed`, and `declined`.

## 13. Should-have implementation

After the complete must-have path works, add the specification's should-haves in this order:

1. Team-fit card using published requirements and member profiles.
2. Quota editor, selection swaps, alias resolution, and shortfall reporting.
3. Email notifications, selected-team RSVP, and waitlist promotion.
4. Live reasoning using actual streamed model output persisted to jobs.
5. Command palette and `j`/`k`/Enter/`?` shortcuts without breaking standard navigation.
6. Print/PDF output.
7. Saved-run comparison.
8. Teammate suggestions using only opted-in applicants in the same event.

## 14. Security, privacy, and abuse controls

- CSRF protection, secure session rotation, OAuth state validation, and strict authorization on every service method.
- Helmet/CSP, trusted-origin checks, request-size limits, and rate limiting.
- SSRF-resistant URL handling and GitHub-host validation where expected.
- Never execute repository code, hooks, dependencies, binaries, or scripts.
- Prompt-injection delimiters plus schema validation and evidence-path verification.
- ZIP-bomb, traversal, symlink, duplicate-name, and malformed-PDF defenses.
- CSV formula escaping.
- Sanitized Markdown rendering.
- Secret/token redaction.
- CV retention cleanup and participant data deletion.
- Organizer audit trail for publish and overrides.

The specification permits Gemini free tier only with synthetic CVs because free-tier content may be used to improve Google's products. Real CV processing requires paid/provider privacy terms, explicit consent, and the documented retention policy. This limitation must be visible in configuration and privacy copy, not hidden in documentation.

## 15. Testing and verification

### Automated tests

- Taxonomy validation, aliases, manifest detectors, rubrics, aggregation, confidence, and novelty.
- Exact Team Alpha/Team Beta worked example.
- Ranking weights, zero-weight handling, eligibility, ties, capacity, quotas, swaps, overrides, and immutability.
- GitHub/CV/sampler adapters against local fixtures only.
- MongoDB indexes, job leases, cache idempotency, and concurrent team membership.
- API validation, authentication, authorization, uploads, deadlines, publishing, and exports.
- Playwright for Quick Shortlist, organizer event creation/publication, and the complete participant/team/status flow.
- Prompt injection, hidden CV text, invalid citations, malicious ZIPs, huge repositories, and CSV formulas.
- 1,000-team browser/server ranking benchmark and 2,000-row import test.

Test fixtures are never shipped, rendered as product content, or used to fabricate progress.

### Rendered UI review

Inspect every route in a real browser at approximately 390 px, 768 px, and 1440 px. Check:

- loading, empty, success, validation, error, forbidden, and expired states;
- keyboard order, visible focus, reduced motion, zoom, and screen-reader names;
- long names, long errors, dense tables, drawers, dialogs, and file-upload progress;
- participant/organizer data isolation;
- exact public copy and real status behavior.

Lint, typecheck, unit tests, and builds do not replace rendered review.

## 16. Easy, free deployment

Use one same-origin deployment:

- Render Free Docker web service for React assets, Express API, and a concurrency-one worker loop.
- MongoDB Atlas Free cluster for data, sessions, jobs, and temporary GridFS CVs.
- GitHub OAuth/API and the configured Gemini provider.

The Docker image uses Node 24 LTS, pinned pnpm 12, Git, CA certificates, and Poppler. Express binds to `0.0.0.0:$PORT`, serves the Vite build, and provides SPA fallback outside API/auth/health routes.

Deployment configuration includes:

- one `render.yaml` Blueprint;
- generated session secret and prompted MongoDB/GitHub/Gemini secrets;
- liveness and readiness endpoints;
- idempotent index creation;
- graceful shutdown and safe job-lease recovery;
- no persistent filesystem assumptions;
- same-origin secure cookies;
- automatic deploy only after CI succeeds.

Render Free sleeps after inactivity and uses an ephemeral filesystem. All jobs must resume from MongoDB after a cold start. The deployment is suitable for the initial product/demo workload, not high-volume production traffic. Moving the worker to paid compute later must not change API or job contracts.

## 17. Implementation order

Work continuously in this order, without presenting partial scaffolds as the product:

1. Preserve the discarded spike and create the clean workspace.
2. Establish the current toolchain, lockfile, Biome, TypeScript, tests, CI, Docker, and Render skeleton.
3. Produce the sitemap, navigation model, page-state matrix, public copy deck, and desktop/mobile wireframes for all three surfaces from the UX specification above.
4. Implement the terminal design tokens, accessibility primitives, and the three route shells.
5. Implement MongoDB, indexes, GitHub OAuth, sessions, and authorization.
6. Implement the full taxonomy, rubrics, aliases, and detectors.
7. Implement jobs, safe GitHub/CV ingestion, deterministic extraction, LLM validation, aggregation, and caching.
8. Complete ranking, capacity, quotas, explanations, snapshots, overrides, and exports.
9. Build Quick Shortlist end to end with real imports and real progress.
10. Build organizer dashboard, wizard, event operations, shortlist, and publishing.
11. Build the public site and complete participant/profile/team/status portal.
12. Add all should-have features in the stated order.
13. Complete security hardening, accessibility, responsive review, load tests, deployment, cold-start recovery, and rollback checks.

The implementation remains grounded in the relevant specification section throughout. When a requirement is ambiguous, stop and resolve that requirement instead of inventing behavior.

## 18. Completion criteria

The build is complete when:

- Public, participant, and organizer experiences are separate, complete, and polished.
- A real organizer can create a hackathon or quick run and complete the full shortlist workflow.
- A real participant can apply, build an evidence profile, form/submit a team, and receive a permitted result.
- The full 12-domain/~150-technology taxonomy and both rubrics are in use.
- Every score, decision, quota action, and override is explainable from frozen evidence.
- Saved and published runs are server-verified and immutable.
- No shipped page depends on demo data or fake logs.
- Current dependency, security, privacy, accessibility, performance, deployment, and recovery checks pass.
- The deployed application behaves correctly after a Render cold start and worker interruption.
