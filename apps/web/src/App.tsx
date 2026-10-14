import { lazy } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { TerminalFrame } from "./layouts/TerminalFrame";

const LandingPage = lazy(() =>
  import("./pages/PublicPages").then((module) => ({ default: module.LandingPage })),
);
const PublicEventPage = lazy(() =>
  import("./pages/PublicPages").then((module) => ({ default: module.PublicEventPage })),
);
const LoginPage = lazy(() =>
  import("./pages/PublicPages").then((module) => ({ default: module.LoginPage })),
);
const PrivacyPage = lazy(() =>
  import("./pages/PublicPages").then((module) => ({ default: module.PrivacyPage })),
);
const TermsPage = lazy(() =>
  import("./pages/PublicPages").then((module) => ({ default: module.TermsPage })),
);
const NotFoundPage = lazy(() =>
  import("./pages/PublicPages").then((module) => ({ default: module.NotFoundPage })),
);

const ParticipantDashboard = lazy(() =>
  import("./pages/ParticipantPages").then((module) => ({ default: module.ParticipantDashboard })),
);
const ParticipantOnboarding = lazy(() =>
  import("./pages/ParticipantPages").then((module) => ({ default: module.ParticipantOnboarding })),
);
const ParticipantProfilePage = lazy(() =>
  import("./pages/ParticipantPages").then((module) => ({ default: module.ParticipantProfilePage })),
);
const ParticipantTeamPage = lazy(() =>
  import("./pages/ParticipantPages").then((module) => ({ default: module.ParticipantTeamPage })),
);
const ParticipantStatusPage = lazy(() =>
  import("./pages/ParticipantPages").then((module) => ({ default: module.ParticipantStatusPage })),
);
const ParticipantDataPage = lazy(() =>
  import("./pages/ParticipantPages").then((module) => ({ default: module.ParticipantDataPage })),
);

const OrganizerDashboard = lazy(() =>
  import("./pages/OrganizerPages").then((module) => ({ default: module.OrganizerDashboard })),
);
const EventWizardPage = lazy(() =>
  import("./pages/OrganizerPages").then((module) => ({ default: module.EventWizardPage })),
);
const EventOverviewPage = lazy(() =>
  import("./pages/OrganizerPages").then((module) => ({ default: module.EventOverviewPage })),
);
const EventSectionPage = lazy(() =>
  import("./pages/OrganizerPages").then((module) => ({ default: module.EventSectionPage })),
);
const ShortlistWorkspacePage = lazy(() =>
  import("./pages/OrganizerPages").then((module) => ({ default: module.ShortlistWorkspacePage })),
);
const SavedRunPage = lazy(() =>
  import("./pages/OrganizerPages").then((module) => ({ default: module.SavedRunPage })),
);
const QuickShortlistPage = lazy(() =>
  import("./pages/OrganizerPages").then((module) => ({ default: module.QuickShortlistPage })),
);

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<TerminalFrame />}>
          <Route index element={<LandingPage />} />
          <Route path="h/:slug" element={<PublicEventPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="terms" element={<TermsPage />} />

          <Route path="participant" element={<ParticipantDashboard />} />
          <Route path="participant/onboarding" element={<ParticipantOnboarding />} />
          <Route path="participant/apply/:slug" element={<ParticipantOnboarding />} />
          <Route path="participant/profile" element={<ParticipantProfilePage />} />
          <Route path="participant/team/:teamId" element={<ParticipantTeamPage />} />
          <Route
            path="participant/applications/:applicationId/status"
            element={<ParticipantStatusPage />}
          />
          <Route path="participant/settings/data" element={<ParticipantDataPage />} />

          <Route path="organizer" element={<OrganizerDashboard />} />
          <Route path="organizer/events/new" element={<EventWizardPage />} />
          <Route path="organizer/events/:eventId" element={<EventOverviewPage />} />
          <Route
            path="organizer/events/:eventId/requirements"
            element={<EventSectionPage section="requirements" />}
          />
          <Route
            path="organizer/events/:eventId/participants"
            element={<EventSectionPage section="participants" />}
          />
          <Route
            path="organizer/events/:eventId/teams"
            element={<EventSectionPage section="teams" />}
          />
          <Route path="organizer/events/:eventId/shortlist" element={<ShortlistWorkspacePage />} />
          <Route path="organizer/events/:eventId/runs/:runId" element={<SavedRunPage />} />
          <Route
            path="organizer/events/:eventId/settings"
            element={<EventSectionPage section="settings" />}
          />
          <Route path="organizer/quick/new" element={<QuickShortlistPage />} />
          <Route path="organizer/quick/:quickId/import" element={<QuickShortlistPage />} />

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
