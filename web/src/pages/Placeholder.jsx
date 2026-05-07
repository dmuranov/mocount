// Single shared "coming in step N" page so route table compiles
// while the per-feature implementations are still ahead.

export default function Placeholder({ title, step }) {
  return (
    <div className="page">
      <h2>{title}</h2>
      <p className="mono">// page arrives in step {step}</p>
    </div>
  );
}
