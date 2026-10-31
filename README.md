# SahyogAI — AI-Powered Disaster Response & Relief Coordination

> **⚠️ Prototype Notice:** This is a hackathon/research prototype. It is NOT certified for real emergency operations. Always contact official emergency services (dial 112 in India) for life-threatening situations.

---

## Project Overview

SahyogAI coordinates disaster emergency requests, volunteers, and relief resources during floods, cyclones, fires, and other emergencies — initially focused on Visakhapatnam, Andhra Pradesh.

**Key capabilities:**
- Multilingual emergency intake (English + Telugu)
- Server-side AI triage via Gemini API (with deterministic fallback)
- Genuine duplicate detection using multi-signal similarity scoring
- Real-time shared dispatch board via Server-Sent Events
- Volunteer assignment and acknowledgment workflow
- Resource inventory with atomic stock management
- Role-based access control (Admin / Coordinator / Volunteer / Analyst)
- Audit trail for all critical actions

---

## Architecture

```
client/public/      → Single-page frontend (HTML + Tailwind + vanilla JS)
server/
  src/
    app.js          → Express entry point
    models/         → Mongoose schemas (Incident, User, Resource, Assignment, AuditEvent)
    routes/         → REST API endpoints
    services/       → AI triage, duplicate detection, audit
    utils/          → DB connection, SSE broadcaster, seed script
  tests/            → Jest + Supertest integration & unit tests
```

**Stack:**  Node.js · Express · MongoDB (Mongoose) · Gemini AI · Server-Sent Events · Tailwind CSS · Chart.js · Leaflet.js

---

## Prerequisites

- Node.js ≥ 18
- MongoDB ≥ 6 (local) **or** a MongoDB Atlas connection string
- (Optional) Google AI Studio API key for live AI triage

---

## Quick Start (Local Development)

### 1. Clone & install

```bash
git clone <repo-url>
cd "Disaster management"
cd server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/sahyogai
JWT_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
GEMINI_API_KEY=<your key from https://aistudio.google.com/ — leave blank for fallback only>
DEMO_MODE=true
ALLOWED_ORIGINS=http://localhost:5000
```

### 3. Seed demo data

```bash
npm run seed
```

This creates:
- `admin` / `Admin@2024!` — Administrator
- `coordinator` / `Coord@2024!` — Emergency Coordinator  
- `analyst` / `Analyst@2024!` — Read-only Analyst
- `kiran_nss`, `priya_redcross`, `team_delta`, `team_braver` / `Demo@2024!` — Demo volunteer accounts
- 6 realistic Visakhapatnam demo incidents
- 6 demo resource inventory entries

The Volunteers page displays each record's ID. Administrators and coordinators can add volunteers, deactivate or reactivate them, update availability, and assign available volunteers to incidents. Deactivation preserves the volunteer ID and assignment history, and is blocked while the volunteer has active assignments.

### 4. Start the server

```bash
npm start          # production
npm run dev        # development (nodemon auto-restart)
```

The server serves both the API and the frontend from `http://localhost:5000`.

### 5. Open the app

Visit: [http://localhost:5000](http://localhost:5000)

Log in with any of the seeded accounts above.

---

## API Configuration

| Setting | Description |
|---------|-------------|
| `GEMINI_API_KEY` | Leave blank → rule-based fallback is used. The UI always shows which engine ran. |
| `DEMO_MODE=true` | Enables `/api/demo/reset` endpoint and demo data seeding. Set to `false` in production. |
| `JWT_SECRET` | Must be a long random string. Generate fresh for each deployment. |

---

## Running Tests

```bash
cd server

# Requires a test MongoDB instance (set MONGODB_URI_TEST env var, or it uses sahyogai_test)
npm test
```

Test coverage includes:
- Valid incident submission (EN + Telugu)
- Empty/invalid report rejection
- AI fallback clearly labeled
- Critical urgency preserved
- Duplicate detection comparing real records
- Concurrent ID uniqueness
- Status transition validation
- Unauthorized access blocked
- Resource stock cannot go negative
- API response never exposes secrets

See `tests/api.test.js` and `tests/triage.test.js` for all test cases.

---

## API Reference

### Authentication
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/login` | — | Login, returns JWT |
| POST | `/api/auth/register` | — (demo mode) | Create account |
| GET | `/api/auth/me` | Bearer | Current user profile |
| POST | `/api/auth/logout` | Bearer | Record logout |

### Incidents
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/incidents` | Optional | List with filters |
| POST | `/api/incidents` | Optional | Create incident |
| GET | `/api/incidents/:id` | Optional | Get detail |
| PATCH | `/api/incidents/:id` | Coordinator+ | Update fields |
| POST | `/api/incidents/:id/status` | Coordinator+ | Change status |
| POST | `/api/incidents/:id/triage` | Optional | Run AI triage |
| GET | `/api/incidents/:id/duplicates` | Required | Get duplicate candidates |
| POST | `/api/incidents/:id/link` | Coordinator+ | Link related incidents |

### Volunteers
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/volunteers` | Required | List volunteers |
| POST | `/api/volunteers` | Coordinator+ | Create a volunteer account |
| GET | `/api/volunteers/me` | Required | Own profile + assignments |
| PATCH | `/api/volunteers/:id/availability` | Required | Update availability |
| DELETE | `/api/volunteers/:id` | Coordinator+ | Deactivate while preserving history and ID |
| PATCH | `/api/volunteers/:id/reactivate` | Coordinator+ | Restore a deactivated volunteer |
| POST | `/api/volunteers/assign?incidentId=X` | Coordinator+ | Assign volunteer |
| PATCH | `/api/volunteers/assignments/:id` | Required | Update progress |

### Resources
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/resources` | Required | List inventory |
| POST | `/api/resources` | Coordinator+ | Create resource |
| POST | `/api/resources/:id/movement` | Coordinator+ | Stock action |

### Analytics
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/analytics/summary` | Coord/Analyst/Admin | Dashboard KPIs |
| GET | `/api/analytics/incidents-by-category` | Coord/Analyst/Admin | Category breakdown |
| GET | `/api/analytics/incidents-by-urgency` | Coord/Analyst/Admin | Urgency breakdown |
| GET | `/api/analytics/incidents-trend` | Coord/Analyst/Admin | Daily trend |
| GET | `/api/analytics/resource-usage` | Coord/Analyst/Admin | Resource metrics |
| GET | `/api/analytics/audit` | Coord/Admin | Audit trail |

### Real-time
| Endpoint | Description |
|----------|-------------|
| GET `/api/events` | SSE stream — events: `incident:created`, `incident:updated`, `incident:status_changed`, `incident:triage_complete`, `assignment:created`, `assignment:updated` |

---

## Deployment

### Environment variables for production
```env
NODE_ENV=production
MONGODB_URI=<Atlas connection string>
JWT_SECRET=<64-byte random hex>
GEMINI_API_KEY=<your key>
DEMO_MODE=false
ALLOWED_ORIGINS=https://yourdomain.com
PORT=5000
```

### Railway / Render / Fly.io
1. Push to GitHub
2. Connect your platform to the `server/` directory
3. Set environment variables in the platform dashboard
4. Set build command: `npm install`
5. Set start command: `npm start`
6. Ensure MongoDB is accessible (use Atlas for managed DB)

### Docker (optional)
A `Dockerfile` can be added at `server/Dockerfile`. The app listens on `PORT` env variable.

---

## Demo Workflow (Hackathon)

1. Open app → click **Login** → sign in as `coordinator / Coord@2024!`
2. Navigate to **Submit SOS** → paste Telugu example → submit
3. Watch AI triage run → see urgency recommendation + fallback label if no API key
4. See duplicate candidates (compared against seeded demo data)
5. Go to **Dispatch Board** → see new incident appear in real time
6. Click **View & Dispatch** → assign a volunteer
7. Go to **Resources** → reserve drinking water for the incident
8. Update incident status: under_review → verified → assigned
9. Open Analytics → see live statistics update
10. Reset demo data: `POST /api/demo/reset { "confirm": "RESET_DEMO_DATA" }`

---

## Known Limitations & Future Work

| Area | Current State | Future |
|------|--------------|--------|
| Maps | Leaflet map shown in modal if coordinates provided | Full incident map view with clustering |
| Geocoding | User-entered text only; no auto-geocoding | Integrate Google Maps / OpenRouteService |
| Offline | Service worker caches shell only; API calls fail offline | Full offline queue with sync |
| SMS/Email | Not implemented — in-app notifications only | Integrate Twilio / SendGrid |
| Image uploads | Schema supports it; upload endpoint not implemented | Add multer file upload route |
| File validation | Schema defined | Implement MIME type + size checks |
| Production HTTPS | App works over HTTP in dev | Use HTTPS proxy (nginx / Caddy) |
| Backup | No automated backup | Add MongoDB Atlas scheduled backups |
| Rate limiting | Per-IP on auth endpoints | Add per-user rate limiting |
| Clustering | Geographic proximity in duplicate detection | Add vector embeddings for semantic clustering |

---

## Feature Status

| Feature | Status |
|---------|--------|
| Multilingual intake (EN + Telugu) | ✅ Implemented |
| Server-side AI triage (Gemini) | ✅ Implemented |
| Rule-based fallback (clearly labeled) | ✅ Implemented |
| Duplicate detection (multi-signal Jaccard) | ✅ Implemented |
| Unique collision-safe incident IDs | ✅ Implemented |
| Server timestamps | ✅ Implemented |
| Persistent MongoDB storage | ✅ Implemented |
| Role-based access control | ✅ Implemented |
| JWT authentication | ✅ Implemented |
| Status transition validation | ✅ Implemented |
| Audit trail | ✅ Implemented |
| Real-time SSE updates | ✅ Implemented |
| Volunteer assignment workflow | ✅ Implemented |
| Admin/coordinator volunteer account management | ✅ Implemented |
| Resource inventory with atomic updates | ✅ Implemented |
| Urgency override with audit | ✅ Implemented |
| Analytics dashboard | ✅ Implemented |
| Demo mode with seed data | ✅ Implemented |
| Demo reset endpoint | ✅ Implemented |
| Contact info restricted server-side | ✅ Implemented |
| PWA service worker (shell cache only) | ✅ Implemented |
| Offline draft saving (localStorage) | ✅ Implemented |
| Map in incident modal (Leaflet) | ✅ Implemented |
| Full incident map view | ⚠️ Partial (modal only) |
| Image upload | ❌ Not implemented |
| Email/SMS notifications | ❌ Not implemented |
| Auto-geocoding of addresses | ❌ Not implemented |
| Full offline queue + sync | ❌ Not implemented |

---

## Security Notes

- All API secrets are server-side only — never in frontend code
- Passwords hashed with bcrypt (12 rounds)
- JWT tokens expire in 7 days
- Rate limiting on auth endpoints (20 req / 15 min)
- Input validation with Joi on all write endpoints
- HTML escaping on all dynamic frontend content
- Contact information never returned in public API responses
- Status transitions validated server-side — client cannot bypass
- Audit log records all significant actions

---

## License

MIT — Prototype only. Not for production emergency use without proper testing, certification, and regulatory compliance review.

---

*Built by Team Kaizen — Visakhapatnam, Andhra Pradesh*  
*SahyogAI Hackathon Prototype — October 2026*
