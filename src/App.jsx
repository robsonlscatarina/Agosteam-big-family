import { useState, useRef, useEffect } from "react";

// ─── CONTEXTO DO PRODUTO ────────────────────────────────────────────────────
// No Claude.ai: contexto embutido aqui mesmo.
// No Vercel: substituir por import.meta.env.VITE_PRODUCT_CONTEXT
const PLATFORM_CONTEXT = import.meta.env.VITE_PRODUCT_CONTEXT || "";

const TEAM = {
  coach:    { id:"coach",    name:"Lineu",       role:"Coach de PM",          color:"#6EE7B7", bg:"#064E3B", emoji:"🎯", desc:"PM sênior. Estratégia, JTBD, OST, RICE. Questiona o 'por quê'." },
  designer: { id:"designer", name:"Beicola",     role:"Product Designer",     color:"#C4B5FD", bg:"#4C1D95", emoji:"🎨", desc:"UX/Service Design. Jornada do associado, momentos de verdade." },
  analyst:  { id:"analyst",  name:"Tuco",        role:"Analista de Negócios", color:"#FCD34D", bg:"#78350F", emoji:"📊", desc:"Financeiro/cooperativismo. ROI, viabilidade, regulatório, benchmarks." },
  techlead: { id:"techlead", name:"Bebel",       role:"Tech Lead",             color:"#67E8F9", bg:"#164E63", emoji:"⚙️", desc:"Arquitetura financeira/APIs. Viabilidade técnica, legado, escalabilidade." },
  qa:       { id:"qa",       name:"Agostinho",   role:"QA Engineer",           color:"#FCA5A5", bg:"#7F1D1D", emoji:"🔍", desc:"Qualidade e risco. Edge cases, critérios aceite, consistência." }
};

// ── OTIMIZAÇÃO 3: Haiku — modelo mais barato ────────────────────────────────
const MODEL = "claude-haiku-4-5-20251001";

// ── TOKENS AUMENTADOS PARA MELHOR QUALIDADE ──────────────────────────────────
const TOKENS_SYNTHESIS = 1500;
const TOKENS_DEBATE    = 1500;

// ── SYSTEM PROMPTS separados por chamada ────────────────────────────────────
const SYNTHESIS_PROMPT = `${PLATFORM_CONTEXT}

MEMBROS: ${Object.values(TEAM).map(m=>`${m.name}(${m.id}):${m.desc}`).join(' | ')}

TAREFA: Selecione 2-3 membros mais relevantes para o input. Lineu(coach) sempre encerra.
SELEÇÃO: técnica→techlead; UX→designer; negócio→analyst; risco→qa; estratégia ampla→coach+analyst+1.

FORMATO JSON puro:
{"selected_members":["id1","id2"],"synthesis":"síntese aprofundada com conclusão e recomendação","questions":["q1","q2"]}

Português brasileiro. JSON válido, sem markdown.`;

const DEBATE_PROMPT = `${PLATFORM_CONTEXT}

MEMBROS: ${Object.values(TEAM).map(m=>`${m.name}(${m.id}):${m.desc}`).join(' | ')}

TAREFA: Gere o debate entre os membros listados em selected_members sobre o tema fornecido.
Cada membro: raciocínio aprofundado com sua perspectiva específica. Lineu encerra com direcionamento.

FORMATO JSON puro:
{"debate":[{"member":"id","message":"fala do membro"}]}

Português brasileiro. JSON válido, sem markdown.`;

// ── HISTÓRICO COMO RESUMO ROLANTE (máx. 6 trocas) ───────────────────────────
const MAX_HISTORY = 6;

function buildHistory(messages) {
  const exchanges = messages.filter(m => m.role);
  if (exchanges.length <= MAX_HISTORY) return exchanges.map(m => ({ role: m.role, content: m.content }));

  // Comprime os mais antigos em um resumo e mantém os últimos MAX_HISTORY
  const old = exchanges.slice(0, exchanges.length - MAX_HISTORY);
  const recent = exchanges.slice(exchanges.length - MAX_HISTORY);

  const summaryLines = old
    .filter(m => m.role === "user")
    .map(m => `- ${m.content.slice(0, 120)}`).join("\n");

  return [
    { role: "user", content: `[RESUMO TÓPICOS ANTERIORES]\n${summaryLines}\n[FIM DO RESUMO]` },
    { role: "assistant", content: "Entendido. Continuando." },
    ...recent.map(m => ({ role: m.role, content: m.content }))
  ];

}

// ── RETRY COM BACKOFF EXPONENCIAL — até 3 tentativas ────────────────────────
// Aguarda antes de tentar novamente: 2s → 4s → 8s
// Funciona para qualquer erro de API (529, 500, 503, timeout, etc.)
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function callAPIWithRetry(systemPrompt, messages, maxTokens, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_BASE = 2000; // 2 segundos base


  const apiKey = (() => {
    try { return import.meta.env?.VITE_ANTHROPIC_API_KEY || ""; }
    catch { return ""; }
  })();

  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (apiKey) headers["x-api-key"] = apiKey;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: systemPrompt, messages })
    });

    // Erros HTTP (529 overload, 500, 503, etc.) — tenta novamente
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const errMsg = errBody?.error?.message || `HTTP ${response.status}`;
      console.warn(`[Agosteam] Tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${errMsg}`);

      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_BASE * Math.pow(2, attempt - 1)); // 2s, 4s, 8s
        return callAPIWithRetry(systemPrompt, messages, maxTokens, attempt + 1);
      }
      throw new Error(`API falhou após ${MAX_ATTEMPTS} tentativas: ${errMsg}`);
    }

    const data = await response.json();
    const raw = data.content?.map(i => i.text || "").join("") || "";
    try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { return null; }

  } catch (err) {
    // Erros de rede (timeout, conexão) — tenta novamente
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[Agosteam] Tentativa ${attempt}/${MAX_ATTEMPTS} erro de rede: ${err.message}`);
      await sleep(BACKOFF_BASE * Math.pow(2, attempt - 1));
      return callAPIWithRetry(systemPrompt, messages, maxTokens, attempt + 1);
    }
    throw err;
  }

}


export default function Agosteam() {
  const [messages, setMessages]             = useState([]);
  const [input, setInput]                   = useState("");
  const [loading, setLoading]               = useState(false);
  const [loadingDebate, setLoadingDebate]   = useState({});
  const [retryInfo, setRetryInfo]           = useState({}); // rastreia tentativas visíveis ao usuário
  const [expandedDebate, setExpandedDebate] = useState({});
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // ── CHAMADA PRINCIPAL: síntese com retry ────────────────────────────────────
  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setLoading(true);
    setRetryInfo(prev => ({ ...prev, synthesis: null }));

    const newUserMsg = { type: "user", content: userMsg, role: "user" };
    setMessages(prev => [...prev, newUserMsg]);

    const history = buildHistory([...messages, newUserMsg]);
    // Avisa o usuário se estiver retentando
    const onRetry = (attempt) => {
      setRetryInfo(prev => ({ ...prev, synthesis: attempt }));
    };


    try {
      // Wrapper para expor tentativas ao usuário
      let attempt = 1;
      const parsed = await (async () => {
        while (attempt <= 3) {
          try {
            return await callAPIWithRetry(SYNTHESIS_PROMPT, history, TOKENS_SYNTHESIS, attempt);
          } catch (err) {
            if (attempt === 3) throw err;
            attempt++;
            onRetry(attempt);
            await sleep(2000 * Math.pow(2, attempt - 2));
          }
        }
      })();

      const id = Date.now();
      setMessages(prev => [...prev, {
        type: "team", id, role: "assistant",
        content: JSON.stringify(parsed),
        synthesis: parsed?.synthesis || "Erro ao processar resposta.",
        questions: parsed?.questions || [],
        selected_members: parsed?.selected_members || [],
        debate: null // debate ainda não gerado
      }]);
    } catch {
      setMessages(prev => [...prev, {
        type: "error",
        content: "Deu ruim, mals aí. :(  Não foi possível conectar após 3 tentativas. Verifica a conexão e tenta novamente."
      }]);
    }
    setLoading(false);
  };

  // ── CHAMADA SOB DEMANDA: somente ao clicar "Ver debate" ────────────────────
  const fetchDebate = async (msgId, selectedMembers, topic) => {
    setLoadingDebate(prev => ({ ...prev, [msgId]: { loading: true, attempt: 1 } }));
    try {
      let attempt = 1;
      const parsed = await (async () => {
        while (attempt <= 3) {
          try {
            const result = await callAPIWithRetry(DEBATE_PROMPT, [{
              role: "user",
              content: `Tema: ${topic}\nMembros selecionados: ${selectedMembers.join(", ")}`
            }], TOKENS_DEBATE, attempt);
            return result;
          } catch (err) {
            if (attempt === 3) throw err;
            attempt++;
            setLoadingDebate(prev => ({ ...prev, [msgId]: { loading: true, attempt } }));
            await sleep(2000 * Math.pow(2, attempt - 2));
          }
        }
      })();


      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, debate: Array.isArray(parsed?.debate) ? parsed.debate : [] } : m
      ));
      setExpandedDebate(prev => ({ ...prev, [msgId]: true }));
    } catch (err) {
      console.error("fetchDebate falhou após 3 tentativas:", err);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, debate: [] } : m
      ));
    }
    setLoadingDebate(prev => ({ ...prev, [msgId]: { loading: false, attempt: 1 } }));
  };

  const toggleDebate = (msg) => {
    if (expandedDebate[msg.id]) {
      setExpandedDebate(prev => ({ ...prev, [msg.id]: false }));
      return;
    }
    if (msg.debate !== null) {
      setExpandedDebate(prev => ({ ...prev, [msg.id]: true }));
      return;
    }
    // Primeira vez: buscar da API
    // Encontra a mensagem do usuário imediatamente anterior a este bloco do time
    const teamIdx = messages.findIndex(m => m.type === "team" && m.id === msg.id);
    const userMsg = teamIdx > 0
      ? [...messages].slice(0, teamIdx).reverse().find(m => m.type === "user")
      : null;
    const topic = userMsg?.content || "tópico anterior";
    fetchDebate(msg.id, msg.selected_members, topic);
  };

  const S = {
    root: { minHeight:"100vh", background:"#0A0F1E", fontFamily:"'IBM Plex Mono','Courier New',monospace", display:"flex", flexDirection:"column", color:"#E2E8F0" },
    header: { borderBottom:"1px solid #1E293B", padding:"16px 24px", background:"linear-gradient(135deg,#0F172A,#0A0F1E)", display:"flex", alignItems:"center", gap:16, flexShrink:0 },
    headerIcon: { width:40, height:40, background:"linear-gradient(135deg,#6EE7B7,#3B82F6)", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 },
    feed: { flex:1, overflowY:"auto", padding:"24px", display:"flex", flexDirection:"column", gap:20 },
    userBubble: { maxWidth:"65%", background:"linear-gradient(135deg,#1E3A5F,#1E293B)", border:"1px solid #2D4A6E", borderRadius:"16px 16px 4px 16px", padding:"12px 16px", fontSize:13, lineHeight:1.7, color:"#CBD5E1" },
    synthBox: { background:"linear-gradient(135deg,#0F2027,#0F172A)", border:"1px solid #1E3A5F", borderRadius:14, padding:"18px 20px", position:"relative" },
    pill: (color) => ({ position:"absolute", top:-11, left:20, background:"#0A0F1E", padding:"2px 10px", fontSize:10, color, letterSpacing:"0.15em", border:"1px solid #1E3A5F", borderRadius:20 }),
    toggleBtn: (accent) => ({ background:"transparent", border:`1px solid ${accent||"#1E293B"}`, borderRadius:8, padding:"8px 14px", color:accent||"#64748B", fontSize:11, cursor:"pointer", letterSpacing:"0.08em", display:"flex", alignItems:"center", gap:8, width:"fit-content", transition:"all 0.2s" }),
    memberAvatar: (m) => ({ width:32, height:32, flexShrink:0, background:m.bg, borderRadius:"50%", border:`2px solid ${m.color}40`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, marginTop:4 }),
    memberBubble: (m) => ({ flex:1, background:"#0F172A", border:`1px solid ${m.color}20`, borderRadius:"4px 12px 12px 12px", padding:"12px 14px" }),
    qBox: { background:"#0F0F1E", border:"1px solid #312E81", borderRadius:12, padding:"16px 18px" },
    inputArea: { borderTop:"1px solid #1E293B", padding:"14px 20px", background:"#0A0F1E", display:"flex", gap:10, alignItems:"flex-end", flexShrink:0 },
    inputWrap: { flex:1, background:"#0F172A", border:"1px solid #1E293B", borderRadius:12, display:"flex", alignItems:"flex-end", padding:"10px 14px" },
    sendBtn: (disabled) => ({ width:42, height:42, background:disabled?"#1E293B":"linear-gradient(135deg,#6EE7B7,#3B82F6)", border:"none", borderRadius:10, cursor:disabled?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, flexShrink:0, transition:"all 0.2s" })
  };

  return (
    <div style={S.root}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerIcon}>⚡</div>
        <div>
          <div style={{ fontSize:14, fontWeight:700, letterSpacing:"0.05em", color:"#F1F5F9" }}>AGOSTEAM</div>
          <div style={{ fontSize:10, color:"#64748B", letterSpacing:"0.08em", marginTop:2 }}>Meu produto digital :D {Object.keys(TEAM).length} MEMBROS</div>
        </div>
        <div style={{ marginLeft:"auto", display:"flex", gap:6 }}>
          {Object.values(TEAM).map(m => (
            <div key={m.id} title={`${m.name} · ${m.role}`} style={{ width:30, height:30, background:m.bg, borderRadius:"50%", border:`2px solid ${m.color}30`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13 }}>{m.emoji}</div>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div style={S.feed}>
        {messages.length === 0 && (
          <div style={{ textAlign:"center", padding:"50px 20px" }}>
            <div style={{ fontSize:42, marginBottom:14 }}>🏛️</div>
            <div style={{ fontSize:13, color:"#475569", lineHeight:1.8, maxWidth:440, margin:"0 auto" }}>
              O Agosteam está pronto. Descreva um problema, hipótese ou decisão. O Lineuzinho ta se coçando pra te criticar...<br/>
              <span style={{ fontSize:11, color:"#334155" }}>O time seleciona quem é mais relevante para cada questão.</span>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:8, justifyContent:"center", marginTop:20 }}>
              {["Como melhorar a jornada operacional?","Como medir melhor o uso do meu produto?","Quais melhorar as metricas atuais?"].map(s => (
                <button key={s} onClick={() => setInput(s)}
                  style={{ background:"#0F172A", border:"1px solid #1E293B", color:"#94A3B8", borderRadius:20, padding:"7px 14px", fontSize:11, cursor:"pointer" }}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor="#6EE7B7";e.currentTarget.style.color="#6EE7B7"}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor="#1E293B";e.currentTarget.style.color="#94A3B8"}}
                >{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, idx) => {
          if (msg.type === "user") return (
            <div key={idx} style={{ display:"flex", justifyContent:"flex-end" }}>
              <div style={S.userBubble}>
                <div style={{ fontSize:10, color:"#64748B", marginBottom:5, letterSpacing:"0.1em" }}>VOCÊ</div>
                {msg.content}
              </div>
            </div>
          );

          if (msg.type === "error") return (
            <div key={idx} style={{ background:"#1C0A0A", border:"1px solid #7F1D1D", borderRadius:10, padding:"12px 16px", color:"#FCA5A5", fontSize:13 }}>{msg.content}</div>
          );

          if (msg.type === "team") {
            const isOpen = expandedDebate[msg.id];
            const debateState = loadingDebate[msg.id] || { loading: false, attempt: 1 };
            const isLoadingDebate = debateState.loading;
            const debateAttempt = debateState.attempt;
            const activeMembers = (msg.selected_members||[]).map(id => TEAM[id]).filter(Boolean);
            const debateReady = msg.debate !== null;

            return (
              <div key={idx} style={{ display:"flex", flexDirection:"column", gap:12 }}>

                {/* Membros acionados */}
                {activeMembers.length > 0 && (
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                    <span style={{ fontSize:10, color:"#475569", letterSpacing:"0.1em" }}>ACIONADOS:</span>
                    {activeMembers.map(m => (
                      <div key={m.id} style={{ display:"flex", alignItems:"center", gap:5, background:m.bg, border:`1px solid ${m.color}30`, borderRadius:20, padding:"3px 10px" }}>
                        <span style={{ fontSize:11 }}>{m.emoji}</span>
                        <span style={{ fontSize:10, color:m.color, letterSpacing:"0.08em" }}>{m.name}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Síntese */}
                <div style={S.synthBox}>
                  <div style={S.pill("#6EE7B7")}>RESPOSTA CURTA E GROSSA</div>
                  <p style={{ fontSize:13, lineHeight:1.8, color:"#CBD5E1", margin:0 }}>{msg.synthesis}</p>
                </div>

                {/* Botão debate */}
                <button
                  onClick={() => toggleDebate(msg)}
                  disabled={isLoadingDebate}
                  style={S.toggleBtn(isLoadingDebate ? "#334155" : undefined)}
                >
                  {isLoadingDebate ? (
                    <>
                      <span style={{ animation:"spin 1s linear infinite", display:"inline-block" }}>⟳</span>
                      {debateAttempt > 1
                        ? `TENTATIVA ${debateAttempt}/3...`
                        : "CARREGANDO DEBATE..."}
                    </>
                  ) : (
                    <>
                      <span>{isOpen ? "▾" : "▸"}</span>
                      {!debateReady ? "PEDIR DEBATE AO TIME" : isOpen ? "OCULTAR DEBATE" : `VER DEBATE (${msg.debate?.length||0} falas)`}
                    </>
                  )}
                </button>

                {/* Debate renderizado */}
                {isOpen && (
                  <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    {!debateReady ? (
                      <div style={{ fontSize:12, color:"#475569", padding:"10px 14px", background:"#0F172A", borderRadius:10, border:"1px solid #1E293B" }}>
                        Nenhuma fala gerada. Tente pedir o debate novamente.
                      </div>
                    ) : (msg.debate||[]).length === 0 ? (
                      <div style={{ fontSize:12, color:"#475569", padding:"10px 14px", background:"#0F172A", borderRadius:10, border:"1px solid #1E293B" }}>
                        O time não retornou falas. Tente novamente.
                      </div>
                    ) : (msg.debate||[]).map((d, di) => {
                      // Busca o membro pelo id exato ou pelo name como fallback
                      const member = TEAM[d.member]
                        || Object.values(TEAM).find(m => m.name?.toLowerCase() === d.member?.toLowerCase())
                        || Object.values(TEAM)[di % Object.values(TEAM).length];
                      return (
                        <div key={di} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                          <div style={S.memberAvatar(member)}>{member.emoji}</div>
                          <div style={S.memberBubble(member)}>
                            <div style={{ fontSize:10, color:member.color, letterSpacing:"0.12em", marginBottom:6, fontWeight:700 }}>{member.name} · {member.role}</div>
                            <p style={{ fontSize:12.5, lineHeight:1.75, color:"#94A3B8", margin:0 }}>{d.message}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Perguntas */}
                {msg.questions?.length > 0 && (
                  <div style={S.qBox}>
                    <div style={{ fontSize:10, color:"#818CF8", letterSpacing:"0.15em", marginBottom:12, fontWeight:700 }}>❓ PERGUNTAS DO LINEU</div>
                    {msg.questions.map((q, qi) => (
                      <div key={qi} style={{ display:"flex", gap:10, alignItems:"flex-start", marginBottom: qi < msg.questions.length-1 ? 10 : 0 }}>
                        <div style={{ width:20, height:20, flexShrink:0, background:"#1E1B4B", borderRadius:"50%", border:"1px solid #4338CA", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:"#818CF8", fontWeight:700, marginTop:2 }}>{qi+1}</div>
                        <p style={{ fontSize:12.5, lineHeight:1.7, color:"#A5B4FC", margin:0, cursor:"pointer" }}
                          onClick={() => setInput(q)} title="Clique para usar">{q}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return null;
        })}
        {/* Loading síntese com indicador de retry */}
        {loading && (
          <div style={{ display:"flex", gap:10, alignItems:"center", padding:"6px 0" }}>
            <div style={{ width:32, height:32, background:"#0F172A", border:"1px solid #1E293B", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:14 }}>💬</div>
            <div style={{ background:"#0F172A", border:"1px solid #1E293B", borderRadius:"4px 12px 12px 12px", padding:"12px 18px", display:"flex", gap:5, alignItems:"center" }}>
              {[0,1,2].map(i => <div key={i} style={{ width:5, height:5, background:"#475569", borderRadius:"50%", animation:"pulse 1.4s ease-in-out infinite", animationDelay:`${i*0.2}s` }} />)}
              <span style={{ fontSize:10, color:"#475569", marginLeft:8, letterSpacing:"0.08em" }}>
                {retryInfo.synthesis
                  ? `tentativa ${retryInfo.synthesis}/3...`
                  : "analisando..."}
              </span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={S.inputArea}>
        <div style={S.inputWrap}>
          <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Descreva um problema, hipótese ou decisão..." rows={2}
            style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#CBD5E1", fontSize:13, lineHeight:1.7, resize:"none", fontFamily:"inherit" }} />
        </div>
        <button onClick={sendMessage} disabled={loading||!input.trim()} style={S.sendBtn(loading||!input.trim())}>↑</button>
      </div>

      <style>{`
        @keyframes pulse{0%,80%,100%{opacity:.3;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#1E293B;border-radius:2px}
        textarea::placeholder{color:#334155}
      `}</style>
    </div>
  );
  }
                    
