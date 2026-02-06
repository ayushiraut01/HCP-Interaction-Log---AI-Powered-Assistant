import os
import json
from typing import Optional, Dict, Any, List, TypedDict

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from datetime import datetime

from sqlalchemy import (
    create_engine, Column, Integer, String, Text, DateTime
)
from sqlalchemy.orm import sessionmaker, declarative_base

# --- LangGraph ---
from langgraph.graph import StateGraph, END

# --- Groq LLM ---
# pip install groq
from groq import Groq

# =========================
# CONFIG
# =========================
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "gemma2-9b-it")  # required by task

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    # Example Postgres: postgresql+psycopg2://user:pass@localhost:5432/hcpcrm
    # Example MySQL: mysql+pymysql://user:pass@localhost:3306/hcpcrm
    "postgresql+psycopg2://postgres:postgres@localhost:5432/hcpcrm"
)

if not GROQ_API_KEY:
    # Don't crash, but warn via API errors on LLM calls
    pass

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

# =========================
# DB SETUP
# =========================
Base = declarative_base()
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

class Interaction(Base):
    __tablename__ = "hcp_interactions"

    id = Column(Integer, primary_key=True, index=True)
    hcp_name = Column(String(255), default="")
    specialty = Column(String(255), default="")
    organization = Column(String(255), default="")

    interaction_datetime = Column(DateTime, default=datetime.utcnow)
    channel = Column(String(50), default="in_person")
    purpose = Column(String(255), default="")
    products_discussed = Column(String(255), default="")

    key_points = Column(Text, default="")
    outcome = Column(Text, default="")
    next_steps = Column(Text, default="")
    follow_up_date = Column(String(50), default="")

    raw_notes = Column(Text, default="")
    ai_summary = Column(Text, default="")
    ai_entities_json = Column(Text, default="")
    compliance_flags_json = Column(Text, default="")

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

Base.metadata.create_all(bind=engine)

# =========================
# FASTAPI
# =========================
app = FastAPI(title="AI-First CRM HCP Module (Log Interaction)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# SCHEMAS
# =========================
class InteractionDraft(BaseModel):
    hcp_name: str = ""
    specialty: str = ""
    organization: str = ""
    interaction_datetime: Optional[str] = None  # ISO
    channel: str = "in_person"
    purpose: str = ""
    products_discussed: str = ""
    key_points: str = ""
    outcome: str = ""
    next_steps: str = ""
    follow_up_date: str = ""
    raw_notes: str = ""
    ai_summary: str = ""
    ai_entities_json: str = ""
    compliance_flags_json: str = ""

class LogInteractionReq(BaseModel):
    interaction: InteractionDraft

class EditInteractionReq(BaseModel):
    patch: Dict[str, Any] = Field(default_factory=dict)

class ChatReq(BaseModel):
    thread_id: Optional[str] = None
    message: str

# =========================
# UTIL: LLM CALL
# =========================
def groq_chat(system: str, user: str, model: str = GROQ_MODEL) -> str:
    if not client:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY not set on backend")
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
    )
    return resp.choices[0].message.content or ""

# =========================
# LANGGRAPH AGENT
# Role: orchestrates conversational logging:
#  - detect intent (log vs edit vs question)
#  - extract structured fields
#  - run compliance check
#  - produce assistant response + draft interaction
#  - optionally call tools to save/edit
# =========================

class AgentState(TypedDict, total=False):
    thread_id: str
    user_message: str
    intent: str
    extracted: Dict[str, Any]
    compliance: Dict[str, Any]
    assistant_message: str

# --------- TOOLS (>= 5, includes Log Interaction + Edit Interaction) ---------
def tool_search_hcp_profile(db, hcp_name: str) -> Dict[str, Any]:
    """
    Tool 1: Search HCP Profile (sales rep convenience)
    Looks for past interactions and returns quick context.
    """
    rows = db.query(Interaction).filter(Interaction.hcp_name.ilike(f"%{hcp_name}%")).order_by(Interaction.created_at.desc()).limit(5).all()
    return {
        "hcp_name": hcp_name,
        "recent_interactions": [
            {"id": r.id, "when": r.interaction_datetime.isoformat() if r.interaction_datetime else None, "summary": (r.ai_summary or r.raw_notes or "")[:180]}
            for r in rows
        ]
    }

def tool_suggest_next_best_action(extracted: Dict[str, Any]) -> Dict[str, Any]:
    """
    Tool 2: Next Best Action suggestion (NBA)
    """
    # Simple heuristic fallback (can be LLM-driven too)
    channel = (extracted.get("channel") or "").lower()
    if channel in ["email", "whatsapp"]:
        nba = "Send a balanced follow-up message with approved materials and confirm next meeting date."
    else:
        nba = "Schedule a follow-up visit/call and share approved clinical summary + address any objections."
    return {"next_best_action": nba}

def tool_compliance_check_llm(text: str) -> Dict[str, Any]:
    """
    Tool 3: Compliance / Safety check
    Flags off-label, unbalanced claims, missing fair-balance mention (conceptual).
    """
    system = (
        "You are a pharma compliance checker. Return strict JSON only:\n"
        '{ "flags": [..], "severity": "low|medium|high", "notes": "..." }.\n'
        "Flags examples: off_label, promotion_to_patient, safety_missing, unbalanced_claim, competitor_bashing, pii_risk.\n"
    )
    out = groq_chat(system, f"Text:\n{text}\nReturn JSON only.")
    try:
        return json.loads(out)
    except Exception:
        return {"flags": ["parse_error"], "severity": "low", "notes": out[:400]}

def tool_log_interaction(db, draft: Dict[str, Any]) -> Dict[str, Any]:
    """
    Tool 4 (REQUIRED): Log Interaction
    - Captures interaction data
    - Can store AI summary + extracted entities + compliance flags
    """
    dt_iso = draft.get("interaction_datetime")
    dt = datetime.utcnow()
    if dt_iso:
        try:
            dt = datetime.fromisoformat(dt_iso.replace("Z", "+00:00")).replace(tzinfo=None)
        except Exception:
            dt = datetime.utcnow()

    row = Interaction(
        hcp_name=draft.get("hcp_name", ""),
        specialty=draft.get("specialty", ""),
        organization=draft.get("organization", ""),
        interaction_datetime=dt,
        channel=draft.get("channel", "in_person"),
        purpose=draft.get("purpose", ""),
        products_discussed=draft.get("products_discussed", ""),
        key_points=draft.get("key_points", ""),
        outcome=draft.get("outcome", ""),
        next_steps=draft.get("next_steps", ""),
        follow_up_date=draft.get("follow_up_date", ""),
        raw_notes=draft.get("raw_notes", ""),
        ai_summary=draft.get("ai_summary", ""),
        ai_entities_json=draft.get("ai_entities_json", ""),
        compliance_flags_json=draft.get("compliance_flags_json", ""),
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"id": row.id}

def tool_edit_interaction(db, interaction_id: int, patch: Dict[str, Any]) -> Dict[str, Any]:
    """
    Tool 5 (REQUIRED): Edit Interaction
    - Allows modification of logged data
    - Updates timestamps
    """
    row = db.query(Interaction).filter(Interaction.id == interaction_id).first()
    if not row:
        return {"ok": False, "error": "not_found"}

    # Only allow known fields
    allowed = {
        "hcp_name","specialty","organization","interaction_datetime","channel","purpose",
        "products_discussed","key_points","outcome","next_steps","follow_up_date",
        "raw_notes","ai_summary","ai_entities_json","compliance_flags_json"
    }
    for k, v in patch.items():
        if k not in allowed:
            continue
        if k == "interaction_datetime" and isinstance(v, str):
            try:
                vdt = datetime.fromisoformat(v.replace("Z", "+00:00")).replace(tzinfo=None)
                setattr(row, k, vdt)
            except Exception:
                pass
        else:
            setattr(row, k, v if v is not None else "")
    row.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True}

def tool_summarize_and_extract(text: str) -> Dict[str, Any]:
    """
    Tool 6: Summarize + Entity extraction
    Uses LLM to create:
      - ai_summary (short)
      - entities JSON (hcp, specialty, org, products, outcomes, next steps, dates)
    """
    system = (
        "You are an expert life-sciences CRM assistant for field reps.\n"
        "Return STRICT JSON only with keys:\n"
        '{ "summary":"...", "entities": { "hcp_name":"", "specialty":"", "organization":"", "channel":"", '
        '"purpose":"", "products_discussed":"", "key_points":"", "outcome":"", "next_steps":"", "follow_up_date":"" } }\n'
        "Rules:\n"
        "- Keep summary <= 3 lines.\n"
        "- If a field is missing, keep it empty.\n"
        "- channel must be one of: in_person, call, video, email, whatsapp, other.\n"
        "- follow_up_date should be YYYY-MM-DD if possible.\n"
    )
    out = groq_chat(system, f"Interaction text:\n{text}\nReturn JSON only.")
    try:
        return json.loads(out)
    except Exception:
        return {"summary": text[:180], "entities": {}}

def tool_generate_followup_message(extracted: Dict[str, Any]) -> Dict[str, Any]:
    """
    Tool 7: Draft follow-up message (approved-tone)
    """
    hcp = extracted.get("hcp_name") or "Doctor"
    products = extracted.get("products_discussed") or "the discussed product"
    system = "Write a short, professional follow-up message for an HCP. Avoid promotional exaggeration. Keep it balanced."
    msg = groq_chat(system, f"Draft a follow-up message to {hcp} about {products}.")
    return {"followup_message": msg.strip()}

# --------- Graph nodes ---------
def node_route_intent(state: AgentState) -> AgentState:
    """
    Decide user intent: log vs edit vs question.
    For simplicity: default is 'log' unless user clearly says edit.
    """
    text = state["user_message"].lower()
    if "edit" in text or "change" in text or "update" in text:
        state["intent"] = "edit"
    else:
        state["intent"] = "log"
    return state

def node_extract(state: AgentState) -> AgentState:
    """
    Use LLM tool to extract structured fields from the user message.
    """
    result = tool_summarize_and_extract(state["user_message"])
    entities = result.get("entities") or {}
    summary = result.get("summary") or ""

    # Build a draft interaction object
    draft = {
        "hcp_name": entities.get("hcp_name", ""),
        "specialty": entities.get("specialty", ""),
        "organization": entities.get("organization", ""),
        "interaction_datetime": datetime.utcnow().isoformat(),
        "channel": entities.get("channel", "in_person") or "in_person",
        "purpose": entities.get("purpose", ""),
        "products_discussed": entities.get("products_discussed", ""),
        "key_points": entities.get("key_points", ""),
        "outcome": entities.get("outcome", ""),
        "next_steps": entities.get("next_steps", ""),
        "follow_up_date": entities.get("follow_up_date", ""),
        "raw_notes": state["user_message"],
        "ai_summary": summary,
        "ai_entities_json": json.dumps(entities, ensure_ascii=False),
        "compliance_flags_json": "",
    }
    state["extracted"] = {"draft": draft}
    return state

def node_compliance(state: AgentState) -> AgentState:
    draft = (state.get("extracted") or {}).get("draft") or {}
    combined = f"{draft.get('raw_notes','')}\nSummary: {draft.get('ai_summary','')}"
    compliance = tool_compliance_check_llm(combined)
    state["compliance"] = compliance
    # store on draft
    draft["compliance_flags_json"] = json.dumps(compliance, ensure_ascii=False)
    state["extracted"]["draft"] = draft
    return state

def node_respond(state: AgentState) -> AgentState:
    draft = (state.get("extracted") or {}).get("draft") or {}
    nba = tool_suggest_next_best_action(draft).get("next_best_action", "")

    flags = (state.get("compliance") or {}).get("flags") or []
    sev = (state.get("compliance") or {}).get("severity") or "low"

    msg = (
        "✅ I extracted a draft interaction and filled the form fields.\n"
        f"• Next best action: {nba}\n"
    )
    if flags and flags != ["parse_error"]:
        msg += f"⚠️ Compliance flags ({sev}): {', '.join(flags)}\n"
    msg += "If this looks correct, click **Save Interaction** in the UI. If not, edit the fields and save."

    state["assistant_message"] = msg
    return state

# Build the graph (required by task)
graph = StateGraph(AgentState)
graph.add_node("route_intent", node_route_intent)
graph.add_node("extract", node_extract)
graph.add_node("compliance", node_compliance)
graph.add_node("respond", node_respond)

graph.set_entry_point("route_intent")
graph.add_edge("route_intent", "extract")
graph.add_edge("extract", "compliance")
graph.add_edge("compliance", "respond")
graph.add_edge("respond", END)

agent_app = graph.compile()

# =========================
# API ENDPOINTS
# =========================
def to_dict(row: Interaction) -> Dict[str, Any]:
    return {
        "id": row.id,
        "hcp_name": row.hcp_name,
        "specialty": row.specialty,
        "organization": row.organization,
        "interaction_datetime": row.interaction_datetime.isoformat() if row.interaction_datetime else None,
        "channel": row.channel,
        "purpose": row.purpose,
        "products_discussed": row.products_discussed,
        "key_points": row.key_points,
        "outcome": row.outcome,
        "next_steps": row.next_steps,
        "follow_up_date": row.follow_up_date,
        "raw_notes": row.raw_notes,
        "ai_summary": row.ai_summary,
        "ai_entities_json": row.ai_entities_json,
        "compliance_flags_json": row.compliance_flags_json,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }

@app.get("/api/interactions")
def list_interactions():
    db = SessionLocal()
    try:
        items = db.query(Interaction).order_by(Interaction.created_at.desc()).limit(100).all()
        return {"items": [to_dict(x) for x in items]}
    finally:
        db.close()

@app.post("/api/agent/chat")
def agent_chat(req: ChatReq):
    """
    Chat endpoint:
    - Runs LangGraph agent
    - Returns assistant message + a structured draft interaction
    """
    state: AgentState = {
        "thread_id": req.thread_id or "default",
        "user_message": req.message,
    }
    out = agent_app.invoke(state)

    draft = ((out.get("extracted") or {}).get("draft")) if out else None
    return {
        "assistant_message": out.get("assistant_message", "Done."),
        "draft_interaction": draft or {},
    }

@app.post("/api/interactions/log")
def log_interaction(req: LogInteractionReq):
    """
    Logs interaction (Tool: Log Interaction).
    If ai_summary/entities are missing, backend will generate them using Groq.
    """
    db = SessionLocal()
    try:
        draft = req.interaction.dict()

        # If no AI summary/entities provided, generate from raw notes
        if (not draft.get("ai_summary")) or (not draft.get("ai_entities_json")):
            result = tool_summarize_and_extract(draft.get("raw_notes", "") or "")
            entities = result.get("entities") or {}
            draft["ai_summary"] = draft.get("ai_summary") or (result.get("summary") or "")
            draft["ai_entities_json"] = draft.get("ai_entities_json") or json.dumps(entities, ensure_ascii=False)

        # Compliance check
        if not draft.get("compliance_flags_json"):
            compliance = tool_compliance_check_llm((draft.get("raw_notes") or "") + "\n" + (draft.get("ai_summary") or ""))
            draft["compliance_flags_json"] = json.dumps(compliance, ensure_ascii=False)

        created = tool_log_interaction(db, draft)
        row = db.query(Interaction).filter(Interaction.id == created["id"]).first()
        return {"item": to_dict(row)}
    finally:
        db.close()

@app.put("/api/interactions/{interaction_id}")
def edit_interaction(interaction_id: int, req: EditInteractionReq):
    """
    Edit interaction (Tool: Edit Interaction).
    """
    db = SessionLocal()
    try:
        ok = tool_edit_interaction(db, interaction_id, req.patch)
        if not ok.get("ok"):
            raise HTTPException(status_code=404, detail="Interaction not found")

        row = db.query(Interaction).filter(Interaction.id == interaction_id).first()
        return {"item": to_dict(row)}
    finally:
        db.close()

@app.get("/health")
def health():
    return {"ok": True, "model": GROQ_MODEL}
