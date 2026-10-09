// Leitura (GET ?t=alunos|exercicios) e gravação (POST) dos alunos e exercícios. Exige login do professor.
const { db, ensure, check } = require('../lib/server');

module.exports = async (req, res) => {
  try {
    if (!check(req)) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
    await ensure();
    const q = db();

    if (req.method === 'GET') {
      const t = req.query.t;
      if (t === 'alunos') {
        const r = await q.query('select dados from alunos order by nome');
        return res.json({ alunos: r.rows.map((x) => x.dados) });
      }
      if (t === 'exercicios') {
        const r = await q.query('select dados from exercicios order by nome');
        return res.json({ exercicios: r.rows.map((x) => x.dados) });
      }
      return res.status(400).json({ erro: 'Parâmetro t inválido.' });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const al = b.alunos || {}, ex = b.exercicios || {};
      const c = await q.connect();
      try {
        await c.query('begin');
        for (const x of al.up || [])
          await c.query(
            `insert into alunos (id, nome, cpf, dados) values ($1,$2,$3,$4)
             on conflict (id) do update set nome=$2, cpf=$3, dados=$4, atualizado_em=now()`,
            [x.id, x.name || '', x.cpf || '', x]);
        for (const x of ex.up || [])
          await c.query(
            `insert into exercicios (id, nome, grupo, dados) values ($1,$2,$3,$4)
             on conflict (id) do update set nome=$2, grupo=$3, dados=$4, atualizado_em=now()`,
            [x.id, x.n || '', x.g || '', x]);
        if ((al.del || []).length) await c.query('delete from alunos where id = any($1)', [al.del]);
        if ((ex.del || []).length) await c.query('delete from exercicios where id = any($1)', [ex.del]);
        await c.query('commit');
      } catch (err) {
        await c.query('rollback');
        throw err;
      } finally {
        c.release();
      }
      return res.json({ ok: true });
    }

    res.status(405).end();
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
};
