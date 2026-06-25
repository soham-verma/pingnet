import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyInfo } from "../types";

interface Props {
  onClose: () => void;
}

export default function KeyManager({ onClose }: Props) {
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Regenerate state — tracks which key name is being regenerated + shows new pubkey
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [regenResult, setRegenResult] = useState<{ name: string; pubKey: string } | null>(null);

  // Generate form state
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [generating, setGenerating] = useState(false);
  const [newPubKey, setNewPubKey] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  // Deletion
  const [deleting, setDeleting] = useState<string | null>(null);

  // Copied flash
  const [copied, setCopied] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<KeyInfo[]>("list_ssh_keys");
      setKeys(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    // BUG-02 fix: if a key with the same name already exists, warn before overwriting.
    // The Regenerate action already does this — Generate must too, since both paths
    // call generate_ssh_key which silently replaces the keychain entry.
    const existing = keys.find((k) => k.name === trimmedName);
    if (existing) {
      const ok = window.confirm(
        `A key named "${trimmedName}" already exists.\n\n` +
        `Generating a new key will permanently overwrite the old private key — ` +
        `any servers already using it will lose access.\n\n` +
        `Continue and overwrite?`
      );
      if (!ok) return;
    }

    setGenerating(true);
    setGenError(null);
    setNewPubKey(null);
    try {
      const pub = await invoke<string>("generate_ssh_key", {
        name: trimmedName,
        comment: comment.trim() || trimmedName,
      });
      setNewPubKey(pub);
      setName("");
      setComment("");
      await loadKeys();
    } catch (e) {
      setGenError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleDelete(keyName: string) {
    // BUG-06 fix: confirm before deleting — keychain removal is irreversible.
    const ok = window.confirm(
      `Delete key "${keyName}"?\n\nThe private key will be permanently removed from the OS keychain. Any servers using it will lose access.`
    );
    if (!ok) return;

    setDeleting(keyName);
    try {
      await invoke("delete_ssh_key", { name: keyName });
      // BUG-10 fix: if the key that was just generated (newPubKey banner) is the one
      // being deleted, clear the banner — showing a public key for a deleted key is misleading.
      setNewPubKey((prev) => {
        // We don't have the key name stored with newPubKey, so clear it unconditionally
        // on any delete to avoid showing stale public key material.
        void prev;
        return null;
      });
      await loadKeys();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(null);
    }
  }

  async function handleRegenerate(key: KeyInfo) {
    if (!window.confirm(`Regenerate "${key.name}"? The old key will be permanently replaced. You'll need to update authorized_keys on any servers that use it.`)) return;
    setRegenerating(key.name);
    setRegenResult(null);
    try {
      const pub = await invoke<string>("regenerate_ssh_key", {
        name: key.name,
        comment: key.comment || key.name,
      });
      setRegenResult({ name: key.name, pubKey: pub });
      await loadKeys();
    } catch (e) {
      setError(String(e));
    } finally {
      setRegenerating(null);
    }
  }

  function copyKey(pub: string, id: string) {
    navigator.clipboard.writeText(pub).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1800);
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col"
        style={{ background: "var(--bg2)", maxHeight: "85vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--border)] flex-shrink-0">
          <div>
            <h2 className="font-semibold text-[var(--text)] text-sm">SSH Key Manager</h2>
            <p className="text-[11px] text-[var(--text3)] mt-0.5">Keys stored in OS keychain (Ed25519)</p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text3)] hover:text-[var(--text)] transition-colors text-xl"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Generate form */}
          <form onSubmit={handleGenerate} className="px-6 py-4 border-b border-[var(--border)] space-y-3">
            <p className="text-[10px] tracking-widest text-[var(--text3)] uppercase">Generate New Key</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Key name (e.g. work-vps)"
                className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text)] placeholder-[var(--text5)] outline-none focus:border-[#6366f1] transition-all"
              />
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Comment (optional)"
                className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text)] placeholder-[var(--text5)] outline-none focus:border-[#6366f1] transition-all"
              />
              <button
                type="submit"
                disabled={generating || !name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--text)] bg-[#6366f1] hover:bg-[#818cf8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
              >
                {generating ? "Generating…" : "Generate"}
              </button>
            </div>
            {genError && <p className="text-[#ef4444] text-xs">{genError}</p>}
            {newPubKey && (
              <div className="rounded-lg bg-[var(--bg)] border border-[#22c55e30] p-3 space-y-1">
                <p className="text-[10px] text-[#22c55e] tracking-widest uppercase">Key generated — add this to your server's authorized_keys</p>
                <pre className="text-[10px] text-[var(--text2)] font-mono break-all whitespace-pre-wrap">{newPubKey}</pre>
                <button
                  type="button"
                  onClick={() => copyKey(newPubKey, "new")}
                  className="text-xs text-[#6366f1] hover:text-[#818cf8] transition-colors"
                >
                  {copied === "new" ? "Copied!" : "Copy to clipboard"}
                </button>
              </div>
            )}
          </form>

          {/* Key list */}
          <div className="px-6 py-4 space-y-3">
            <p className="text-[10px] tracking-widest text-[var(--text3)] uppercase">Saved Keys ({keys.length})</p>

            {loading ? (
              <p className="text-[var(--text3)] text-sm py-4 text-center">Loading…</p>
            ) : error ? (
              <p className="text-[#ef4444] text-sm">{error}</p>
            ) : keys.length === 0 ? (
              <p className="text-[var(--text5)] text-sm py-4 text-center">No keys yet — generate one above</p>
            ) : (
              keys.map((k) => (
                <div
                  key={k.name}
                  className="bg-[var(--bg)] border border-[var(--border)] rounded-xl p-4 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[var(--text)] text-sm font-medium">{k.name}</p>
                      {k.comment && (
                        <p className="text-[11px] text-[var(--text3)]">{k.comment}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => copyKey(k.public_key, k.name)}
                        className="text-[11px] text-[#6366f1] hover:text-[#818cf8] transition-colors"
                      >
                        {copied === k.name ? "Copied!" : "Copy pub key"}
                      </button>
                      <button
                        onClick={() => handleRegenerate(k)}
                        disabled={regenerating === k.name}
                        className="text-[11px] text-[#f59e0b] hover:text-[#fbbf24] transition-colors disabled:opacity-40"
                        title="Generate a new keypair under this name — replaces the old key"
                      >
                        {regenerating === k.name ? "Regenerating…" : "Regenerate"}
                      </button>
                      <button
                        onClick={() => handleDelete(k.name)}
                        disabled={deleting === k.name}
                        className="text-[11px] text-[var(--text3)] hover:text-[#ef4444] transition-colors disabled:opacity-40"
                      >
                        {deleting === k.name ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                  <pre className="text-[9px] text-[var(--text4)] font-mono truncate">{k.public_key}</pre>
                  <p className="text-[10px] text-[var(--text5)]">
                    Created {new Date(k.created_at).toLocaleDateString()}
                  </p>

                  {/* Regen success banner */}
                  {regenResult?.name === k.name && (
                    <div className="rounded-lg bg-[var(--bg)] border border-[#f59e0b30] p-3 space-y-1 mt-1">
                      <p className="text-[10px] text-[#f59e0b] tracking-widest uppercase">New key — update authorized_keys on your servers</p>
                      <pre className="text-[10px] text-[var(--text2)] font-mono break-all whitespace-pre-wrap">{regenResult.pubKey}</pre>
                      <button
                        type="button"
                        onClick={() => copyKey(regenResult.pubKey, `regen-${k.name}`)}
                        className="text-xs text-[#f59e0b] hover:text-[#fbbf24] transition-colors"
                      >
                        {copied === `regen-${k.name}` ? "Copied!" : "Copy to clipboard"}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
