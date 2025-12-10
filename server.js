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

// ======================================================================
// ROTA 1 – GERAR SOAP E PRESCRIÇÃO A PARTIR DA TRANSCRIÇÃO
// ======================================================================

app.post("/api/gerar-soap", async (req, res) => {
  try {
    const { transcricao } = req.body || {};

    if (!transcricao || !transcricao.trim()) {
      return res.status(400).json({
        error: "O campo 'transcricao' é obrigatório.",
      });
    }

    const prompt = `
Você é um médico que está recebendo a transcrição de uma consulta em português do Brasil.

A partir da transcrição abaixo, gere obrigatoriamente um JSON no formato exato:

{
  "soap": "Texto do resumo no formato SOAP (S:, O:, A:, P:), bem escrito em português do Brasil.",
  "prescricao": "Texto da prescrição médica em português, com posologia detalhada. Não inclua imagens."
}

Requisitos específicos do SOAP:

1) Estrutura obrigatória em quatro seções, na ordem:
   S: ...
   O: ...
   A: ...
   P: ...

2) Campo O (Objetivo):
   - Se a consulta envolver discussão de exames laboratoriais, exames de imagem ou outros exames complementares, você deve registrar TODOS os exames mencionados, inclusive os que estiverem normais.
   - Para cada exame citado na transcrição, escreva:
     • Nome do exame
     • Valor ou resultado
     • Interpretação breve (normal, baixo, alto, limítrofe, etc.)
   - Exemplos de formatação no campo O:
     - "Hemograma completo: normal."
     - "Ferritina: 10 ng/mL (baixo)."
     - "Vitamina D: 18,8 ng/mL (baixo)."
     - "Vitamina B12: 230 pg/mL (limítrofe)."
   - Nunca invente exames ou valores. Apenas use aqueles que forem explicitamente mencionados na transcrição.

3) Campo P (Plano):
   - Deve conter tanto o plano farmacológico quanto o plano não farmacológico.
   - Ao final do campo P, inclua SEMPRE um subbloco com o rótulo exato:
     "Tratamento não farmacológico / Orientações:"
   - Nesse subbloco, descreva as orientações de medidas não medicamentosas discutidas ou recomendáveis para o caso (por exemplo: alimentação, atividade física, higiene do sono, redução de álcool/tabaco, medidas de autocuidado, etc.).
   - Se a transcrição não mencionar nenhuma orientação específica, ainda assim mantenha o rótulo e escreva uma frase simples, por exemplo:
     "Tratamento não farmacológico / Orientações: orientações gerais de saúde, sem recomendações específicas adicionais registradas na consulta."
   - O campo P deve ficar com um texto contínuo, por exemplo:
     P: Plano farmacológico, ajustes de medicação, exames a solicitar, etc.
     Tratamento não farmacológico / Orientações: descrição das orientações não medicamentosas.

Regras gerais:
- Escreva tudo em português do Brasil.
- Não explique o que está fazendo.
- Não use formatação em Markdown; apenas texto simples.
- A saída deve ser apenas o JSON válido, nada antes ou depois.
- Não invente exames, queixas, diagnósticos ou condutas que não estejam apoiados na transcrição, mas organize e reformule com clareza o que foi dito.

TRANSCRIÇÃO DA CONSULTA:
"""${transcricao}"""
`;

    const raw = await callOpenAI(prompt);

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      const firstBrace = raw.indexOf("{");
      const lastBrace = raw.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonSlice = raw.slice(firstBrace, lastBrace + 1);
        data = JSON.parse(jsonSlice);
      } else {
        throw new Error("Resposta do modelo não pôde ser convertida em JSON.");
      }
    }

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
// ROTA 2 – RECOMENDAÇÕES DE PERGUNTAS COMPLEMENTARES (ANAMNESE)
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
Queixa principal: ${queixa_principal}
Histórico resumido: ${historico_resumido}
SOAP atual:
${soap}
`;

    const raw = await callOpenAI(prompt);

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      const firstBrace = raw.indexOf("{");
      const lastBrace = raw.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonSlice = raw.slice(firstBrace, lastBrace + 1);
        data = JSON.parse(jsonSlice);
      } else {
        throw new Error("Resposta do modelo não pôde ser convertida em JSON.");
      }
    }

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
// INICIALIZAÇÃO DO SERVIDOR
// ======================================================================

app.listen(port, () => {
  console.log(`Servidor escutando na porta ${port}`);
});
