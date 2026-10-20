// Login do aluno pelo código de 5 dígitos (sem senha). Bloqueia tentativas em excesso.
const { db, ensure, token, alunoPayload } = require('../lib/server');

const FALHA = `
  insert into login_falhas (chave, n, atualizado) values ($1, 1, now())
  on conflict (chave) do update set
    n = case when login_falhas.atualizado < now() - interval '1 hour' then 1 else login_falhas.n + 1 end,
    atualizado = now(),
    ate = case when (case when login_falhas.atualizado < now() - interval '1 hour' then 1 else login_falhas.n + 1 end) >= 8
               then now() + interval '15 minutes' else null end`;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).end();
    await ensure();
    const q = db();
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconhecido';
    const f = (await q.query('select ate from login_falhas where chave=$1', [ip])).rows[0];
    if (f && f.ate && new Date(f.ate) > new Date()) return res.status(429).json({ erro: 'Muitas tentativas. Tente novamente em alguns minutos.' });
    const cod = String((req.body || {}).codigo || '').replace(/\D/g, '');
    const r = cod.length === 5 ? (await q.query('select id from alunos where codigo=$1', [cod])).rows[0] : null;
    if (!r) {
      await q.query(FALHA, [ip]);
      await new Promise((ok) => setTimeout(ok, 500));
      return res.status(404).json({ erro: 'Código inválido. Confira os 5 dígitos.' });
    }
    await q.query('delete from login_falhas where chave=$1', [ip]);
    res.json({ token: token('s', r.id), data: await alunoPayload(q, r.id) });
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
};
