// Seeds demo users, accounts and the default rules. Safe to run repeatedly.
// Usage: tsx --env-file=.env db/seed.ts
import bcrypt from 'bcrypt';
import pg from 'pg';

const DEMO_PASSWORD = 'demo1234'; // shown on the console login page; data is synthetic
const BCRYPT_COST = 12;

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const CITIES = [
  'Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune',
  'Ahmedabad', 'Jaipur', 'Surat', 'Lucknow', 'Kochi', 'Indore', 'Chandigarh', 'Nagpur',
];
const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Kabir', 'Rohan', 'Arjun', 'Karan',
  'Ananya', 'Diya', 'Isha', 'Kavya', 'Meera', 'Priya', 'Riya', 'Saanvi', 'Neha', 'Pooja'];
const LAST = ['Sharma', 'Patel', 'Iyer', 'Reddy', 'Nair', 'Gupta', 'Singh', 'Mehta',
  'Das', 'Joshi', 'Kulkarni', 'Banerjee', 'Chopra', 'Desai', 'Menon'];
const MERCHANTS: [string, string][] = [
  ['Fresh Basket', 'grocery'], ['Gadget Galaxy', 'electronics'], ['Petro Point', 'fuel'],
  ['Skyway Travels', 'travel'], ['Spice Route Kitchen', 'restaurants'], ['CareFirst Pharmacy', 'pharmacy'],
  ['Urban Threads', 'fashion'], ['PlayZone Gaming', 'gaming'], ['Heritage Jewellers', 'jewellery'],
  ['PowerGrid Utilities', 'utilities'],
];

// Deterministic generator so every environment gets the same demo accounts.
let s = 42;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');

  const hash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  await client.query(
    `insert into users (email, name, password_hash, role) values
       ('analyst@demo', 'Demo Analyst', $1, 'analyst'),
       ('analyst2@demo', 'Second Analyst', $1, 'analyst'),
       ('admin@demo', 'Demo Admin', $1, 'admin')
     on conflict (email) do nothing`,
    [hash],
  );

  const { rows } = await client.query('select count(*)::int as n from accounts');
  if (rows[0].n === 0) {
    for (let i = 0; i < 120; i++) {
      await client.query(
        `insert into accounts (holder_name, kind, city) values ($1, 'customer', $2)`,
        [`${pick(FIRST)} ${pick(LAST)}`, pick(CITIES)],
      );
    }
    for (const [name, category] of MERCHANTS) {
      for (let k = 0; k < 3; k++) {
        await client.query(
          `insert into accounts (holder_name, kind, merchant_category, city) values ($1, 'merchant', $2, $3)`,
          [`${name} ${pick(CITIES)}`, category, pick(CITIES)],
        );
      }
    }
  }

  const rules: [string, object][] = [
    ['velocity_5_in_10m', { count: 5, window_minutes: 10 }],
    ['new_city', { compare_last_n: 3, window_minutes: 60 }],
    ['amount_spike', { multiplier: 5, window_days: 30 }],
    ['dormant_account', { inactive_days: 90, min_amount: 50000 }],
  ];
  for (const [name, params] of rules) {
    await client.query(
      `insert into rules (name, params) values ($1, $2) on conflict (name) do nothing`,
      [name, JSON.stringify(params)],
    );
  }

  await client.query('commit');
  console.log('seed complete');
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  await client.end();
}
