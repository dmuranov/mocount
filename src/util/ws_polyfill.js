// Make globalThis.WebSocket exist before @supabase/supabase-js loads.
//
// supabase-js's RealtimeClient throws on Node 20 because Node 20
// doesn't expose a global WebSocket constructor (Node 22+ does).
// We don't use realtime, but createClient() instantiates a
// RealtimeClient regardless, so the throw kills any DB call. The
// `ws` polyfill keeps supabase-js happy without changing the API.

import WebSocket from 'ws';
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}
