import { Link, Route, Routes } from 'react-router-dom'

import { ReviewPage } from './review/review-page.js'
import { HomePage } from './home/home-page.js'
import { RepoPage } from './home/repo-page.js'

export function App() {
  return (
    <Routes>
      <Route path="/review/:sessionId" element={<ReviewPage />} />
      <Route path="/" element={<HomePage />} />
      <Route path="/repos/:owner/:name" element={<RepoPage />} />
      <Route path="*" element={<Placeholder title="Page not found" />} />
    </Routes>
  )
}

function Placeholder({ title }: { title: string }) {
  return (
    <main className="placeholder-page">
      <div className="brand-mark">L</div>
      <h1>{title}</h1>
      <p>Open a review session from the Legible daemon.</p>
      <Link to="/">Return home</Link>
    </main>
  )
}
