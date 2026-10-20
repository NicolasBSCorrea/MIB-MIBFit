// Utilitários do servidor: banco (Postgres), tabelas, sessões (professor e aluno), agenda e código do aluno.
const { Pool } = require('pg');
const crypto = require('crypto');

let pool, ready;
const httpErr = (s, m) => Object.assign(new Error(m), { status: s });

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

// Cria/atualiza as tabelas automaticamente (não precisa rodar SQL à mão).
async function ensure() {
  if (!ready) {
    const T = ['alunos', 'exercicios', 'professores', 'treinos', 'checkins', 'agenda', 'login_falhas'];
    ready = db().query(`
      create table if not exists alunos (id text primary key, nome text, codigo text, dados jsonb not null, atualizado_em timestamptz default now());
      alter table alunos add column if not exists codigo text;
      alter table alunos drop column if exists cpf;
      drop index if exists alunos_cpf_idx;
      create unique index if not exists alunos_codigo_uq on alunos (codigo) where codigo is not null;
      update alunos set dados = dados - 'cpf' where dados ? 'cpf';
      create table if not exists exercicios (id text primary key, nome text, grupo text, dados jsonb not null, atualizado_em timestamptz default now());
      create table if not exists professores (id text primary key, nome text, dados jsonb not null, atualizado_em timestamptz default now());
      create table if not exists treinos (id text primary key, aluno_id text, nome text, dados jsonb not null, atualizado_em timestamptz default now());
      create index if not exists treinos_aluno_idx on treinos (aluno_id);
      create table if not exists checkins (id text primary key, aluno_id text, data text, dados jsonb not null, atualizado_em timestamptz default now());
      create index if not exists checkins_aluno_idx on checkins (aluno_id);
      create table if not exists agenda (id text primary key, aluno_id text, prof_id text, data text, hora text, duracao int, ini int, fim int, dados jsonb not null, atualizado_em timestamptz default now());
      create index if not exists agenda_data_idx on agenda (data);
      create table if not exists login_falhas (chave text primary key, n int default 0, ate timestamptz, atualizado timestamptz default now());
      ${T.map((t) => `alter table ${t} enable row level security;`).join('\n')}
    `);
  }
  try { await ready; } catch (e) { ready = null; throw e; }
}

// ---------- sessões: professor ('p') e aluno ('s') ----------
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET não configurada na Vercel (mínimo 16 caracteres).');
  return s;
};
const sign = (p) => crypto.createHmac('sha256', secret()).update(p).digest('base64url');

function token(role, id) {
  const p = [role, id, Date.now() + 12 * 3600 * 1000].join('.'); // vale 12 horas
  return p + '.' + sign(p);
}
function verify(req) {
  const parts = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  if (parts.length !== 4) return null;
  const [role, id, exp, g] = parts;
  const a = Buffer.from(g), b = Buffer.from(sign([role, id, exp].join('.')));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || Number(exp) <= Date.now()) return null;
  return { role, id };
}
const check = (req) => { const v = verify(req); return !!v && v.role === 'p'; };

// ---------- código do aluno: 5 dígitos, fixo ----------
const bad = (c) => /^(\d)\1{4}$/.test(c) || '01234567890'.includes(c) || '98765432109'.includes(c);
async function pickCode(c, id, want) {
  let code = /^\d{5}$/.test(want || '') && !bad(want) ? want : null;
  for (let i = 0; i < 200; i++) {
    if (!code) { code = String(10000 + crypto.randomInt(90000)); if (bad(code)) { code = null; continue; } }
    const t = await c.query('select 1 from alunos where codigo=$1 and id<>$2', [code, id]);
    if (!t.rowCount) return code;
    code = null;
  }
  throw httpErr(500, 'Não foi possível gerar um código único.');
}

// ---------- agenda: sem horário duplo (mesmo professor ou mesmo aluno) ----------
async function upAgenda(c, x) {
  const [h, m] = String(x.time).split(':').map(Number);
  const ini = h * 60 + m, fim = ini + (+x.dur || 60);
  await c.query('select pg_advisory_xact_lock(7001)');
  const k = await c.query(
    'select prof_id from agenda where data=$1 and id<>$2 and (prof_id=$3 or aluno_id=$4) and ini<$5::int and $6::int<fim',
    [x.date, x.id, x.pid, x.sid, fim, ini]);
  if (k.rowCount) throw httpErr(409, k.rows.some((r) => r.prof_id === x.pid)
    ? 'Esse professor já tem atendimento nesse horário.' : 'Esse aluno já tem um agendamento nesse horário.');
  await c.query(
    `insert into agenda (id, aluno_id, prof_id, data, hora, duracao, ini, fim, dados) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (id) do update set aluno_id=$2, prof_id=$3, data=$4, hora=$5, duracao=$6, ini=$7, fim=$8, dados=$9, atualizado_em=now()`,
    [x.id, x.sid, x.pid, x.date, x.time, +x.dur || 60, ini, fim, x]);
}

const hoje = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

// ---------- dados que o aluno pode ver (somente os dele) ----------
async function alunoPayload(q, id) {
  const a = (await q.query('select dados, codigo from alunos where id=$1', [id])).rows[0];
  if (!a) return null;
  const d = a.dados;
  const aluno = { id, name: d.name, goal: d.goal, freq: d.freq, codigo: a.codigo }; // sem anotações internas
  const p = (await q.query('select dados from treinos where aluno_id=$1 order by atualizado_em desc limit 1', [id])).rows[0];
  const ck = (await q.query('select dados from checkins where aluno_id=$1 order by data desc, atualizado_em desc limit 300', [id])).rows.map((r) => r.dados).reverse();
  const ag = (await q.query('select dados, aluno_id from agenda where aluno_id=$1 or data>=$2', [id, hoje()])).rows
    .map((r) => (r.aluno_id === id ? r.dados : { id: r.dados.id, sid: '', pid: r.dados.pid, date: r.dados.date, time: r.dados.time, dur: r.dados.dur, loc: '' })); // horários de outros alunos: anônimos
  const profs = (await q.query('select dados from professores order by nome')).rows.map((r) => ({ id: r.dados.id, name: r.dados.name, esp: r.dados.esp }));
  return { aluno, plans: p ? [p.dados] : [], checkins: ck, ag, profs };
}

async function tx(q, fn) {
  const c = await q.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback'); throw e; }
  finally { c.release(); }
}

module.exports = { db, ensure, token, verify, check, pickCode, upAgenda, alunoPayload, tx, httpErr, hoje };
