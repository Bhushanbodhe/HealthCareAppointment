// database.js - Cross-platform JSON-based database mock
// This replaces better-sqlite3 to avoid native binary issues (ERR_DLOPEN_FAILED)
// on newer Node.js versions (like v24+).
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbDir = path.join(__dirname, '..', 'database');
const dbPath = path.join(dbDir, 'healthcare_db.json');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initial State
const initialState = {
  users: [],
  doctors: [],
  appointments: []
};

// Load or Initialize Data
let data = initialState;
if (fs.existsSync(dbPath)) {
  try {
    data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (e) {
    console.error("Error loading database, resetting...", e);
    data = initialState;
  }
}

const saveData = () => {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

// Simple Mock API to mimic better-sqlite3
const db = {
  pragma: () => {},
  exec: () => {},
  prepare: (sql) => {
    // Basic SQL simulation for the server routes
    const sqlClean = sql.toLowerCase().trim();

    return {
      run: (...args) => {
        if (sqlClean.includes('insert into users')) {
          const [name, email, phone, password, role] = args;
          const id = (data.users.length ? Math.max(...data.users.map(u => u.id)) : 0) + 1;
          data.users.push({ id, name, email, phone, password, role });
          saveData();
          return { lastInsertRowid: id };
        }
        if (sqlClean.includes('insert into doctors')) {
          const [name, specialization, experience, rating, available_slots, bio, avatar_color] = args;
          const id = (data.doctors.length ? Math.max(...data.doctors.map(d => d.id)) : 0) + 1;
          data.doctors.push({ id, name, specialization, experience: Number(experience), rating: Number(rating), available_slots, bio, avatar_color });
          saveData();
          return { lastInsertRowid: id };
        }
        if (sqlClean.includes('insert into appointments')) {
          const [user_id, doctor_id, date, time_slot, status] = args;
          // Unique constraint check (doctor_id, date, time_slot)
          const exists = data.appointments.find(a => a.doctor_id == doctor_id && a.date == date && a.time_slot == time_slot && a.status !== 'cancelled');
          if (exists) {
            throw new Error('UNIQUE constraint failed');
          }
          const id = (data.appointments.length ? Math.max(...data.appointments.map(a => a.id)) : 0) + 1;
          data.appointments.push({ id, user_id, doctor_id, date, time_slot, status, created_at: new Date().toISOString() });
          saveData();
          return { lastInsertRowid: id };
        }
        if (sqlClean.includes('update appointments set status = \'past\'')) {
          const [today] = args;
          data.appointments.forEach(a => {
            if (a.date < today && a.status === 'upcoming') a.status = 'past';
          });
          saveData();
          return { changes: 1 };
        }
        if (sqlClean.includes('update appointments set status = \'cancelled\'')) {
          const [id] = args;
          const appt = data.appointments.find(a => a.id == id);
          if (appt) appt.status = 'cancelled';
          saveData();
          return { changes: 1 };
        }
        if (sqlClean.includes('delete from doctors')) {
          const [id] = args;
          data.doctors = data.doctors.filter(d => d.id != id);
          saveData();
          return { changes: 1 };
        }
        if (sqlClean.includes('update doctors set')) {
          // Simplified update for admin
          const [name, spec, exp, rating, slots, bio, color, id] = args;
          const d = data.doctors.find(doc => doc.id == id);
          if (d) {
             if (name) d.name = name;
             if (spec) d.specialization = spec;
             if (exp !== undefined) d.experience = Number(exp);
             if (rating !== undefined) d.rating = Number(rating);
             if (slots) d.available_slots = slots;
             if (bio !== undefined) d.bio = bio;
             if (color) d.avatar_color = color;
          }
          saveData();
          return { changes: 1 };
        }
        return { changes: 0 };
      },
      get: (...args) => {
        if (sqlClean.includes('select id from users where email = ?')) {
          return data.users.find(u => u.email === args[0]);
        }
        if (sqlClean.includes('select * from users where email = ?')) {
          return data.users.find(u => u.email === args[0]);
        }
        if (sqlClean.includes('select id, name, email, phone, role from users where id = ?')) {
          return data.users.find(u => u.id == args[0]);
        }
        if (sqlClean.includes('select * from doctors where id = ?')) {
          return data.doctors.find(d => d.id == args[0]);
        }
        if (sqlClean.includes('select * from appointments where id = ? and user_id = ?')) {
          return data.appointments.find(a => a.id == args[0] && a.user_id == args[1]);
        }
        if (sqlClean.includes('select count(*) as count from doctors')) {
          return { count: data.doctors.length };
        }
        if (sqlClean.includes('select count(*) as c from doctors')) {
          return { c: data.doctors.length };
        }
        if (sqlClean.includes('select count(*) as c from users where role=\'patient\'')) {
          return { c: data.users.filter(u => u.role === 'patient').length };
        }
        if (sqlClean.includes('select count(*) as c from appointments')) {
          return { c: data.appointments.length };
        }
        if (sqlClean.includes('select count(*) as c from appointments where date = date(\'now\')')) {
           const today = new Date().toISOString().split('T')[0];
           return { c: data.appointments.filter(a => a.date === today).length };
        }
        return null;
      },
      all: (...args) => {
        if (sqlClean.includes('select * from doctors where lower(specialization) like lower(?)')) {
          const term = args[0].replace(/%/g, '').toLowerCase();
          return data.doctors.filter(d => d.specialization.toLowerCase().includes(term));
        }
        if (sqlClean.includes('select * from doctors')) {
          return data.doctors;
        }
        if (sqlClean.includes('select a.*, d.name as doctor_name, d.specialization, d.avatar_color')) {
          const userId = args[0];
          return data.appointments
            .filter(a => a.user_id == userId)
            .map(a => {
              const d = data.doctors.find(doc => doc.id == a.doctor_id) || { name: 'Unknown', specialization: 'N/A', avatar_color: '#ccc' };
              return { ...a, doctor_name: d.name, specialization: d.specialization, avatar_color: d.avatar_color };
            })
            .sort((a, b) => b.date.localeCompare(a.date));
        }
        return [];
      }
    };
  }
};

// ─── Seed Data Logic (Runs if DB is empty) ───────────────────────────────────

if (data.users.length === 0) {
  const hashed = bcrypt.hashSync('admin123', 10);
  data.users.push({ id: 1, name: 'Admin', email: 'admin@health.com', phone: '9999999999', password: hashed, role: 'admin' });
  console.log('✅ Admin user seeded: admin@health.com / admin123');
  saveData();
}

if (data.doctors.length === 0) {
  const seedDoctors = [
    { name: 'Dr. Priya Sharma', specialization: 'Cardiologist', experience: 14, rating: 4.9, slots: ['09:00 AM', '10:00 AM', '11:00 AM', '02:00 PM', '03:00 PM'], bio: 'Experienced cardiologist.', color: '#ef4444' },
    { name: 'Dr. Rahul Mehta', specialization: 'Neurologist', experience: 11, rating: 4.8, slots: ['10:00 AM', '11:30 AM', '01:00 PM', '03:30 PM', '04:30 PM'], bio: 'Neurological specialist.', color: '#8b5cf6' },
    { name: 'Dr. Anita Desai', specialization: 'Dermatologist', experience: 9, rating: 4.7, slots: ['09:30 AM', '10:30 AM', '12:00 PM', '02:30 PM', '04:00 PM'], bio: 'Skin health expert.', color: '#f59e0b' },
    { name: 'Dr. Sanjay Patel', specialization: 'Orthopedist', experience: 16, rating: 4.9, slots: ['08:00 AM', '09:00 AM', '11:00 AM', '01:00 PM', '03:00 PM'], bio: 'Joint specialist.', color: '#10b981' },
    { name: 'Dr. Meera Nair', specialization: 'Pediatrician', experience: 8, rating: 4.8, slots: ['09:00 AM', '10:00 AM', '11:30 AM', '02:00 PM', '04:00 PM'], bio: 'Child care expert.', color: '#3b82f6' },
    { name: 'Dr. Vikram Singh', specialization: 'Psychiatrist', experience: 12, rating: 4.7, slots: ['10:00 AM', '11:00 AM', '01:30 PM', '03:00 PM', '05:00 PM'], bio: 'Mental health specialist.', color: '#6366f1' },
    { name: 'Dr. Kavya Reddy', specialization: 'Gynecologist', experience: 13, rating: 4.9, slots: ['09:00 AM', '10:30 AM', '12:00 PM', '02:00 PM', '04:00 PM'], bio: 'Women\'s health expert.', color: '#ec4899' },
    { name: 'Dr. Arjun Kumar', specialization: 'General Physician', experience: 7, rating: 4.6, slots: ['08:30 AM', '09:30 AM', '11:00 AM', '01:30 PM', '03:30 PM'], bio: 'Primary care doctor.', color: '#0ea5e9' }
  ];

  seedDoctors.forEach((d, i) => {
    data.doctors.push({
      id: i + 1,
      name: d.name,
      specialization: d.specialization,
      experience: d.experience,
      rating: d.rating,
      available_slots: JSON.stringify(d.slots),
      bio: d.bio,
      avatar_color: d.color
    });
  });
  console.log(`✅ Seeded ${seedDoctors.length} doctors`);
  saveData();
}

module.exports = db;
