import { BrowserRouter, Route, Routes } from "react-router-dom";
import { TerminalFrame } from "./layouts/TerminalFrame";
import {
  EventOverviewPage,
  EventSectionPage,
  EventWizardPage,
  OrganizerDashboard,
  QuickShortlistPage,
  SavedRunPage,
  ShortlistWorkspacePage,
} from "./pages/OrganizerPages";
import {
  ParticipantDashboard,
  ParticipantDataPage,
  ParticipantOnboarding,
  ParticipantProfilePage,
  ParticipantStatusPage,
  ParticipantTeamPage,
} from "./pages/ParticipantPages";
import {
  LandingPage,
  LoginPage,
  NotFoundPage,
  PrivacyPage,
  PublicEventPage,
  TermsPage,
} from "./pages/PublicPages";

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
