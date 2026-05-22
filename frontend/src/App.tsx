import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import ApplyPage from './pages/ApplyPage';
import ClosedQuestionsPage from './pages/questionnaire/ClosedQuestionsPage';
import UploadsPage from './pages/questionnaire/UploadsPage';
import OpenQuestionsPage from './pages/questionnaire/OpenQuestionsPage';
import ResultPage from './pages/ResultPage';
import AdminLayout from './pages/admin/AdminLayout';
import AdminApplicationsPage from './pages/admin/AdminApplicationsPage';
import AdminApplicationDetailPage from './pages/admin/AdminApplicationDetailPage';
import AdminKnockoutsPage from './pages/admin/AdminKnockoutsPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/apply" element={<ApplyPage />} />
        <Route path="/q/closed" element={<ClosedQuestionsPage />} />
        <Route path="/q/uploads" element={<UploadsPage />} />
        <Route path="/q/open" element={<OpenQuestionsPage />} />
        <Route path="/result" element={<ResultPage />} />

        {/* Admin — protected behind AdminLayout auth gate */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/applications" replace />} />
          <Route path="applications" element={<AdminApplicationsPage />} />
          <Route path="application/:id" element={<AdminApplicationDetailPage />} />
          <Route path="knockouts" element={<AdminKnockoutsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
