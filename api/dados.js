// Professor: leitura (GET ?t=...) e gravação (POST) de alunos, exercícios, professores, treinos, check-ins e agenda.
const { db, ensure, check, pickCode, upAgenda, tx } = require('../lib/server');

// colunas "de busca" de cada tabela; o objeto completo fica sempre em "dados" (jsonb)
const C = {
  alunos: { cols: ['nome'], f: (x) => [x.name || ''] },
  exercicios: { cols: ['nome', 'grupo'], f: (x) => [x.n || '', x.g || ''] },
  professores: { cols: ['nome'], f: (x) => [x.name || ''] },
  treinos: { cols: ['aluno_id', 'nome'], f: (x) => [x.sid || '', x.name || ''] },
  checkins: { cols: ['aluno_id', 'data'], f: (x) => [x.sid || '', x.date || ''] },
  agenda: {},
};

async function upsert(c, t, k, x) {
  const n = k.cols.length;
  const ph = k.cols.map((_, i) => '$' + (i + 2)).join(',');
  const set = k.cols.map((col, i) => `${col}=$${i + 2}`).join(',');
  await c.query(
    `insert into ${t} (id, ${k.cols.join(',')}, dados) values ($1, ${ph}, $${n + 2})
     on conflict (id) do update set ${set}, dados=$${n + 2}, atualizado_em=now()`,
    [x.id, ...k.f(x), x]);
}

module.exports = async (req, res) => {
  try {
    if (!check(req)) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
    await ensure();
    const q = db();

    if (req.method === 'GET') {
      const t = req.query.t;
      if (!C[t]) return res.status(400).json({ erro: 'Parâmetro t inválido.' });
      const r = await q.query(`select dados from ${t} order by atualizado_em`);
      return res.json({ [t]: r.rows.map((x) => x.dados) });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const codes = {};
      await tx(q, async (c) => {
        for (const t of Object.keys(C)) {
          const b = body[t] || {};
          for (const x of b.up || []) {
            if (!x || typeof x.id !== 'string' || !x.id) continue;
            if (t === 'agenda') { await upAgenda(c, x); continue; }
            if (t === 'alunos') {
              // o código do aluno é fixo: se já existe, nunca muda (nem pelo professor)
              const ex = (await c.query('select codigo from alunos where id=$1', [x.id])).rows[0];
              const code = ex && ex.codigo ? ex.codigo : await pickCode(c, x.id, x.codigo);
              codes[x.id] = code;
              await c.query(
                `insert into alunos (id, nome, codigo, dados) values ($1::text, $2::text, $3::text, $4::jsonb)
                 on conflict (id) do update set nome=$2::text, codigo=coalesce(alunos.codigo, $3::text),
                   dados=$4::jsonb || jsonb_build_object('codigo', coalesce(alunos.codigo, $3::text)), atualizado_em=now()`,
                [x.id, x.name || '', code, x]);
              continue;
            }
            await upsert(c, t, C[t], x);
          }
          const del = (b.del || []).filter((i) => typeof i === 'string');
          if (del.length) {
            if (t === 'alunos') for (const d of ['treinos', 'checkins', 'agenda']) await c.query(`delete from ${d} where aluno_id = any($1)`, [del]);
            await c.query(`delete from ${t} where id = any($1)`, [del]);
          }
        }
      });
      return res.json({ ok: true, codes });
    }

    res.status(405).end();
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
};
