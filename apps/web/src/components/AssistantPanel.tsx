import { MessageSquare, Send, Sparkles, X } from "lucide-react";
import { assistantMessages } from "../data/quran";
import { BrandMark } from "./BrandMark";

export function AssistantPanel() {
  return (
    <aside className="assistant-panel" aria-label="Ask Quran AI">
      <div className="assistant-header">
        <MessageSquare size={20} />
        <h2>Ask Quran AI</h2>
        <button aria-label="Close assistant" type="button">
          <X size={18} />
        </button>
      </div>

      <div className="messages">
        {assistantMessages.map((message) => (
          <div className={`message ${message.from}`} key={message.id}>
            {message.from === "assistant" ? <BrandMark /> : null}
            <p>{message.body}</p>
          </div>
        ))}
      </div>

      <div className="suggestions">
        <button type="button"><Sparkles size={14} /> Explain ghunnah</button>
        <button type="button"><Sparkles size={14} /> More examples</button>
        <button type="button"><Sparkles size={14} /> Common mistakes in Al-Fatihah</button>
      </div>

      <form className="assistant-form">
        <label htmlFor="assistant-input" className="sr-only">Ask Quran AI</label>
        <input id="assistant-input" placeholder="Ask anything..." />
        <button aria-label="Send question" type="submit">
          <Send size={19} fill="currentColor" />
        </button>
      </form>
    </aside>
  );
}
