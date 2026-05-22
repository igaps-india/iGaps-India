import { Link } from 'react-router-dom';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* ── Navbar ──────────────────────────────────────────────── */}
      <nav className="fixed top-0 inset-x-0 z-50 bg-white/90 backdrop-blur border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <span className="text-xl font-bold tracking-tight text-indigo-700">iGaps</span>
          <Link
            to="/apply"
            className="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors shadow"
          >
            Apply Now
          </Link>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <main className="flex-1 flex items-center justify-center px-4 pt-24 pb-16">
        <div className="max-w-3xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-50 text-indigo-700 text-sm font-medium border border-indigo-100">
            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
            Connecting AI Startups with the Right Investors
          </div>

          <h1 className="text-5xl sm:text-6xl font-extrabold tracking-tight text-gray-900 leading-tight">
            Get your AI startup
            <br />
            <span className="text-indigo-600">in front of investors</span>
          </h1>

          <p className="text-xl text-gray-500 leading-relaxed max-w-2xl mx-auto">
            iGaps is a curated screening platform for AI startups seeking investment. Complete our
            structured evaluation and, if you qualify, we connect you directly with the right
            investors.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/apply"
              className="w-full sm:w-auto px-8 py-4 rounded-xl bg-indigo-600 text-white text-lg font-semibold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
            >
              Apply Now — It's Free
            </Link>
            <a
              href="#how-it-works"
              className="w-full sm:w-auto px-8 py-4 rounded-xl border border-gray-200 text-gray-700 text-lg font-medium hover:bg-gray-50 transition-colors"
            >
              How it works
            </a>
          </div>

          <p className="text-sm text-gray-400">
            Takes approximately 20–30 minutes &bull; AI startups only &bull; No upfront fees
          </p>
        </div>
      </main>

      {/* ── How it works ────────────────────────────────────────── */}
      <section id="how-it-works" className="bg-gray-50 py-20 px-4">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">How it works</h2>
          <div className="grid sm:grid-cols-4 gap-8">
            {[
              {
                step: '01',
                title: 'Apply',
                desc: 'Submit a short intake form — email, LinkedIn, website, and CIN. Takes under 2 minutes.',
              },
              {
                step: '02',
                title: 'Answer questions',
                desc: 'Complete 18 structured questions and upload your pitch deck. Then answer 10 adaptive open-ended questions.',
              },
              {
                step: '03',
                title: 'Get evaluated',
                desc: 'Our AI-powered evaluation engine analyses your answers against our structured framework and scores your startup.',
              },
              {
                step: '04',
                title: 'Get connected',
                desc: 'If you score above our threshold, we personally connect you with the most suitable investors in our network.',
              },
            ].map(({ step, title, desc }) => (
              <div key={step} className="flex flex-col gap-3">
                <span className="text-3xl font-black text-indigo-200">{step}</span>
                <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Bottom CTA ──────────────────────────────────────────── */}
      <section className="py-20 px-4 bg-indigo-700 text-white text-center">
        <h2 className="text-3xl font-bold mb-4">Ready to get started?</h2>
        <p className="text-indigo-200 mb-8 max-w-md mx-auto">
          Applications are reviewed on a rolling basis. The sooner you apply, the sooner you can
          connect with investors.
        </p>
        <Link
          to="/apply"
          className="inline-block px-8 py-4 rounded-xl bg-white text-indigo-700 text-lg font-semibold hover:bg-indigo-50 transition-colors"
        >
          Apply Now
        </Link>
      </section>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer className="py-8 px-4 bg-white border-t border-gray-100 text-center text-sm text-gray-400">
        &copy; {new Date().getFullYear()} iGaps. All rights reserved.
      </footer>
    </div>
  );
}
