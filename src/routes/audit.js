// Audit routes — SPEC §4 audit page + the by-number drawer.
//
//   GET /api/audit/by-number/:id        (auth)  drawer history
//   GET /api/audit                      (admin) filtered list
//   GET /api/audit/options              (admin) distinct entities/
//                                                actions/users for
//                                                the filter dropdowns

import express from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { supabase } from '../supabase.js';

export const auditRouter = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Return all audit entries that relate to a given number:
//   • entity='number' AND entity_id=<number_id>
//   • entity='fee'    AND entity_id IN (fee ids for this number)
// Joined client-side by user email so the drawer can render
// "{date} {action} by {who}". Capped at 200 rows to keep payloads sane.
auditRouter.get('/api/audit/by-number/:id', requireAuth, async (req, res) => {
  const numberId = req.params.id;
  const sb = supabase();

  const { data: feeIds, error: fErr } = await sb
    .from('fees').select('id').eq('number_id', numberId);
  if (fErr) return res.status(500).json({ ok: false, error: fErr.message });
  const feeIdList = (feeIds || []).map((f) => f.id);

  // Two filters via .or — Postgrest's `.or` syntax keeps it one round-trip.
  const filters = [
    `and(entity.eq.number,entity_id.eq.${numberId})`,
  ];
  if (feeIdList.length) {
    filters.push(`and(entity.eq.fee,entity_id.in.(${feeIdList.join(',')}))`);
  }
  const { data, error } = await sb
    .from('audit_log')
    .select('id, user_id, action, entity, entity_id, diff, at')
    .or(filters.join(','))
    .order('at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Resolve user emails in one extra query — cheaper than a join the
  // PostgREST way for an arbitrary set.
  const userIds = [...new Set((data || []).map((r) => r.user_id).filter(Boolean))];
  const userMap = new Map();
  if (userIds.length) {
    const { data: users, error: uErr } = await sb
      .from('users').select('id, email').in('id', userIds);
    if (uErr) return res.status(500).json({ ok: false, error: uErr.message });
    for (const u of users || []) userMap.set(u.id, u.email);
  }

  const entries = (data || []).map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    entity: r.entity,
    entity_id: r.entity_id,
    diff: r.diff,
    user_email: userMap.get(r.user_id) || null,
  }));

  res.json({ ok: true, entries });
});

// ── GET /api/audit/options ──────────────────────────────────
// Filter dropdown contents. Cheap-ish — three small queries that
// only run when the page mounts.
auditRouter.get('/api/audit/options', requireAdmin, async (_req, res) => {
  const sb = supabase();
  const [users, entities, actions] = await Promise.all([
    sb.from('users').select('id, email, name').order('email'),
    sb.from('audit_log').select('entity').limit(2000),
    sb.from('audit_log').select('action').limit(2000),
  ]);
  if (users.error || entities.error || actions.error) {
    return res.status(500).json({
      ok: false,
      error: users.error?.message || entities.error?.message || actions.error?.message,
    });
  }
  res.json({
    ok: true,
    users: users.data || [],
    entities: [...new Set((entities.data || []).map((r) => r.entity).filter(Boolean))].sort(),
    actions: [...new Set((actions.data || []).map((r) => r.action).filter(Boolean))].sort(),
  });
});

// ── GET /api/audit ──────────────────────────────────────────
// Filtered list. Filters: entity, user_id, action prefix, from/to
// (inclusive ISO dates). Returns up to 500 rows ordered newest-first
// + a `more` flag if the cap was hit.
auditRouter.get('/api/audit', requireAdmin, async (req, res) => {
  try {
    const sb = supabase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);

    let q = sb
      .from('audit_log')
      .select('id, user_id, action, entity, entity_id, diff, at')
      .order('at', { ascending: false })
      .limit(limit + 1); // +1 to detect "more"

    if (req.query.entity)    q = q.eq('entity', String(req.query.entity));
    if (req.query.action)    q = q.eq('action', String(req.query.action));
    if (req.query.user_id)   q = q.eq('user_id', String(req.query.user_id));
    if (req.query.entity_id) q = q.eq('entity_id', String(req.query.entity_id));

    if (req.query.from) {
      const f = String(req.query.from);
      if (!DATE_RE.test(f)) return res.status(400).json({ ok: false, error: 'from must be YYYY-MM-DD' });
      q = q.gte('at', f + 'T00:00:00Z');
    }
    if (req.query.to) {
      const t = String(req.query.to);
      if (!DATE_RE.test(t)) return res.status(400).json({ ok: false, error: 'to must be YYYY-MM-DD' });
      q = q.lt('at', t + 'T23:59:59.999Z');
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: error.message });

    const more = (data || []).length > limit;
    const rows = (data || []).slice(0, limit);

    // Resolve emails in one extra query.
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const userMap = new Map();
    if (userIds.length) {
      const { data: users, error: uErr } = await sb
        .from('users').select('id, email').in('id', userIds);
      if (uErr) return res.status(500).json({ ok: false, error: uErr.message });
      for (const u of users || []) userMap.set(u.id, u.email);
    }

    const entries = rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      entity: r.entity,
      entity_id: r.entity_id,
      diff: r.diff,
      user_id: r.user_id,
      user_email: userMap.get(r.user_id) || null,
    }));

    res.json({ ok: true, entries, more, limit });
  } catch (e) {
    res.status(e.code || 500).json({ ok: false, error: e.message });
  }
});
