// Utilitários do servidor: conexão com o banco (Postgres), criação das tabelas e sessão do professor.
const { Pool } = require('pg');
const crypto = require('crypto');

let pool, ready;

function db() {
  if (!pool) {
    const raw = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!raw) throw new Error('Banco não configurado: conecte o banco ao projeto na Vercel (variável POSTGRES_URL).');
    const u = new URL(raw);
    ['sslmode', 'supa'].forEach((k) => u.searchParams.delete(k));
    pool = new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool;
}

// Cria as tabelas automaticamente na primeira chamada (não precisa rodar SQL à mão).
async function ensure() {
  if (!ready) {
    ready = db().query(`
      create table if not exists alunos (
        id text primary key, nome text, cpf text,
        dados jsonb not null, atualizado_em timestamptz default now());
      create table if not exists exercicios (
        id text primary key, nome text, grupo text,
        dados jsonb not null, atualizado_em timestamptz default now());
      create index if not exists alunos_cpf_idx on alunos (cpf);
      alter table alunos enable row level security;
      alter table exercicios enable row level security;
    `);
  }
  try { await ready; } catch (e) { ready = null; throw e; }
}

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET não configurada na Vercel (mínimo 16 caracteres).');
  return s;
};
const sign = (p) => crypto.createHmac('sha256', secret()).update(p).digest('base64url');

function token() {
  const p = String(Date.now() + 12 * 3600 * 1000); // vale 12 horas
  return p + '.' + sign(p);
}

function check(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const [p, g] = t.split('.');
  if (!p || !g) return false;
  const a = Buffer.from(g), b = Buffer.from(sign(p));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(p) > Date.now();
}

module.exports = { db, ensure, token, check };
