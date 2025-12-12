// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

// Configurações básicas
app.use(cors());
app.use(bodyParser.json());

// Servir o index.html (útil para testes locais)
app.use(express.static(path.join(__dirname)));

// Cliente OpenAI usando a variável de ambiente do Render
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Função genérica para chamar o modelo e retornar o texto
async function callOpenAI(prompt) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content || "";
  return content.trim();
}

// Função para obter JSON do modelo com fallback (extrai o primeiro bloco {...})
async function callOpenAIJson(prompt) {
  const raw = await callOpenAI(prompt);

  try {
    return JSON.parse(raw);
  } catch (e) {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonSlice = raw.slice(firstBrace, lastBrace + 1);
      return JSON.parse(jsonSlice);
    }
    throw new Error("Resposta do modelo não pôde ser convertida em JSON.");
  }
}

// Pequena validação para limitar tamanho e evitar abusos
function normalizeText(input, maxLen) {
  const s = (typeof input === "string" ? input : "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function normalizeArrayOfStrings(arr, maxItems, maxLenEach) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    out.push(t.length > maxLenEach ? t.slice(0, maxLenEach) : t);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ======================================================================
// ROTA 1 – GERAR SOAP E PRESCRIÇÃO A PARTIR DA TRANSCRIÇÃO (EXISTENTE)
// ======================================================================

app.post("/api/gerar-soap", async (req, res) => {
  try {
    const { transcricao } = req.body || {};

    if (!transcricao || !transcricao.trim()) {
      return res.status(400).json({
        error: "O campo 'transcricao' é obrigatório.",
      });
    }

    const safeTranscricao = normalizeText(transcricao, 25000);

    const prompt = `
Você é um médico humano recebendo a transcrição integral de uma consulta em português do Brasil.  
Seu único usuário é sempre o MÉDICO HUMANO que está atendendo o paciente.

Na transcrição, o médico deve informar logo no início: NOME COMPLETO DO PACIENTE, IDADE e PESO  
(por exemplo: "Paciente: Maria de Souza Silva, 8 anos, 25 kg.").

A partir da transcrição abaixo, gere obrigatoriamente um JSON exatamente no formato:

{
  "soap": "Texto do resumo no formato SOAP (S:, O:, A:, P:), bem escrito em português do Brasil.",
  "prescricao": "Texto da prescrição médica em português, com posologia detalhada em formato tradicional para impressão."
}

REGRAS PARA O CAMPO "soap":
- Estruture o texto com os marcadores explícitos: "S:", "O:", "A:" e "P:".
- Cada letra deve iniciar um parágrafo ou linha separada.
- Escreva de forma clara, objetiva e clínica, em português do Brasil.

REGRAS PARA O CAMPO "prescricao":
- A prescrição deve ser escrita como uma prescrição tradicional, pronta para impressão.
- Use, sempre que possível, os dados informados na transcrição:
  - Nome completo do paciente
  - Idade (em anos)
  - Peso (em kg)
- NÃO invente dados.  
  - Se nome, idade ou peso não estiverem claramente ditos na transcrição:
    - Escreva "não informado" naquele campo específico.
- Estrutura obrigatória da prescrição (modelo textual a seguir, que você deve ADAPTAR ao caso; NÃO copie literalmente as medicações, apenas o formato):

Paciente: NOME COMPLETO DO PACIENTE
Idade: X anos    Peso: Y kg

1. [Nome do medicamento 1] – [dose, via, frequência, duração]
   Modo de usar: [modo de uso detalhado para o paciente]

2. [Nome do medicamento 2] – [dose, via, frequência, duração]
   Modo de usar: [modo de uso detalhado para o paciente]

(Repita a numeração para quantos medicamentos forem necessários.)

Orientações:
- [Orientação 1 importante para o paciente]
- [Orientação 2 importante para o paciente]
(Adapte a quantidade de orientações conforme o caso.)

____________________________________
Médico

OUTRAS REGRAS GERAIS:
- Escreva tudo em português do Brasil.
- A prescrição deve conter as medicações numeradas, forma de uso completa e orientações ao final.
- Não explique o que está fazendo.
- NÃO se apresente como IA, modelo de linguagem, algoritmo ou similares.
- A saída deve ser apenas o JSON, nada antes ou depois.

TRANSCRIÇÃO DA CONSULTA:
"""${safeTranscricao}"""
`;

    const data = await callOpenAIJson(prompt);

    const soap = data.soap || "";
    const prescricao = data.prescricao || "";

    return res.json({ soap, prescricao });
  } catch (err) {
    console.error("Erro em /api/gerar-soap:", err);
    return res.status(500).json({
      error: "Erro interno ao gerar SOAP e prescrição.",
    });
  }
});

// ======================================================================
// ROTA 2 – RECOMENDAÇÕES DE PERGUNTAS COMPLEMENTARES (ANAMNESE) (EXISTENTE)
// ======================================================================

app.post("/api/recomendacoes-anamnese", async (req, res) => {
  try {
    const {
      queixa_principal = "",
      historico_resumido = "",
      soap,
    } = req.body || {};

    if (!soap || !soap.trim()) {
      return res.status(400).json({
        error: "O campo 'soap' é obrigatório para gerar as recomendações.",
      });
    }

    const safeSoap = normalizeText(soap, 20000);
    const safeQueixa = normalizeText(queixa_principal, 2000);
    const safeHistorico = normalizeText(historico_resumido, 4000);

    const prompt = `
Seu único usuário é sempre o MÉDICO HUMANO que está atendendo o paciente.

CONTEXTO DO SISTEMA
- Este sistema já gerou automaticamente um SOAP inicial a partir da conversa entre médico e paciente.
- Agora o médico clicou no botão de RECOMENDAÇÕES.
- Quando esse botão é acionado, o sistema envia para você:
    • A queixa principal do paciente
    • O histórico resumido
    • O SOAP atual
- A sua função, neste fluxo, NÃO é atender o paciente. Você está exclusivamente orientando o médico a melhorar a anamnese.
- O conteúdo retornado será exibido em uma ABA LATERAL como perguntas essenciais.
- O médico poderá clicar em um botão “Fazer Perguntas” dentro dessa aba.  
  Se o médico clicar nesse botão, o sistema iniciará uma nova gravação e ele perguntará diretamente ao paciente as perguntas sugeridas.  
  As respostas obtidas serão usadas para REFAZER automaticamente o SOAP com maior precisão diagnóstica e terapêutica.

TAREFA
A partir da queixa principal, do histórico resumido e do SOAP atual:

1. Identifique apenas informações ESTRITAMENTE importantes que ainda precisam ser esclarecidas para:
   - Refinar o diagnóstico diferencial
   - Identificar sinais de gravidade/alarme
   - Avaliar fatores de risco, comorbidades e uso de medicamentos
   - Permitir uma conduta e prescrição mais precisa e segura

2. Gere uma lista de PERGUNTAS COMPLEMENTARES que o médico deve fazer ao paciente.
   As perguntas devem:
   - Ser curtas, claras e objetivas
   - Ser feitas diretamente ao paciente (“Você…?”)
   - Focar em:
       • início e duração dos sintomas  
       • características do sintoma principal  
       • fatores de melhora ou piora  
       • sinais de alarme relevantes ao caso  
       • comorbidades, medicamentos de uso contínuo e alergias  
       • antecedentes pessoais e familiares pertinentes  
       • hábitos de vida quando forem relevantes
   - Não incluir perguntas irrelevantes ou genéricas.  
   - Priorizar segurança clínica e precisão diagnóstica.

FORMATO DE SAÍDA
Responda SEM explicações. Apenas retorne no seguinte formato JSON:

{
  "perguntas": [
    "Pergunta 1 em frase direta ao paciente?",
    "Pergunta 2 em frase direta ao paciente?",
    "Pergunta 3 em frase direta ao paciente?"
  ]
}

IMPORTANTE
- Nunca se apresente como IA, modelo de linguagem, algoritmo, chatbot ou termos semelhantes.
- Escreva sempre em português do Brasil.
- O leitor da sua resposta é o MÉDICO HUMANO, mas as perguntas devem ser formuladas para ele fazer diretamente ao paciente.

DADOS RECEBIDOS DO SISTEMA
Queixa principal: ${safeQueixa}
Histórico resumido: ${safeHistorico}
SOAP atual:
${safeSoap}
`;

    const data = await callOpenAIJson(prompt);
    const perguntas = Array.isArray(data.perguntas) ? data.perguntas : [];

    return res.json({ perguntas });
  } catch (err) {
    console.error("Erro em /api/recomendacoes-anamnese:", err);
    return res.status(500).json({
      error: "Erro interno ao gerar recomendações de anamnese.",
    });
  }
});

// ======================================================================
// ROTA 3 – GERAR PRESCRIÇÃO HOSPITALAR A PARTIR DA TRANSCRIÇÃO (NOVA)
// ======================================================================

app.post("/api/prescricao-hospitalar", async (req, res) => {
  try {
    const { transcricao } = req.body || {};

    if (!transcricao || !transcricao.trim()) {
      return res.status(400).json({
        error: "O campo 'transcricao' é obrigatório.",
      });
    }

    const safeTranscricao = normalizeText(transcricao, 25000);

    const prompt = `
Você é um médico humano redigindo uma prescrição hospitalar em português do Brasil, para uso real em enfermaria ou UTI.
Seu único usuário é o MÉDICO HUMANO que está atendendo o paciente.

TAREFA
A partir da transcrição abaixo, gere obrigatoriamente um JSON exatamente no formato:

{
  "prescricao_hospitalar": "Texto final pronto para impressão e inserção em prontuário."
}

REGRAS
- Não invente dados ausentes. Se nome/idade/peso não estiverem claramente informados, use "não informado".
- Linguagem médica formal, sem emojis, sem ícones, sem linguagem informal.
- Organize a prescrição com as seções abaixo, nesta ordem, com títulos claros:

Paciente: [nome completo ou não informado]
Idade: [X anos ou não informado]    Peso: [Y kg ou não informado]

Medicamentos contínuos:
- [Medicamento] — Dose: [ ] | Via: [ ] | Frequência: [ ] | Observações: [ ]

Medicamentos se necessário:
- [Medicamento] — Dose: [ ] | Via: [ ] | Frequência: [ ] | Observações: [ ]

Dieta:
- [Item] — Dose: [ ] | Via: [ ] | Frequência: [ ] | Observações: [ ]
(Se não aplicável, escreva: "Não informado.")

Hidratação:
- [Item] — Dose: [ ] | Via: [ ] | Frequência: [ ] | Observações: [ ]
(Se não aplicável, escreva: "Não informado.")

Cuidados de enfermagem:
- [Item] — Dose: [ ] | Via: [ ] | Frequência: [ ] | Observações: [ ]
(Se não aplicável, escreva: "Não informado.")

Assinatura:
____________________________________
Médico

IMPORTANTE
- Não explique o que está fazendo.
- NÃO se apresente como IA, modelo de linguagem, algoritmo, chatbot ou similares.
- A saída deve ser apenas o JSON, nada antes ou depois.
- Se a transcrição não tiver dados suficientes para inferir algum item com segurança, prefira "Não informado" em vez de inventar.

TRANSCRIÇÃO:
"""${safeTranscricao}"""
`;

    const data = await callOpenAIJson(prompt);
    const prescricao_hospitalar = data.prescricao_hospitalar || "";

    return res.json({ prescricao_hospitalar });
  } catch (err) {
    console.error("Erro em /api/prescricao-hospitalar:", err);
    return res.status(500).json({
      error: "Erro interno ao gerar prescrição hospitalar.",
    });
  }
});

// ======================================================================
// ROTA 4 – CLASSIFICAR MEDICAMENTOS EM GESTAÇÃO E LACTAÇÃO (NOVA)
// ======================================================================

app.post("/api/classificar-gestacao-lactacao", async (req, res) => {
  try {
    const { medicamentos } = req.body || {};
    const meds = normalizeArrayOfStrings(medicamentos, 60, 120);

    if (!meds.length) {
      return res.json({
        gestacao: [],
        lactacao: [],
      });
    }

    const prompt = `
Você é um médico humano classificando medicamentos quanto ao uso na gestação e na lactação.
Seu único usuário é o MÉDICO HUMANO que está atendendo o paciente.

TAREFA
Receberá uma lista de medicamentos (nomes conforme prescritos). Para cada medicamento, devolva a classificação:
- Gestação: A, B, C, D, E, ou NA
- Lactação: A, B, C, D, E, ou NA

REGRAS IMPORTANTES
- Use apenas as categorias solicitadas: A, B, C, D, E ou NA.
- Se não for possível determinar com segurança, use NA e a descrição "categoria não informada (dados insuficientes)".
- A descrição deve ser curta e exatamente no padrão:
  - A: "uso sem risco"
  - B: "uso sem risco aparente"
  - C: "uso com risco/avaliar risco-benefício"
  - D: "uso com risco; evitar se possível"
  - E: "contraindicado/alto risco"
  - NA: "categoria não informada (dados insuficientes)"
- Não invente indicações, doses ou detalhes clínicos.
- Não se apresente como IA, modelo, algoritmo ou similares.
- Responda apenas com JSON válido no formato abaixo, sem texto extra.

FORMATO DE SAÍDA (JSON)
{
  "gestacao": [
    { "medicamento": "nome", "categoria": "A|B|C|D|E|NA", "descricao": "texto" }
  ],
  "lactacao": [
    { "medicamento": "nome", "categoria": "A|B|C|D|E|NA", "descricao": "texto" }
  ]
}

LISTA DE MEDICAMENTOS:
${meds.map((m, i) => `${i + 1}. ${m}`).join("\n")}
`;

    const data = await callOpenAIJson(prompt);

    const gestacao = Array.isArray(data.gestacao) ? data.gestacao : [];
    const lactacao = Array.isArray(data.lactacao) ? data.lactacao : [];

    // Normalização defensiva do retorno
    const normalizeItem = (it) => {
      const med = normalizeText(it?.medicamento, 120) || "não informado";
      const cat = normalizeText(it?.categoria, 2).toUpperCase();
      const ok = ["A", "B", "C", "D", "E", "NA"].includes(cat) ? cat : "NA";
      const desc = normalizeText(it?.descricao, 80) || "categoria não informada (dados insuficientes)";
      return { medicamento: med, categoria: ok, descricao: desc };
    };

    return res.json({
      gestacao: gestacao.map(normalizeItem),
      lactacao: lactacao.map(normalizeItem),
    });
  } catch (err) {
    console.error("Erro em /api/classificar-gestacao-lactacao:", err);
    return res.status(500).json({
      error: "Erro interno ao classificar medicamentos.",
    });
  }
});

// ======================================================================
// INICIALIZAÇÃO DO SERVIDOR
// ======================================================================

app.listen(port, () => {
  console.log(`Servidor escutando na porta ${port}`);
});
