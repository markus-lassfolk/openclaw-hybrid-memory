import { useState } from "react";
import { addFact } from "../live/curation";
import { LEGEND_CATEGORIES } from "../theme";

/** Modal to add a new memory (fact) to the store. */
export function AddFactDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [category, setCategory] = useState("fact");
  const [importance, setImportance] = useState(0.5);
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    const res = await addFact({
      text: text.trim(),
      category,
      importance,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setBusy(false);
    if (res.ok) onClose();
    else setError(res.error ?? "Could not add memory");
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>New memory</strong>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <label className="control">
          <span>text</span>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should be remembered?" />
        </label>
        <label className="control">
          <span>category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {LEGEND_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="control">
          <span>importance · {importance.toFixed(2)}</span>
          <input type="range" min={0} max={1} step={0.05} value={importance} onChange={(e) => setImportance(Number(e.target.value))} />
        </label>
        <label className="control">
          <span>tags (comma-separated)</span>
          <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ui, preference" />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <div className="actions">
          <button type="button" className="accent" disabled={busy || !text.trim()} onClick={submit}>
            Add memory
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
