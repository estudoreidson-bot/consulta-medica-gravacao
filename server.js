// server.js
// Backend em Node/Express para gerar SOAP e prescrição usando a API da OpenAI,
// SEM inventar dados que não estejam na transcrição.

const express = require("express");
const cors   = require("cors");
const path   = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(cors());
app.use(express.json());

// opcional: servir arquivos estáticos (se você abrir direto o Render no navegador)
app.use(express.static(path.join(__dirname)));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/gerar-soap", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Variável de ambiente OPENAI_API_KEY não configurada no servidor."
      });
    }

    const { transcricao } = req.body || {};
    if (!transcricao || typeof transcricao !== "string" || !transcricao.trim()) {
      return res.status(400).json({ error: "Campo 'transcricao' é obrigatório." });
    }

    const systemMessage = `
Você é um médico experiente em Clínica Médica e Medicina de Família no Brasil.

TAREFA:
A partir da TRANSCRIÇÃO literal de uma consulta, você deve produzir:

1) RESUMO CLÍNICO EM FORMATO SOAP, em português:
   S: ...
   O: ...
   A: ...
   P: ...

2) PRESCRIÇÃO MÉDICA em texto simples, adequada para impressão:
   - Nome do medicamento
   - Dose
   - Via
   - Frequência
   - Duração

REGRAS DE OURO (MUITO IMPORTANTES):
1. NÃO PODE INVENTAR NENHUM DADO.
   - Use APENAS informações explicitamente presentes na transcrição.
   - NÃO descreva sinais de desidratação, exame abdominal, ausculta, PA, FC,
     temperatura, etc., se isso NÃO foi mencionado explicitamente.
   - NÃO escreva "abdome distendido", "sinais de desidratação", "linfonodos palpáveis"
     ou qualquer outro achado que NÃO esteja escrito na transcrição.

2. DADO AUSENTE = "NÃO INFORMADO".
   - Se a transcrição não falar nada sobre algum item importante
     (por exemplo, exame físico, sinais vitais, exame abdominal),
     escreva claramente "não informado" ou "não referido" em vez de inventar.
   - Exemplo:
       O: Exame físico não informado.
       O: Abdome não referido. Dor abdominal não referida.
     (somente se a transcrição realmente não trouxer esses dados).

3. NÃO INTERPRETAR ALÉM DO QUE FOI DITO.
   - Você pode organizar e resumir, mas não pode criar diagnósticos ou achados novos
     baseados em suposições.
   - Se o quadro for "sugestivo de virose", isso só pode aparecer se a transcrição
     tiver alguma fala nesse sentido (por exemplo, o médico comentando isso).

4. LINGUAGEM OBJETIVA, SEM EMOJIS.
   - Estilo de prontuário médico, direto e sem floreios.

FORMATO DE RESPOSTA (OBRIGATÓRIO):
Responda EXATAMENTE neste JSON, sem comentários extras:
{
  "soap": "texto do SOAP completo",
  "prescricao": "texto da prescrição completa"
}
`;

    const userMessage = `TRANSCRIÇÃO LITERAL DA CONSULTA (não invente nada além do que está abaixo):\n\n${transcricao}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemMessage },
          { role: "user",  content: userMessage }
        ],
        temperature: 0.05,   // bem baixo para reduzir ainda mais "criatividade"
        max_tokens: 800,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      console.error("Erro da OpenAI:", response.status, bodyText);
      return res.status(500).json({ error: "Erro ao chamar a API da OpenAI." });
    }

    const data   = await response.json();
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message || !choice.message.content) {
      return res.status(500).json({ error: "Resposta inesperada da OpenAI." });
    }

    let parsed;
    try {
      parsed = JSON.parse(choice.message.content);
    } catch (e) {
      console.error("Erro ao parsear JSON da OpenAI:", e);
      return res.status(500).json({ error: "Falha ao interpretar a resposta da OpenAI." });
    }

    const soap       = typeof parsed.soap === "string" ? parsed.soap : "";
    const prescricao = typeof parsed.prescricao === "string" ? parsed.prescricao : "";

    return res.json({ soap, prescricao });
  } catch (err) {
    console.error("Erro interno no servidor:", err);
    return res.status(500).json({ error: "Erro interno no servidor." });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
