'use strict';
/*
 * db.js — the Postgres pool.
 *
 * Read-mostly: SPREAD reads `stock_quotes` (written by the ingestion scraper,
 * which is a separate project) and writes only its own three tables.
 *
 * Credentials come from the environment. Never hardcode them here, not even
 * commented out — a commented password in a committed file is still a leaked
 * password, and this project inherited exactly that problem once already.
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => console.error('[db] idle client error:', err.message));

async function ping() {
  const { rows } = await pool.query('SELECT now() AS t');
  return rows[0].t;
}

module.exports = { pool, ping };
