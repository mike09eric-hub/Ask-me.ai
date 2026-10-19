# Ask Me.ai — backend starter

This repository contains the first server-backed version of Ask Me.ai: a responsive student-facing web interface, a Gemini-backed question endpoint, and a password-protected admin dashboard.

## Current scope
- Express backend with rate-limited `POST /api/ask`
- Gemini API called only from the server; the key is never sent to the browser
- Admin login with bcrypt password hash and session cookies
- CSRF token checks for admin write actions
- SQLite request metrics and settings
- Admin overview, recent activity, model selection
- Health endpoint at `/health`

## Not implemented yet
End-user accounts, file/PDF upload and analysis, project citation retrieval, user management, payments, multi-provider routing, push notifications, Android packaging, and Play Store publishing are not included in this starter. Do not present these as working features yet.

## Run locally
1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set a random `SESSION_SECRET` (at least 32 characters).
5. Set `GEMINI_API_KEY` in the server environment.
6. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`. Generate a bcrypt hash with:
   `node -e "import('bcryptjs').then(async b=>console.log(await b.hash('YOUR-LONG-PASSWORD',12)))"`
7. Run `npm start`, then open `http://localhost:3000` and `http://localhost:3000/admin`.

## Deploy on Render
Create a Node web service from this repository. Build command: `npm install`. Start command: `npm start`. Add a persistent disk mounted at `/opt/render/project/src/data` and set `DATABASE_DIR=/opt/render/project/src/data`. Add environment variables from `.env.example` in Render's dashboard. Generate a new secret for `SESSION_SECRET`; do not reuse the exposed key from chat. Add the rotated Gemini key directly in Render Environment settings as `GEMINI_API_KEY`.

## Security notes
- Never commit `.env`, API keys, password plaintext, or production secrets.
- The previously shared AI key must be revoked and replaced before deployment.
- Use HTTPS in production.
- Keep this admin dashboard private. Configure strong credentials and rotate them if exposed.
- SQLite on Render requires a persistent disk. Back up the database before updates.
