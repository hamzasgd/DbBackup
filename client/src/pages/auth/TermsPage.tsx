import { Link } from 'react-router-dom'
import { HardDrive, ArrowLeft } from 'lucide-react'

const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: '1. Nature of the Software — You Are the Operator',
    body: [
      'DbBackup is self-hosted, open-source software. You download, deploy, configure, and operate it on infrastructure you control. The authors are not a service provider — they do not host, operate, access, or manage your instance, your databases, your backups, or your servers. All operational responsibility rests solely with you.',
    ],
  },
  {
    title: '2. No Warranty — "As Is"',
    body: [
      'The Software is provided "AS IS" and "AS AVAILABLE", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, accuracy, reliability, and non-infringement. There is no warranty that the Software will function correctly, that backups will be complete or restorable, or that it will detect or prevent every failure or data-loss scenario.',
    ],
  },
  {
    title: '3. Data Loss & Damages — NO RESPONSIBILITY',
    body: [
      'To the maximum extent permitted by applicable law, the authors are NOT responsible for any data loss, data corruption, data leakage, deleted files, failed backups, failed restores, broken databases, missed schedules, lost profits, business interruption, or any other damage (direct, indirect, incidental, special, or consequential) arising from the use of — or inability to use — the Software.',
      'You remain solely responsible for: maintaining your own independent backup strategy; verifying backups and testing restores; securing your server, credentials, encryption keys, and third-party accounts; reviewing changes before destructive operations (restore, delete, retention purge); and complying with laws applicable to your data.',
    ],
  },
  {
    title: '4. Security Features ≠ Security Guarantee',
    body: [
      'The Software implements security measures (credential encryption, optional KMS key custody, passkey login, audit logging, session management, alerts). These features reduce risk but do not eliminate it, and do not constitute a guarantee or insurance of any security outcome. The authors are not liable for any breach or unauthorized access.',
    ],
  },
  {
    title: '5. Third-Party Services',
    body: [
      'The Software can interact with third-party services (AWS S3, Google Drive, Slack, SMTP providers, cloud databases). The authors do not control those services and are not responsible for their availability, security, pricing, or data handling.',
    ],
  },
  {
    title: '6. Not Professional / Legal / Security Advice',
    body: [
      'Nothing in the Software, its documentation, or its security features constitutes professional, legal, security, or compliance advice.',
    ],
  },
  {
    title: '7. Limitation of Liability',
    body: [
      'To the maximum extent permitted by law, the authors\' total aggregate liability arising out of or relating to the Software is zero (0).',
    ],
  },
  {
    title: '8. Indemnification',
    body: [
      'You agree to indemnify and hold harmless the authors from any claim, demand, or damage arising from your deployment, use, or misuse of the Software or your data.',
    ],
  },
  {
    title: '9. Changes & Acceptance',
    body: [
      'These Terms may be updated at any time; continued use constitutes acceptance of the updated Terms. Using the Software — including checking "I agree" during registration — confirms you have read, understood, and accepted them.',
      'Full text: TERMS_OF_SERVICE.md in the repository. These Terms are a standard open-source disclaimer and not a substitute for legal advice.',
    ],
  },
]

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link to="/login" className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="bg-blue-600 rounded-xl p-2">
            <HardDrive className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Terms of Service & Disclaimer</h1>
            <p className="text-xs text-gray-400">DbBackup — use at your own risk</p>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 sm:p-8 space-y-6">
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
            <strong>Short version:</strong> this software is provided "as is" with no warranty.
            The authors are not responsible for any data loss, corruption, leakage, or damage —
            including anything involving the security features. You are the operator of your own
            instance and your data is your responsibility.
          </div>

          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h2 className="text-sm font-semibold text-gray-900 mb-2">{s.title}</h2>
              {s.body.map((p, i) => (
                <p key={i} className="text-sm text-gray-600 leading-relaxed mb-2">{p}</p>
              ))}
            </section>
          ))}

          <div className="pt-4 border-t text-center">
            <Link to="/register" className="text-blue-600 text-sm font-medium hover:underline">
              Back to registration
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
