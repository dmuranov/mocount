// Audit routes — partial. Step 14 only needs the by-number lookup
// for the NumberDetail drawer. The full /audit page (filters, range)
// lands in step 20 and will add more endpoints to this router.

import express from 'express';
import { requireAuth } from '../auth/middleware.js';
import { supabase } from '../supabase.js';

export const auditRouter = express.Router();

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
