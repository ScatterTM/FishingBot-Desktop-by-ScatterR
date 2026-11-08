// Legacy mathjs endpoint kept as a native ES module because this project uses
// "type": "module". The previous CommonJS wrapper crashed at runtime with
// "require is not defined" in an ESM runtime.
import { evaluate } from 'mathjs';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const expr = req.query?.expr;
  if (!expr) return res.status(400).send('Error: Missing expr parameter');

  try {
    const result = evaluate(expr);
    const output = Array.isArray(result) ? JSON.stringify(result) : String(result);
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).send(output);
  } catch (_) {
    return res.status(400).send('Error: invalid expression.');
  }
}
