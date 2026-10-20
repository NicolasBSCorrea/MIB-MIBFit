// Área do aluno (token de aluno): ver o próprio treino, registrar check-in e agendar atendimento.
const crypto = require('crypto');
const { db, ensure, verify, alunoPayload, upAgenda, tx, httpErr, hoje } = require('../lib/server');

const str = (v, n) => String(v ?? '').slice(0, n);

module.exports = async (req, res) => {
  try {
    const t = verify(req);
    if (!t || t.role !== 's') return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
    await ensure();
    const q = db(), id = t.id;

    if (req.method === 'GET') {
      const p = await alunoPayload(q, id);
      if (!p) return res.status(401).json({ erro: 'Aluno não encontrado.' });
      return res.json(p);
    }

    if (req.method === 'POST') {
      const b = req.body || {};

      if (b.act === 'checkin') {
        const c = b.c || {};
        const items = (Array.isArray(c.items) ? c.items : []).slice(0, 60).map((i) => ({
          ex: str(i.ex, 40), n: str(i.n, 120), c: str(i.c, 10), r: str(i.r, 40), o: str(i.o, 1000),
          sets: Array.isArray(i.sets) ? i.sets.slice(0, 20).map((s) => ({ c: str(s.c, 10), r: str(s.r, 10) })) : undefined,
        }));
        if (!items.length) throw httpErr(400, 'Check-in vazio.');
        const row = {
          id: crypto.randomBytes(5).toString('hex'), sid: id, plan: str(c.plan, 40), day: str(c.day, 40), dn: str(c.dn, 80),
          date: /^\d{4}-\d{2}-\d{2}$/.test(c.date || '') ? c.date : hoje(), at: new Date().toISOString(), items, obs: str(c.obs, 2000),
        };
        await q.query('insert into checkins (id, aluno_id, data, dados) values ($1,$2,$3,$4)', [row.id, id, row.date, row]);
        return res.json({ checkin: row });
      }

      if (b.act === 'agendar') {
        const x = b.b || {};
        const row = { id: crypto.randomBytes(5).toString('hex'), sid: id, pid: str(x.pid, 40), date: str(x.date, 10), time: str(x.time, 5), dur: +x.dur, loc: str(x.loc, 200).trim(), at: new Date().toISOString() };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !/^\d{2}:\d{2}$/.test(row.time) || ![30, 45, 60, 90].includes(row.dur) || !row.loc || !row.pid)
          throw httpErr(400, 'Preencha professor, data, horário e local.');
        if (new Date(`${row.date}T${row.time}:00-03:00`) <= new Date()) throw httpErr(400, 'Escolha uma data e um horário futuros.');
        if (!(await q.query('select 1 from professores where id=$1', [row.pid])).rowCount) throw httpErr(400, 'Professor não encontrado.');
        await tx(q, (c) => upAgenda(c, row));
        return res.json({ ag: row });
      }

      throw httpErr(400, 'Ação inválida.');
    }

    res.status(405).end();
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
};
