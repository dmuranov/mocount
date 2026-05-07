// Combined xlsx import endpoint — replaces the separate
// /api/numbers/import + /api/volumes/import paths.
//
// One file holds Number metadata + fee declarations + daily volume
// rows. See src/services/combined_import.js for the row contract.

import express from 'express';
import multer from 'multer';
import { requireAdmin } from '../auth/middleware.js';
import { parseAndAnalyze, commitImport } from '../services/combined_import.js';

export const importRouter = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

importRouter.post('/api/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'file field is required (multipart/form-data)' });
  const dryRun = String(req.query.dryRun || 'true') !== 'false';
  try {
    if (dryRun) {
      const plan = await parseAndAnalyze(req.file.buffer);
      return res.json({ ok: true, dryRun: true, ...plan });
    }
    const result = await commitImport(req.file.buffer, req.user.id);
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ok: true, dryRun: false, ...result });
  } catch (err) {
    console.error('[/api/import]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
