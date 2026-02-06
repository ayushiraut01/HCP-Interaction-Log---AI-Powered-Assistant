import React, { useEffect, useMemo, useState } from "react";
import { Provider, useDispatch, useSelector } from "react-redux";
import { configureStore, createAsyncThunk, createSlice } from "@reduxjs/toolkit";

/**
 * CONFIG
 * Make sure this matches your FastAPI base URL.
 */
const API_BASE = "http://localhost:8000";

/**
 * API helpers
 */
async function apiJson(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.detail || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/**
 * Thunks
 */
const fetchInteractions = createAsyncThunk("hcp/fetchInteractions", async () => {
  return await apiJson("/api/interactions");
});

const sendChat = createAsyncThunk("hcp/sendChat", async ({ threadId, message }) => {
  return await apiJson("/api/agent/chat", {
    method: "POST",
    body: JSON.stringify({ thread_id: threadId, message }),
  });
});

const saveInteraction = createAsyncThunk("hcp/saveInteraction", async ({ draft }) => {
  return await apiJson("/api/interactions/log", {
    method: "POST",
    body: JSON.stringify({ interaction: draft }),
  });
});

const updateInteraction = createAsyncThunk("hcp/updateInteraction", async ({ id, patch }) => {
  return await apiJson(`/api/interactions/${id}`, {
    method: "PUT",
    body: JSON.stringify({ patch }),
  });
});

/**
 * Redux slice
 */
const hcpSlice = createSlice({
  name: "hcp",
  initialState: {
    mode: "form", // "form" | "chat"
    loading: false,
    error: null,

    interactions: [],
    selectedId: null,

    // Form data / Draft
    draft: {
      hcp_name: "",
      specialty: "",
      organization: "",
      interaction_datetime: new Date().toISOString().slice(0, 16),
      channel: "in_person", // in_person | call | video | email | whatsapp | other
      purpose: "",
      products_discussed: "",
      key_points: "",
      outcome: "",
      next_steps: "",
      follow_up_date: "",
      raw_notes: "",
      ai_summary: "",
      ai_entities_json: "",
      compliance_flags_json: "",
    },

    // Chat
    threadId: crypto?.randomUUID?.() || String(Date.now()),
    chat: [
      {
        role: "assistant",
        content:
          "Hi! Log an HCP interaction by typing naturally, e.g. “Met Dr. Sharma (Cardiologist) at Ruby Hall on 6 Feb, discussed Drug X safety, next follow-up next week.”",
      },
    ],
  },
  reducers: {
    setMode(state, action) {
      state.mode = action.payload;
      state.error = null;
    },
    setDraftField(state, action) {
      const { key, value } = action.payload;
      state.draft[key] = value;
    },
    resetDraft(state) {
      state.draft = {
        ...hcpSlice.getInitialState().draft,
        interaction_datetime: new Date().toISOString().slice(0, 16),
      };
    },
    selectInteraction(state, action) {
      state.selectedId = action.payload;
      const item = state.interactions.find((x) => x.id === action.payload);
      if (item) {
        state.draft = {
          ...state.draft,
          ...item,
          interaction_datetime: item.interaction_datetime
            ? item.interaction_datetime.slice(0, 16)
            : state.draft.interaction_datetime,
        };
      }
    },
    clearSelection(state) {
      state.selectedId = null;
    },
    pushChat(state, action) {
      state.chat.push(action.payload);
    },
    clearError(state) {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    const pending = (state) => {
      state.loading = true;
      state.error = null;
    };
    const rejected = (state, action) => {
      state.loading = false;
      state.error = action.error?.message || "Something went wrong";
    };

    builder
      .addCase(fetchInteractions.pending, pending)
      .addCase(fetchInteractions.fulfilled, (state, action) => {
        state.loading = false;
        state.interactions = action.payload?.items || [];
      })
      .addCase(fetchInteractions.rejected, rejected)

      .addCase(sendChat.pending, pending)
      .addCase(sendChat.fulfilled, (state, action) => {
        state.loading = false;

        // Add assistant response
        if (action.payload?.assistant_message) {
          state.chat.push({ role: "assistant", content: action.payload.assistant_message });
        }

        // Update draft if agent extracted structured fields
        if (action.payload?.draft_interaction) {
          state.draft = {
            ...state.draft,
            ...action.payload.draft_interaction,
            interaction_datetime: action.payload.draft_interaction.interaction_datetime
              ? action.payload.draft_interaction.interaction_datetime.slice(0, 16)
              : state.draft.interaction_datetime,
          };
        }
      })
      .addCase(sendChat.rejected, rejected)

      .addCase(saveInteraction.pending, pending)
      .addCase(saveInteraction.fulfilled, (state, action) => {
        state.loading = false;
        const saved = action.payload?.item;
        if (saved) state.interactions.unshift(saved);
        state.selectedId = null;
      })
      .addCase(saveInteraction.rejected, rejected)

      .addCase(updateInteraction.pending, pending)
      .addCase(updateInteraction.fulfilled, (state, action) => {
        state.loading = false;
        const updated = action.payload?.item;
        if (updated) {
          const idx = state.interactions.findIndex((x) => x.id === updated.id);
          if (idx >= 0) state.interactions[idx] = updated;
        }
      })
      .addCase(updateInteraction.rejected, rejected);
  },
});

const { actions, reducer } = hcpSlice;

const store = configureStore({
  reducer: { hcp: reducer },
});

/**
 * UI components
 */
function Pill({ children }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "6px 10px",
        borderRadius: 999,
        border: "1px solid rgba(0,0,0,0.1)",
        background: "rgba(0,0,0,0.02)",
        fontSize: 12,
      }}
    >
      {children}
    </span>
  );
}

function Label({ children }) {
  return <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>{children}</div>;
}

function Input({ value, onChange, placeholder, type = "text" }) {
  return (
    <input
      type={type}
      value={value || ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid rgba(0,0,0,0.12)",
        outline: "none",
        fontSize: 14,
      }}
    />
  );
}

function TextArea({ value, onChange, placeholder, rows = 4 }) {
  return (
    <textarea
      value={value || ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid rgba(0,0,0,0.12)",
        outline: "none",
        fontSize: 14,
        resize: "vertical",
      }}
    />
  );
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid rgba(0,0,0,0.12)",
        outline: "none",
        fontSize: 14,
        background: "white",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Button({ children, onClick, variant = "primary", disabled }) {
  const styles =
    variant === "primary"
      ? { background: "#111", color: "white" }
      : variant === "danger"
      ? { background: "#b42318", color: "white" }
      : { background: "white", color: "#111", border: "1px solid rgba(0,0,0,0.16)" };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 12px",
        borderRadius: 12,
        border: styles.border || "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontWeight: 600,
        ...styles,
      }}
    >
      {children}
    </button>
  );
}

function AppInner() {
  const dispatch = useDispatch();
  const state = useSelector((s) => s.hcp);

  useEffect(() => {
    dispatch(fetchInteractions());
  }, [dispatch]);

  const selected = useMemo(
    () => state.interactions.find((x) => x.id === state.selectedId),
    [state.interactions, state.selectedId]
  );

  const save = async () => {
    dispatch(actions.clearError());
    const payload = { ...state.draft };
    // Convert local datetime input to ISO for backend
    payload.interaction_datetime = new Date(payload.interaction_datetime).toISOString();
    await dispatch(saveInteraction({ draft: payload }));
    dispatch(fetchInteractions());
    dispatch(actions.resetDraft());
  };

  const edit = async () => {
    if (!state.selectedId) return;
    dispatch(actions.clearError());
    const patch = { ...state.draft };
    patch.interaction_datetime = new Date(patch.interaction_datetime).toISOString();
    await dispatch(updateInteraction({ id: state.selectedId, patch }));
    dispatch(fetchInteractions());
  };

  const send = async (text) => {
    if (!text.trim()) return;
    dispatch(actions.pushChat({ role: "user", content: text }));
    await dispatch(sendChat({ threadId: state.threadId, message: text }));
  };

  return (
    <div style={{ padding: 20, fontFamily: "Inter, system-ui, Arial, sans-serif" }}>
      {/* Inter font */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        body { margin: 0; background: #fafafa; }
      `}</style>

      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>AI-First CRM • HCP Log Interaction</div>
            <div style={{ opacity: 0.7, marginTop: 4, fontSize: 13 }}>
              Log via <b>Form</b> or <b>Chat</b>. Chat auto-fills structured fields using LangGraph + Groq.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Pill>Mode: {state.mode.toUpperCase()}</Pill>
            <Button
              variant={state.mode === "form" ? "primary" : "secondary"}
              onClick={() => dispatch(actions.setMode("form"))}
            >
              Form
            </Button>
            <Button
              variant={state.mode === "chat" ? "primary" : "secondary"}
              onClick={() => dispatch(actions.setMode("chat"))}
            >
              Chat
            </Button>
          </div>
        </div>

        {state.error && (
          <div
            style={{
              marginTop: 14,
              padding: 12,
              borderRadius: 14,
              background: "rgba(180,35,24,0.10)",
              border: "1px solid rgba(180,35,24,0.25)",
              color: "#7a1b14",
              fontSize: 13,
            }}
          >
            {state.error}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16, marginTop: 16 }}>
          {/* Left: list */}
          <div
            style={{
              background: "white",
              borderRadius: 18,
              padding: 14,
              border: "1px solid rgba(0,0,0,0.08)",
              height: "calc(100vh - 150px)",
              overflow: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 800 }}>Recent interactions</div>
              <Button variant="secondary" onClick={() => dispatch(fetchInteractions())} disabled={state.loading}>
                Refresh
              </Button>
            </div>

            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {state.interactions.map((it) => (
                <div
                  key={it.id}
                  onClick={() => dispatch(actions.selectInteraction(it.id))}
                  style={{
                    padding: 12,
                    borderRadius: 14,
                    border:
                      state.selectedId === it.id
                        ? "1px solid rgba(0,0,0,0.35)"
                        : "1px solid rgba(0,0,0,0.08)",
                    background: state.selectedId === it.id ? "rgba(0,0,0,0.03)" : "white",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 800, fontSize: 14 }}>{it.hcp_name || "Unnamed HCP"}</div>
                  <div style={{ opacity: 0.7, fontSize: 12, marginTop: 2 }}>
                    {it.specialty || "—"} • {it.channel || "—"}
                  </div>
                  <div style={{ opacity: 0.8, fontSize: 12, marginTop: 8, lineHeight: 1.35 }}>
                    {(it.ai_summary || it.raw_notes || "").slice(0, 90)}
                    {(it.ai_summary || it.raw_notes || "").length > 90 ? "…" : ""}
                  </div>
                </div>
              ))}
              {state.interactions.length === 0 && (
                <div style={{ opacity: 0.7, fontSize: 13, padding: 10 }}>
                  No interactions yet. Use Form or Chat to log one.
                </div>
              )}
            </div>
          </div>

          {/* Right: main */}
          <div
            style={{
              background: "white",
              borderRadius: 18,
              padding: 16,
              border: "1px solid rgba(0,0,0,0.08)",
              height: "calc(100vh - 150px)",
              overflow: "auto",
            }}
          >
            {/* Header actions */}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 900 }}>
                {state.selectedId ? "Edit Interaction" : "New Interaction"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {state.selectedId && (
                  <Button variant="secondary" onClick={() => dispatch(actions.clearSelection())}>
                    Stop Editing
                  </Button>
                )}
                <Button variant="secondary" onClick={() => dispatch(actions.resetDraft())}>
                  Clear Draft
                </Button>
                {state.selectedId ? (
                  <Button onClick={edit} disabled={state.loading}>
                    Save Changes
                  </Button>
                ) : (
                  <Button onClick={save} disabled={state.loading}>
                    Save Interaction
                  </Button>
                )}
              </div>
            </div>

            {/* Mode panels */}
            {state.mode === "chat" ? (
              <ChatPanel chat={state.chat} onSend={send} loading={state.loading} />
            ) : (
              <div style={{ marginTop: 14, opacity: 0.8, fontSize: 13 }}>
                Tip: If you want AI to fill fields automatically, switch to <b>Chat</b>.
              </div>
            )}

            {/* Draft */}
            <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <Label>HCP Name</Label>
                <Input
                  value={state.draft.hcp_name}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "hcp_name", value: v }))}
                  placeholder="e.g., Dr. A. Sharma"
                />
              </div>

              <div>
                <Label>Specialty</Label>
                <Input
                  value={state.draft.specialty}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "specialty", value: v }))}
                  placeholder="e.g., Cardiologist"
                />
              </div>

              <div>
                <Label>Organization / Hospital / Clinic</Label>
                <Input
                  value={state.draft.organization}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "organization", value: v }))}
                  placeholder="e.g., Ruby Hall Clinic"
                />
              </div>

              <div>
                <Label>Interaction Date/Time</Label>
                <Input
                  type="datetime-local"
                  value={state.draft.interaction_datetime}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "interaction_datetime", value: v }))}
                />
              </div>

              <div>
                <Label>Channel</Label>
                <Select
                  value={state.draft.channel}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "channel", value: v }))}
                  options={[
                    { value: "in_person", label: "In Person" },
                    { value: "call", label: "Phone Call" },
                    { value: "video", label: "Video" },
                    { value: "email", label: "Email" },
                    { value: "whatsapp", label: "WhatsApp" },
                    { value: "other", label: "Other" },
                  ]}
                />
              </div>

              <div>
                <Label>Purpose</Label>
                <Input
                  value={state.draft.purpose}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "purpose", value: v }))}
                  placeholder="e.g., Follow-up on recent Rx behavior"
                />
              </div>

              <div style={{ gridColumn: "1 / span 2" }}>
                <Label>Products Discussed</Label>
                <Input
                  value={state.draft.products_discussed}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "products_discussed", value: v }))}
                  placeholder="e.g., Brand A, Brand B"
                />
              </div>

              <div style={{ gridColumn: "1 / span 2" }}>
                <Label>Key Points / Talking Points</Label>
                <TextArea
                  rows={3}
                  value={state.draft.key_points}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "key_points", value: v }))}
                  placeholder="What was discussed (clinical, safety, dosing, access, objections, etc.)"
                />
              </div>

              <div style={{ gridColumn: "1 / span 2" }}>
                <Label>Outcome</Label>
                <TextArea
                  rows={2}
                  value={state.draft.outcome}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "outcome", value: v }))}
                  placeholder="Result of interaction, commitments, concerns"
                />
              </div>

              <div style={{ gridColumn: "1 / span 2" }}>
                <Label>Next Steps</Label>
                <TextArea
                  rows={2}
                  value={state.draft.next_steps}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "next_steps", value: v }))}
                  placeholder="Follow-ups, samples, email, meeting, etc."
                />
              </div>

              <div>
                <Label>Follow-up Date (optional)</Label>
                <Input
                  type="date"
                  value={state.draft.follow_up_date}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "follow_up_date", value: v }))}
                />
              </div>

              <div />

              <div style={{ gridColumn: "1 / span 2" }}>
                <Label>Raw Notes</Label>
                <TextArea
                  rows={3}
                  value={state.draft.raw_notes}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "raw_notes", value: v }))}
                  placeholder="Free text notes (agent can summarize + extract entities)"
                />
              </div>

              <div style={{ gridColumn: "1 / span 2" }}>
                <Label>AI Summary (auto)</Label>
                <TextArea
                  rows={2}
                  value={state.draft.ai_summary}
                  onChange={(v) => dispatch(actions.setDraftField({ key: "ai_summary", value: v }))}
                  placeholder="Filled by AI when you use Chat or Save"
                />
              </div>

              <div style={{ gridColumn: "1 / span 2", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <Label>AI Entities JSON (auto)</Label>
                  <TextArea
                    rows={3}
                    value={state.draft.ai_entities_json}
                    onChange={(v) => dispatch(actions.setDraftField({ key: "ai_entities_json", value: v }))}
                    placeholder='{"hcp":"...","products":[...],"intent":"..."}'
                  />
                </div>
                <div>
                  <Label>Compliance Flags JSON (auto)</Label>
                  <TextArea
                    rows={3}
                    value={state.draft.compliance_flags_json}
                    onChange={(v) => dispatch(actions.setDraftField({ key: "compliance_flags_json", value: v }))}
                    placeholder='{"flags":["off_label","no_balance"],"severity":"low"}'
                  />
                </div>
              </div>
            </div>

            {/* Footer hint */}
            <div style={{ marginTop: 16, fontSize: 12, opacity: 0.7, lineHeight: 1.4 }}>
              {state.selectedId ? (
                <>Editing ID: <b>{state.selectedId}</b></>
              ) : (
                <>Not editing — you will create a new interaction.</>
              )}
              {selected?.created_at && <> • Created: {new Date(selected.created_at).toLocaleString()}</>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatPanel({ chat, onSend, loading }) {
  const [text, setText] = useState("");

  const submit = async () => {
    const t = text;
    setText("");
    await onSend(t);
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 800, marginBottom: 10 }}>Conversational logging</div>

      <div
        style={{
          border: "1px solid rgba(0,0,0,0.08)",
          borderRadius: 16,
          padding: 12,
          background: "#fafafa",
          height: 240,
          overflow: "auto",
        }}
      >
        {chat.map((m, idx) => (
          <div key={idx} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div
              style={{
                maxWidth: "78%",
                padding: "10px 12px",
                borderRadius: 14,
                marginBottom: 8,
                background: m.role === "user" ? "#111" : "white",
                color: m.role === "user" ? "white" : "#111",
                border: m.role === "user" ? "none" : "1px solid rgba(0,0,0,0.08)",
                fontSize: 13,
                lineHeight: 1.35,
                whiteSpace: "pre-wrap",
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && <div style={{ opacity: 0.7, fontSize: 12 }}>Agent thinking…</div>}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <Input
          value={text}
          onChange={setText}
          placeholder='Type interaction… e.g., "Met Dr. X, discussed Y, next step Z"'
        />
        <Button onClick={submit} disabled={loading}>
          Send
        </Button>
      </div>
    </div>
  );
}

/**
 * Export root with Provider
 */
export default function App() {
  return (
    <Provider store={store}>
      <AppInner />
    </Provider>
  );
}
