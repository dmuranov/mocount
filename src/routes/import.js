// Combined xlsx import endpoint — replaces the separate
// /api/numbers/import + /api/volumes/import paths.
//
// One file holds Number metadata + fee declarations + daily volume
// rows. See src/services/combined_import.js for the row contract.

import express from 'express';
import multer from 'multer';
import { requireAdmin } from '../auth/middleware.js';
import { parseAndAnalyze, commitImport } from '../services/combined_import.js';
import {
  parseAndAnalyze as parseMoMessages,
  commitImport as commitMoMessages,
} from '../services/momessages_import.js';
import {
  parseAndAnalyze as parsePrices,
  commitImport as commitPrices,
} from '../services/prices_import.js';

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

// MO Messages report — volumes-only import (sums Messages per
// Receiver/Date). See src/services/momessages_import.js.
importRouter.post('/api/import/momessages', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'file field is required (multipart/form-data)' });
  const dryRun = String(req.query.dryRun || 'true') !== 'false';
  try {
    if (dryRun) {
      const plan = await parseMoMessages(req.file.buffer);
      return res.json({ ok: true, dryRun: true, ...plan });
    }
    // Confirmed VLN matches ride along as a JSON form field (multipart).
    let approvedVlnMatches = [];
    if (req.body?.approvedVlnMatches) {
      try { approvedVlnMatches = JSON.parse(req.body.approvedVlnMatches); }
      catch { return res.status(400).json({ ok: false, error: 'approvedVlnMatches must be valid JSON' }); }
    }
    const result = await commitMoMessages(req.file.buffer, req.user.id, approvedVlnMatches);
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ok: true, dryRun: false, ...result });
  } catch (err) {
    console.error('[/api/import/momessages]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Price sync — reconcile per-message prices from the master "MO Prices"
// sheet (xlsx). See src/services/prices_import.js.
importRouter.post('/api/import/prices', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'file field is required (multipart/form-data)' });
  const dryRun = String(req.query.dryRun || 'true') !== 'false';
  try {
    if (dryRun) {
      const plan = await parsePrices(req.file.buffer);
      return res.json({ ok: true, dryRun: true, ...plan });
    }
    const result = await commitPrices(req.file.buffer, req.user.id);
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ok: true, dryRun: false, ...result });
  } catch (err) {
    console.error('[/api/import/prices]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
