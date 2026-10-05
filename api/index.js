// api/index.js
export default async function handler(req, res) {
  try {
    const { reqHandler } = await import('../dist/njrsearch2/server/server.mjs');
    return await reqHandler(req, res);
  } catch (err) {
    console.error("Vercel Serverless Error:", err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal Serverless Error', 
      details: err.message 
    });
  }
}