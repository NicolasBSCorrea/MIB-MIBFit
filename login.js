// Login do professor: compara a senha com a variável PROFESSOR_PASSWORD (guardada só na Vercel).
const crypto = require('crypto');
const { token } = require('../lib/server');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).end();
    const pw = process.env.PROFESSOR_PASSWORD;
    if (!pw) return res.status(500).json({ erro: 'PROFESSOR_PASSWORD não configurada na Vercel.' });
    const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
    const ok = crypto.timingSafeEqual(h((req.body || {}).senha || ''), h(pw));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 600));
      return res.status(401).json({ erro: 'Senha incorreta.' });
    }
    res.json({ token: token() });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
};
