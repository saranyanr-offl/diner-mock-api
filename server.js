const express = require('express');
const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || 'demo-key';
let failMode = false; // flip via POST /admin/fail for the failure demo

const atHour = (daysAhead, hour) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const inHours = (h) => {
  const d = new Date(Date.now() + h * 3600 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};

const restaurants = [
  { id: 'R-100', name: 'Trattoria Roma', cuisine: 'Italian', address: '12 Park Street',
    hours: '11:00-22:00', parking: 'Valet and street parking',
    dietary: ['vegetarian', 'vegan', 'gluten-free'], maxPartySize: 8,
    cancellationWindowHours: 24, slotCapacity: 2 },
  { id: 'R-101', name: 'Sakura House', cuisine: 'Japanese', address: '48 Lake Road',
    hours: '12:00-23:00', parking: 'No parking, nearest garage 2 min walk',
    dietary: ['vegetarian', 'shellfish-free options'], maxPartySize: 6,
    cancellationWindowHours: 12, slotCapacity: 3 },
];

const reservations = {
  'RSV-1001': { id: 'RSV-1001', dinerEmail: 'priya@example.com', restaurantId: 'R-100',
    startTime: atHour(3, 19), partySize: 2, status: 'Booked' },
  'RSV-1002': { id: 'RSV-1002', dinerEmail: 'arjun@example.com', restaurantId: 'R-101',
    startTime: inHours(3), partySize: 4, status: 'Booked' }, // inside cancellation window
  // Two bookings fill the 21:00 slot at Trattoria Roma (capacity 2)
  'RSV-2001': { id: 'RSV-2001', dinerEmail: 'x1@example.com', restaurantId: 'R-100',
    startTime: atHour(3, 21), partySize: 2, status: 'Booked' },
  'RSV-2002': { id: 'RSV-2002', dinerEmail: 'x2@example.com', restaurantId: 'R-100',
    startTime: atHour(3, 21), partySize: 2, status: 'Booked' },
};

const rest = (id) => restaurants.find((r) => r.id === id);
const sameEmail = (r, email) =>
  r && email && r.dinerEmail.toLowerCase() === String(email).toLowerCase();
const view = (r) => ({ ...r, dinerEmail: undefined, restaurantName: rest(r.restaurantId).name,
  cancellationWindowHours: rest(r.restaurantId).cancellationWindowHours });

const slotFree = (restaurantId, iso, partySize, ignoreId) => {
  const rs = rest(restaurantId);
  if (!rs || partySize > rs.maxPartySize || new Date(iso) <= new Date()) return false;
  const used = Object.values(reservations).filter((x) => x.id !== ignoreId &&
    x.restaurantId === restaurantId && x.status !== 'Cancelled' &&
    new Date(x.startTime).getTime() === new Date(iso).getTime()).length;
  return used < rs.slotCapacity;
};

app.get('/health', (_req, res) => res.json({ ok: true, failMode }));

app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ message: 'Unauthorized' });
  next();
});

app.post('/admin/fail', (req, res) => {
  failMode = !!req.body.enabled;
  res.json({ failMode });
});

app.use((req, res, next) => {
  if (failMode) return res.status(500).json({ message: 'Simulated outage' });
  next();
});

app.get('/restaurants', (req, res) => {
  const q = String(req.query.name || '').toLowerCase();
  const found = restaurants.find((r) => r.name.toLowerCase().includes(q));
  if (!q || !found) return res.status(404).json({ message: 'Restaurant not found' });
  res.json(found);
});

app.get('/availability', (req, res) => {
  const { restaurantId, startTime } = req.query;
  const party = parseInt(req.query.partySize, 10) || 2;
  if (!rest(restaurantId) || isNaN(Date.parse(startTime)))
    return res.status(400).json({ message: 'Invalid restaurantId or startTime' });
  const base = new Date(startTime).getTime();
  const alternatives = [-2, -1, 1, 2].map((h) => new Date(base + h * 3600000).toISOString())
    .filter((t) => slotFree(restaurantId, t, party));
  res.json({ available: slotFree(restaurantId, startTime, party), alternatives });
});

app.get('/reservations/:id', (req, res) => {
  const r = reservations[req.params.id];
  if (!r) return res.status(404).json({ message: 'Reservation not found' });
  if (!sameEmail(r, req.query.email)) return res.status(403).json({ message: 'Verification failed' });
  res.json(view(r));
});

app.post('/reservations/:id/modify', (req, res) => {
  const r = reservations[req.params.id];
  if (!r) return res.status(404).json({ message: 'Reservation not found' });
  if (!sameEmail(r, req.body.email)) return res.status(403).json({ message: 'Verification failed' });
  if (r.status === 'Cancelled') return res.status(400).json({ message: 'Reservation is cancelled' });
  const start = req.body.newStartTime || r.startTime;
  const party = req.body.newPartySize || r.partySize;
  if (isNaN(Date.parse(start))) return res.status(400).json({ message: 'Invalid newStartTime' });
  if (!slotFree(r.restaurantId, start, party, r.id)) {
    const base = new Date(start).getTime();
    const alternatives = [-2, -1, 1, 2].map((h) => new Date(base + h * 3600000).toISOString())
      .filter((t) => slotFree(r.restaurantId, t, party, r.id));
    return res.status(409).json({ message: 'Requested slot is not available', alternatives });
  }
  r.startTime = new Date(start).toISOString();
  r.partySize = party;
  r.status = 'Modified';
  res.json(view(r));
});

app.post('/reservations/:id/cancel', (req, res) => {
  const r = reservations[req.params.id];
  if (!r) return res.status(404).json({ message: 'Reservation not found' });
  if (!sameEmail(r, req.body.email)) return res.status(403).json({ message: 'Verification failed' });
  if (r.status === 'Cancelled') return res.status(400).json({ message: 'Already cancelled' });
  const hoursLeft = (new Date(r.startTime) - Date.now()) / 3600000;
  const windowH = rest(r.restaurantId).cancellationWindowHours;
  r.status = 'Cancelled';
  res.json({ ...view(r), lateCancellation: hoursLeft < windowH,
    policyNote: hoursLeft < windowH
      ? `Cancelled inside the ${windowH}h window; a late cancellation fee may apply.`
      : 'Cancelled within the free cancellation window.' });
});

app.listen(process.env.PORT || 3000, () => console.log('Mock reservation API running'));
