import { reqHandler } from '../dist/njrsearch2/server/server.mjs';

export default async function handler(req: any, res: any) {
  try {
    return await reqHandler(req, res);
  } catch (err: any) {
    console.error("Vercel Serverless Error:", err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal Serverless Error', 
      details: err.message 
    });
  }
}