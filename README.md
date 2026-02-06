# HCP-Interaction-Log---AI-Powered-Assistant


An advanced AI-driven platform designed to streamline Healthcare Professional (HCP) interactions. This application leverages **LangGraph** to create a stateful, tool-augmented agent that automates documentation and provides deep insights into clinical engagements.

---

## 🚀 Live Demo & Repository
- **Frontend URL:** [https://hcp-interaction-log--aiayushi99.replit.app/](https://hcp-interaction-log--aiayushi99.replit.app/)
- **Backend:** Python / FastAPI / LangGraph
- **Frontend:** React / Tailwind CSS

---

## 🛠️ The 5 LangGraph Tools
The core of this application is a multi-agent system that intelligently selects from the following tools:

1.  **Log Search:** Efficiently retrieves historical interaction records from the database using keyword and metadata filtering.
2.  **Data Formatter:** Converts unstructured conversational notes into structured, professional clinical formats.
3.  **Sentiment Analysis:** Analyzes the emotional tone of the HCP to gauge relationship health and satisfaction levels.
4.  **Follow-up Scheduler:** An intelligent tool that calculates the optimal date for the next engagement based on interaction outcomes.
5.  **Report Generator:** Aggregates multiple interaction points into a concise, actionable summary for management review.

---

## 🏗️ Architecture & Logic Flow
The system follows a modular full-stack architecture:

* **Stateful Backend:** Unlike traditional chatbots, this uses a **StateGraph**. The agent maintains a "State" object that tracks conversation history and tool responses, allowing for complex decision-making loops.
* **Asynchronous Processing:** Since the AI agent performs multiple steps (thinking, tool calling, summarizing), the backend handles these tasks asynchronously to ensure the UI remains responsive.



---

## 📝 Task 1 Reflection: Technical Deep-Dive

During the development of Task 1, I gained significant insights into the future of LLM orchestration:

### 1. Beyond Linear Chains
I learned that traditional "chains" are too rigid for real-world healthcare data. By using **LangGraph**, I implemented a **cyclic graph**. If the *Data Formatter* tool produces an error or incomplete data, the graph can "loop" back to the LLM to ask for clarification instead of failing.

### 2. State Management
I understood how to define a `TypedDict` state. This acts as the "short-term memory" for the agent. In this project, it specifically tracks which HCP is being discussed, ensuring that the *Sentiment Analysis* and *Follow-up Scheduler* are always working with the correct context.

### 3. Tool Choice Logic
I realized the importance of "Prompt Engineering" for tool definitions. The LLM needs precise descriptions for each tool to decide whether it should search for an old log or generate a new report.

---

## 📂 Installation & Setup

### Backend
1. Navigate to the folder: `cd backend`
2. Install dependencies: `pip install -r requirements.txt`
3. Configure environment: Create a `.env` file with your  `GOOGLE_API_KEY`.
4. Start the server: `python main.py`

### Frontend
1. Navigate to the folder: `cd frontend`
2. Install packages: `npm install`
3. Launch application: `npm start`
