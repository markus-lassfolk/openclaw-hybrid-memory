import { useEffect, useState } from "react";
import { fetchRequiresToken, getToken, setToken } from "../api/client";
import { useGraphStore } from "../store/graphStore";

/**
 * When the dashboard is configured with a token, mutations require it. This surfaces a small
 * control to paste/save the token (persisted in localStorage). Hidden entirely when no token is
 * required.
 */
export function TokenSettings() {
  const [requires, setRequires] = useState(false);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(getToken());
  const [saved, setSaved] = useState(Boolean(getToken()));
  const addActivity = useGraphStore((s) => s.addActivity);

  useEffect(() => {
    fetchRequiresToken()
      .then((r) => {
        setRequires(r);
        // Auto-open the prompt if a token is needed but none is set yet.
        if (r && !getToken()) setOpen(true);
      })
      .catch((e) => addActivity("update", `token check failed — ${e instanceof Error ? e.message : String(e)}`));
  }, [addActivity]);

  if (!requires) return null;

  const save = () => {
    setToken(value.trim());
    setSaved(Boolean(value.trim()));
    setOpen(false);
  };

  return (
    <div className="token-settings">
      <button type="button" className="token-chip" onClick={() => setOpen((o) => !o)} title="Dashboard token">
        {saved ? "🔓 token set" : "🔒 token required"}
      </button>
      {open ? (
        <div className="token-popover">
          <p className="muted">Editing memories requires the dashboard token.</p>
          <input
            type="password"
            placeholder="paste dashboard token…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <div className="token-actions">
            <button type="button" onClick={save}>
              Save
            </button>
            {saved ? (
              <button
                type="button"
                onClick={() => {
                  setToken("");
                  setValue("");
                  setSaved(false);
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
