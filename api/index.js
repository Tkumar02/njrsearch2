// api/index.js
const { reqHandler } = require('../dist/njrsearch2/server/server.mjs');

module.exports = async function (req, res) {
  try {
    return await reqHandler(req, res);
  } catch (err) {
    console.error("Vercel Serverless Error:", err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal Serverless Error', 
      details: err.message 
    });
  }
};