// server.js - Main Express server with all API routes
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Session configuration
app.use(session({
  secret: 'healthcare_secret_key_2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,       // set to true in production with HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000  // 24 hours
  }
}));

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────

// POST /api/register - Patient registration
app.post('/api/register', (req, res) => {
  const { name, email, phone, password } = req.body;

  // Validation
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  // Check if email already exists
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered. Please login.' });
  }

  // Hash password and insert user
  const hashed = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (name, email, phone, password, role) VALUES (?, ?, ?, ?, ?)'
  ).run(name, email, phone, hashed, 'patient');

  // Auto-login after registration
  req.session.userId = result.lastInsertRowid;
  req.session.role   = 'patient';
  req.session.name   = name;

  res.json({ message: 'Registration successful!', role: 'patient', name });
});

// POST /api/login - Patient/Admin login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  req.session.userId = user.id;
  req.session.role   = user.role;
  req.session.name   = user.name;

  res.json({ message: 'Login successful!', role: user.role, name: user.name });
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out successfully.' });
});

// GET /api/me - Get current session user
app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, phone, role FROM users WHERE id = ?')
                  .get(req.session.userId);
  res.json(user);
});

// ─── Doctor Routes ────────────────────────────────────────────────────────────

// GET /api/doctors - List all doctors (optional ?specialization= filter)
app.get('/api/doctors', (req, res) => {
  const { specialization } = req.query;
  let doctors;

  if (specialization && specialization.trim() !== '') {
    doctors = db.prepare(
      "SELECT * FROM doctors WHERE LOWER(specialization) LIKE LOWER(?)"
    ).all(`%${specialization}%`);
  } else {
    doctors = db.prepare('SELECT * FROM doctors').all();
  }

  // Parse available_slots JSON for each doctor
  doctors = doctors.map(d => ({
    ...d,
    available_slots: JSON.parse(d.available_slots)
  }));

  res.json(doctors);
});

// GET /api/doctors/:id - Get single doctor
app.get('/api/doctors/:id', (req, res) => {
  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });
  doctor.available_slots = JSON.parse(doctor.available_slots);
  res.json(doctor);
});

// ─── Appointment Routes ───────────────────────────────────────────────────────

// POST /api/appointments - Book an appointment
app.post('/api/appointments', requireAuth, (req, res) => {
  const { doctor_id, date, time_slot } = req.body;
  const user_id = req.session.userId;

  if (!doctor_id || !date || !time_slot) {
    return res.status(400).json({ error: 'Doctor, date, and time slot are required.' });
  }

  // Validate date is not in the past
  const today = new Date().toISOString().split('T')[0];
  if (date < today) {
    return res.status(400).json({ error: 'Cannot book an appointment in the past.' });
  }

  // Check doctor exists
  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(doctor_id);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

  // Check if slot is valid for that doctor
  const slots = JSON.parse(doctor.available_slots);
  if (!slots.includes(time_slot)) {
    return res.status(400).json({ error: 'Invalid time slot for this doctor.' });
  }

  // Prevent double booking
  try {
    const result = db.prepare(
      'INSERT INTO appointments (user_id, doctor_id, date, time_slot, status) VALUES (?, ?, ?, ?, ?)'
    ).run(user_id, doctor_id, date, time_slot, 'upcoming');

    res.json({
      message: `Appointment booked with ${doctor.name} on ${date} at ${time_slot}.`,
      appointment_id: result.lastInsertRowid
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'This slot is already booked. Please choose another time.' });
    }
    res.status(500).json({ error: 'Failed to book appointment.' });
  }
});

// GET /api/appointments - Get logged-in patient's appointments
app.get('/api/appointments', requireAuth, (req, res) => {
  // Auto-update past appointments
  const today = new Date().toISOString().split('T')[0];
  db.prepare(
    "UPDATE appointments SET status = 'past' WHERE date < ? AND status = 'upcoming'"
  ).run(today);

  const appointments = db.prepare(`
    SELECT a.*, d.name as doctor_name, d.specialization, d.avatar_color
    FROM appointments a
    JOIN doctors d ON a.doctor_id = d.id
    WHERE a.user_id = ?
    ORDER BY a.date DESC, a.time_slot DESC
  `).all(req.session.userId);

  res.json(appointments);
});

// DELETE /api/appointments/:id - Cancel an appointment
app.delete('/api/appointments/:id', requireAuth, (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?')
                  .get(req.params.id, req.session.userId);
  if (!appt) return res.status(404).json({ error: 'Appointment not found.' });
  if (appt.status === 'past') return res.status(400).json({ error: 'Cannot cancel a past appointment.' });

  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ message: 'Appointment cancelled successfully.' });
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

// GET /api/admin/doctors - Get all doctors (admin)
app.get('/api/admin/doctors', requireAdmin, (req, res) => {
  const doctors = db.prepare('SELECT * FROM doctors').all().map(d => ({
    ...d,
    available_slots: JSON.parse(d.available_slots)
  }));
  res.json(doctors);
});

// POST /api/admin/doctors - Add a new doctor
app.post('/api/admin/doctors', requireAdmin, (req, res) => {
  const { name, specialization, experience, rating, available_slots, bio, avatar_color } = req.body;

  if (!name || !specialization || !available_slots) {
    return res.status(400).json({ error: 'Name, specialization, and slots are required.' });
  }

  const slotsJson = JSON.stringify(
    Array.isArray(available_slots) ? available_slots : available_slots.split(',').map(s => s.trim())
  );

  const result = db.prepare(`
    INSERT INTO doctors (name, specialization, experience, rating, available_slots, bio, avatar_color)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, specialization, experience || 0, rating || 4.5, slotsJson, bio || '', avatar_color || '#0ea5e9');

  res.json({ message: 'Doctor added successfully.', id: result.lastInsertRowid });
});

// PUT /api/admin/doctors/:id - Update a doctor
app.put('/api/admin/doctors/:id', requireAdmin, (req, res) => {
  const { name, specialization, experience, rating, available_slots, bio, avatar_color } = req.body;
  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

  const slotsJson = available_slots
    ? JSON.stringify(Array.isArray(available_slots) ? available_slots : available_slots.split(',').map(s => s.trim()))
    : doctor.available_slots;

  db.prepare(`
    UPDATE doctors SET name=?, specialization=?, experience=?, rating=?, available_slots=?, bio=?, avatar_color=?
    WHERE id=?
  `).run(
    name || doctor.name,
    specialization || doctor.specialization,
    experience ?? doctor.experience,
    rating ?? doctor.rating,
    slotsJson,
    bio ?? doctor.bio,
    avatar_color || doctor.avatar_color,
    req.params.id
  );

  res.json({ message: 'Doctor updated successfully.' });
});

// DELETE /api/admin/doctors/:id - Delete a doctor
app.delete('/api/admin/doctors/:id', requireAdmin, (req, res) => {
  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found.' });

  db.prepare('DELETE FROM doctors WHERE id = ?').run(req.params.id);
  res.json({ message: 'Doctor deleted successfully.' });
});

// GET /api/admin/stats - Dashboard stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalDoctors      = db.prepare('SELECT COUNT(*) as c FROM doctors').get().c;
  const totalPatients     = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='patient'").get().c;
  const totalAppointments = db.prepare('SELECT COUNT(*) as c FROM appointments').get().c;
  const todayAppts        = db.prepare("SELECT COUNT(*) as c FROM appointments WHERE date = date('now')").get().c;
  res.json({ totalDoctors, totalPatients, totalAppointments, todayAppts });
});

// ─── Catch-All: Serve index.html ──────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅ Healthcare Appointment System running!`);
  console.log(`🌐 Open: http://localhost:${PORT}`);
  console.log(`👤 Admin login: admin@health.com / admin123\n`);
});
