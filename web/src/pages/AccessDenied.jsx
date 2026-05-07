export default function AccessDenied() {
  return (
    <div className="app-shell">
      <div className="box">
        <h1 className="brand">mo<span>count</span></h1>
        <div className="err-box">Your Google account isn't on the allowlist for mocount.</div>
        <p>Contact your administrator to be added.</p>
        <p style={{ marginTop: 24 }}>
          <a className="mono" href="/login">← back to sign in</a>
        </p>
      </div>
    </div>
  );
}
