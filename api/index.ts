import { reqHandler } from '../dist/njrsearch2/server/server.mjs'; // Make sure this matches your build path layout or use your bundled handler

export default async function handler(req: any, res: any) {
  return reqHandler(req, res);
}