import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import FIIsPage from './FIIsPage';
import FIIsTab from './FIIsTab';
import AdvisorChat from './AdvisorChat.jsx';
import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";
import { supabase, SUPABASE_URL, SUPABASE_KEY, getAuthToken, getUserId } from './supabaseClie
import { parseGorilaXlsx } from './gorilaParser';
import { parseMyProfitXlsx, detectSpreadsheetFormat } from './myProfitParser';
import { parseAssetAllocXlsx, isAssetAllocXlsx } from './assetAllocParser';
import { registerMontserrat } from './montserratFont';
import * as SunoImg from './sunoTemplateImages';
import { lookupTicker } from './tickerCatalog';
/* ═══ SUPABASE SYNC LAYER (auth-aware) ═══
- client_profiles is PER-USER (filtered by owner_id = auth.uid())
- app_data, macro_data, carteiras_data are SHARED (all consultants read/write the same id=
- fii_reports is handled by FIIsPage.jsx (shared, multi-row table)
*/
var PER_USER_TABLES = { client_profiles: true };
var _syncQueue = {};
var _syncTimer = null;
async function _buildHeaders(method) {
var token = await getAuthToken();
var headers = {
"apikey": SUPABASE_KEY,
"Authorization": "Bearer " + token
};
if (method !== "GET") {
headers["Content-Type"] = "application/json";
headers["Prefer"] = "return=minimal";
}
return headers;
}
async function supaFetch(table, method, body) {
var isPerUser = !!PER_USER_TABLES[table];
var headers = await _buildHeaders(method);
var uid = null;
if (isPerUser) {
uid = await getUserId();
if (!uid) {
// No session — do not attempt to hit the REST API for per-user tables.
if (method === "GET") return [];
return { ok: false, status: 401 };
}
}
if (method === "GET") {
var getUrl = isPerUser
? SUPABASE_URL + "/rest/v1/" + table + "?owner_id=eq." + uid + "&select=*"
: SUPABASE_URL + "/rest/v1/" + table + "?id=eq.main&select=*";
return fetch(getUrl, { headers: headers }).then(function(r){ return r.json(); });
}
if (isPerUser) {
// UPSERT by owner_id so the same code works for first write (INSERT) and subsequent writ
var upsertUrl = SUPABASE_URL + "/rest/v1/" + table + "?on_conflict=owner_id";
var upsertHeaders = Object.assign({}, headers, { "Prefer": "resolution=merge-duplicates,r
var upsertBody = Object.assign({ owner_id: uid }, body);
return fetch(upsertUrl, { method: "POST", headers: upsertHeaders, body: JSON.stringify(up
}
// Shared tables: patch the single id='main' row (keeping legacy behavior).
var patchUrl = SUPABASE_URL + "/rest/v1/" + table + "?id=eq.main";
return fetch(patchUrl, { method: "PATCH", headers: headers, body: JSON.stringify(body) });
}
// Debounced cloud save — batches rapid writes into one call per table
function syncToCloud(table, payload) {
_syncQueue[table] = payload;
if (_syncTimer) clearTimeout(_syncTimer);
_syncTimer = setTimeout(function() {
var queue = Object.assign({}, _syncQueue);
_syncQueue = {};
Object.keys(queue).forEach(function(t) {
supaFetch(t, "PATCH", queue[t]).then(function() {
console.log("[sync] saved " + t);
}).catch(function(err) {
console.error("[sync] error saving " + t + ":", err);
});
});
}, 1500);
}
// Load from cloud (returns null if no data or error)
async function loadFromCloud(table, field) {
try {
var rows = await supaFetch(table, "GET");
if (rows && rows.length > 0 && rows[0][field]) return rows[0][field];
} catch(err) { console.error("[sync] error loading " + table + ":", err); }
return null;
}
/* ═══ END SUPABASE SYNC ═══ */
/* ═══ CLIENT SNAPSHOTS CRUD ═══
A tabela client_snapshots guarda os snapshots temporais de cada cliente.
Diferente de client_profiles (blob único por consultor), snapshots são
linhas separadas — uma por tipo (inicial/alvo/atual) e por data.
Usa o Supabase client oficial (lib SDK), que cuida de auth e RLS.
*/
async function listClientSnapshots(clientProfileId) {
try {
var res = await supabase
.from("client_snapshots")
.select("*")
.eq("client_profile_id", clientProfileId)
.order("snapshot_date", { ascending: false });
if (res.error) { console.error("[snapshots] list error:", res.error); return []; }
return res.data || [];
} catch(err) { console.error("[snapshots] list exception:", err); return []; }
}
async function saveClientSnapshot(clientProfileId, tipo, snapshotData) {
// Insere novo snapshot. Para tipo 'atual', sempre cria nova linha (histórico).
// Para 'inicial' e 'alvo', upsert: um cliente tem só 1 inicial e 1 alvo vigente.
var uid = await getUserId();
if (!uid) throw new Error("Não autenticado");
var snapDate = snapshotData.snapshot_date || new Date().toISOString().slice(0,10);
var payload = {
owner_id: uid,
client_profile_id: clientProfileId,
tipo: tipo,
snapshot_date: snapDate,
data: snapshotData
};
if (tipo === "inicial" || tipo === "alvo") {
// Remove qualquer linha anterior do mesmo tipo pra este cliente
await supabase.from("client_snapshots").delete().eq("client_profile_id", clientProfileId)
}
var res = await supabase.from("client_snapshots").insert(payload).select().single();
if (res.error) throw new Error(res.error.message);
return res.data;
}
async function deleteClientSnapshot(snapshotId) {
var res = await supabase.from("client_snapshots").delete().eq("id", snapshotId);
if (res.error) throw new Error(res.error.message);
return true;
}
// Constrói snapshot 'inicial' a partir da alocação ATUAL extraída do Journey Book.
// O JB captura a posição que o cliente tinha no momento da emissão — essa vira o marco zero.
// Retorna o objeto `data` pronto pra persistir (sem salvar ainda).
function buildInicialFromJB(jbData) {
if (!jbData) return null;
// Macro: usa currentPercent de cada classe (o que o cliente tinha quando o JB foi emitido)
var alocacao = {
renda_fixa: acoes_br: fiis: { pct: 0, valor: 0 },
{ pct: 0, valor: 0 },
{ pct: 0, valor: 0 },
internacional: { pct: 0, valor: 0 },
alternativos: { pct: 0, valor: 0 },
caixa: { pct: 0, valor: 0 }
};
if (jbData.allocationMacro && Array.isArray(jbData.allocationMacro.classes)) {
jbData.allocationMacro.classes.forEach(function(c){
var slug = normalizeJBClasseName(c.name);
if (slug && alocacao[slug] && typeof c.currentPercent === "number") {
alocacao[slug].pct += c.currentPercent;
alocacao[slug].valor += (c.currentValue || 0);
}
});
}
// Patrimônio total: soma dos valores das classes, fallback pro campo de info do cliente
var patr = 0;
Object.keys(alocacao).forEach(function(k){ patr += alocacao[k].valor || 0; });
if (patr === 0 && jbData.clientInfo && jbData.clientInfo.patrimony) {
patr = jbData.clientInfo.patrimony;
}
// Ativos: usa currentPortfolio do JB (o que o cliente possuía)
var ativos = [];
if (Array.isArray(jbData.currentPortfolio)) {
jbData.currentPortfolio.forEach(function(a){
if (!a || !a.ticker) return;
var tk = String(a.ticker).toUpperCase().trim();
if (!tk) return;
var meta = lookupTicker(tk);
var classe = meta ? meta.classe : normalizeJBClasseName(a.class);
var subclasse = meta ? meta.subclasse : null;
ativos.push({
id: tk,
ticker: tk,
nome_original: a.name || tk,
classe: classe,
subclasse: subclasse,
setor: meta ? meta.setor : null,
segmento: meta ? meta.segmento : null,
intl: meta ? meta.intl : false,
classificacao_fonte: meta ? "catalog" : "jb",
precisa_revisao: !meta,
valor: a.value || 0,
pct_total: typeof a.percentPortfolio === "number" ? a.percentPortfolio : 0,
pct_classe: 0,
corretoras: [],
carteiras_suno: [],
status_recomendacao: "manter",
});
});
}
return {
version: 1,
tipo: "inicial",
snapshot_date: (function(){
// Usa a data do JB se disponível, senão data atual
if (jbData.jbDate) return jbData.jbDate;
return new Date().toISOString().slice(0,10);
})(),
origem: "jb_initial",
patrimonio_total: +patr.toFixed(2),
alocacao: alocacao,
reserva: null,
objetivos: null,
ativos: ativos,
contagem: {
total: ativos.length,
precisa_revisao: ativos.filter(function(a){return a.precisa_revisao;}).length,
unknown: 0
}
};
}
// Salva snapshot 'inicial' derivado do JB. Substitui qualquer inicial anterior.
async function saveInicialFromJB(clientProfileId, jbData) {
var data = buildInicialFromJB(jbData);
if (!data) throw new Error("JB data insuficiente pra gerar snapshot inicial");
return await saveClientSnapshot(clientProfileId, "inicial", data);
}
// Constrói snapshot 'alvo' a partir da alocação SUGERIDA do Journey Book.
// Usa suggestedPercent de cada classe e suggestedPortfolio como lista de ativos.
function buildAlvoFromJB(jbData) {
if (!jbData) return null;
var alocacao = {
renda_fixa: acoes_br: fiis: { pct: 0, valor: 0 },
{ pct: 0, valor: 0 },
{ pct: 0, valor: 0 },
internacional: { pct: 0, valor: 0 },
alternativos: { pct: 0, valor: 0 },
caixa: { pct: 0, valor: 0 }
};
if (jbData.allocationMacro && Array.isArray(jbData.allocationMacro.classes)) {
jbData.allocationMacro.classes.forEach(function(c){
var slug = normalizeJBClasseName(c.name);
if (slug && alocacao[slug] && typeof c.suggestedPercent === "number") {
alocacao[slug].pct += c.suggestedPercent;
alocacao[slug].valor += (c.suggestedValue || 0);
}
});
}
var patr = 0;
Object.keys(alocacao).forEach(function(k){ patr += alocacao[k].valor || 0; });
if (patr === 0 && jbData.clientInfo && jbData.clientInfo.patrimony) {
patr = jbData.clientInfo.patrimony;
}
var ativos = [];
if (Array.isArray(jbData.suggestedPortfolio)) {
jbData.suggestedPortfolio.forEach(function(a){
if (!a) return;
// Aceita ativos sem ticker (caso típico: Renda Fixa — CDBs, Tesouros, CRIs
// chegam com ticker=null do parser de Asset Alloc). Usa a.id como chave quando
// não há ticker, e o nome como display.
var tk = a.ticker ? String(a.ticker).toUpperCase().trim() : null;
var id = tk || a.id || (a.name ? a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice
if (!id) return; // sem ticker E sem id E sem nome: pula
var meta = tk ? lookupTicker(tk) : null;
// Classe: prioriza catálogo; se não achar, usa a classe vinda do parser (já é slug vál
// Se ainda assim não resolver, tenta normalizar pelo label PT-BR (JB real manda "Renda
var classe = null;
if (meta) classe = meta.classe;
else if (typeof a.class === "string" && ["renda_fixa","acoes_br","fiis","internacional"
else classe = normalizeJBClasseName(a.class);
// Subclasse: prioriza catálogo, senão preserva a que veio do parser (crítico pra RF: p
var subclasse = meta ? meta.subclasse : (a.subclasse || a.subclass || null);
ativos.push({
id: id,
ticker: tk,
nome_original: a.name || tk || id,
classe: classe,
subclasse: subclasse,
setor: meta ? meta.setor : null,
segmento: meta ? meta.segmento : null,
intl: meta ? meta.intl : false,
classificacao_fonte: meta ? "catalog" : "jb",
precisa_revisao: !meta && !classe,
valor: a.value || 0,
pct_total: typeof a.percentPortfolio === "number" ? a.percentPortfolio : 0,
pct_classe: 0,
corretoras: [],
carteiras_suno: [],
status_recomendacao: "core",
});
});
}
// Indexadores de RF (subclasses dentro de renda fixa)
var allocIndexadoresRF = {};
if (Array.isArray(jbData.allocationDetail)) {
jbData.allocationDetail.forEach(function(d){
var cls = normalizeJBClasseName(d.class);
if (cls !== "renda_fixa") return;
var ix = normalizeJBIndexadorName(d.subclass);
if (!ix) return;
var pctTotal = typeof d.percentOfTotal === "number" ? d.percentOfTotal : null;
var pctClass = typeof d.percentOfClass === "number" ? d.percentOfClass : null;
var rfPct = alocacao.renda_fixa.pct || 0;
var finalPct;
if (pctTotal && pctTotal > 0) finalPct = pctTotal;
else if (pctClass && pctClass > 0 && rfPct > 0) finalPct = +((pctClass * rfPct) / 100).
else return;
allocIndexadoresRF[ix] = (allocIndexadoresRF[ix] || 0) + finalPct;
});
}
return {
version: 1,
tipo: "alvo",
snapshot_date: (function(){
if (jbData.jbDate) return jbData.jbDate;
return new Date().toISOString().slice(0,10);
})(),
origem: "jb_alvo",
patrimonio_total: +patr.toFixed(2),
alocacao: alocacao,
allocIndexadoresRF: allocIndexadoresRF,
reserva: null,
objetivos: (function(){
var obj = {};
if (jbData.projections) {
if (jbData.projections.capitalAtRetirement) obj.capitalAlvo = jbData.projections.capi
if (jbData.projections.estimatedRetirementIncome) obj.rendaPassivaMeta = jbData.proje
if (jbData.projections.requiredContribution) obj.aporteMensalNecessario = jbData.proj
if (jbData.projections.retirementAge) obj.idadeAposentadoria = jbData.projections.ret
if (jbData.projections.percentMeta) obj.percentMeta = jbData.projections.percentMeta;
}
return Object.keys(obj).length > 0 ? obj : null;
})(),
ativos: ativos,
contagem: {
total: ativos.length,
precisa_revisao: ativos.filter(function(a){return a.precisa_revisao;}).length,
unknown: 0
}
};
}
async function saveAlvoFromJB(clientProfileId, jbData) {
var data = buildAlvoFromJB(jbData);
if (!data) throw new Error("JB data insuficiente pra gerar snapshot alvo");
return await saveClientSnapshot(clientProfileId, "alvo", data);
}
/* ─── BDR ↔ Stock mapping ───
Quando o cliente investe via BDRs (ex: AAPL34, LBRD34) mas a Suno tem análise
da stock subjacente (AAPL, LBRDA), cruzamos os dois via:
1. Match direto
2. Dessufixação do BDR (AAPL34 → AAPL)
3. Match por prefixo (LBRD34 → busca stocks começando com "LBRD" → LBRDA)
4. Tabela de overrides manuais (casos que não caem em 2 e 3)
Padrão BDR B3: 3-5 letras + 33/34/35/39.
*/
// Overrides manuais pra BDRs cujo ticker não desmembra diretamente no ticker da stock.
// A maioria dos casos é coberta automaticamente pelas regras de cascade; este mapa é pra
// edge cases que nenhuma regra genérica pega. Adicione aqui conforme necessário.
var BDR_MANUAL_MAP = {
"GOGL34": "GOOGL", "GOGL35": "GOOG", // Alphabet classe A (BDR usa GOGL, stock tem 5 letras)
// Alphabet classe C
};
function bdrToStockTicker(ticker) {
if (!ticker) return null;
var t = String(ticker).toUpperCase().trim();
var m = t.match(/^([A-Z][A-Z0-9]{2,4})(3[23459])$/);
return m ? m[1] : null;
}
/* Lookup de stock aceitando fallback via BDR.
Se o ticker não existir em allAppStocks mas for BDR e a stock subjacente existir,
retorna a stock anotada com _isBDRMatch=true e _bdrTicker pra UI saber indicar.
Aceita como 2º argumento tanto um array (allAppStocks) quanto um map {ticker: stock}. */
function lookupStockWithBDR(ticker, stocksSource) {
if (!ticker || !stocksSource) return null;
var t = String(ticker).toUpperCase().trim();
// Helpers pra abstrair array vs map
function findByTicker(tk) {
if (Array.isArray(stocksSource)) {
return stocksSource.find(function(s){ return s && s.ticker === tk; }) || null;
}
return stocksSource[tk] || null;
}
function findByPrefix(prefix) {
if (!prefix || prefix.length < 2) return null;
// Internacional é a carteira mais provável pra match por prefixo
if (Array.isArray(stocksSource)) {
// Ordena por menor comprimento — prefere LBRDA a LBRDAR se houver
var candidates = stocksSource.filter(function(s){
return s && s.ticker && s.ticker.indexOf(prefix) === 0 && s.ticker !== prefix;
});
if (candidates.length === 0) return null;
candidates.sort(function(a,b){ return a.ticker.length - b.ticker.length; });
return candidates[0];
}
// Map: itera nas chaves
var keys = Object.keys(stocksSource);
var matches = keys.filter(function(k){ return k.indexOf(prefix) === 0 && k !== prefix; })
if (matches.length === 0) return null;
matches.sort(function(a,b){ return a.length - b.length; });
return stocksSource[matches[0]];
}
// 1. Match direto — ticker já existe na carteira Suno (ex: AAPL digitado em portfolio Inte
var direct = findByTicker(t);
if (direct) return direct;
// Só continua se o ticker parecer BDR
var underlying = bdrToStockTicker(t);
if (!underlying) return null;
var resolvedTicker = null;
var match = null;
// 2. Override manual tem prioridade sobre qualquer inferência
if (BDR_MANUAL_MAP[t]) {
resolvedTicker = BDR_MANUAL_MAP[t];
match = findByTicker(resolvedTicker);
}
// 3. Match direto do desmembrado (AAPL34 → AAPL)
if (!match) {
resolvedTicker = underlying;
match = findByTicker(resolvedTicker);
}
// 4. "Sem B final" — stocks com 3 letras ganham sufixo "B" no BDR pra ter 4 letras:
// // HPQB34 → HPQ, DISB34 → DIS, NKEB34 → NKE. Só entra aqui se o desmembrado tem
exatamente 4 letras e termina em B.
if (!match && underlying.length === 4 && underlying.charAt(3) === "B") {
var withoutB = underlying.slice(0, 3);
var matchB = findByTicker(withoutB);
if (matchB) {
resolvedTicker = withoutB;
match = matchB;
}
}
// 5. Match por prefixo (LBRD34 → LBRDA, pega stocks que estendem o underlying)
if (!match) {
var byPrefix = findByPrefix(underlying);
if (byPrefix) {
resolvedTicker = byPrefix.ticker;
match = byPrefix;
}
}
// 6. Match por prefixo sem B final (caso combinado, raro mas defensivo)
if (!match && underlying.length === 4 && underlying.charAt(3) === "B") {
var prefWithoutB = findByPrefix(underlying.slice(0, 3));
if (prefWithoutB) {
resolvedTicker = prefWithoutB.ticker;
match = prefWithoutB;
}
}
if (match) return Object.assign({}, match, { _isBDRMatch: true, _bdrTicker: t, _underlyingT
return null;
}
/* ─── Parse JB PDF pela IA ───
Função global reutilizável. Recebe File (PDF) e retorna o JSON parseado.
Custa ~$0.20 por chamada (IA Anthropic).
*/
async function parseJBPdfToJson(file) {
if (!file) throw new Error("Arquivo não fornecido");
var arrayBuf = await new Promise(function(res, rej) {
var r = new FileReader();
r.onload = function() { res(r.result); };
r.onerror = function() { rej(new Error("Erro leitura")); };
r.readAsArrayBuffer(file);
});
if (!window.pdfjsLib) {
await new Promise(function(res, rej) {
var s = document.createElement("script");
s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
s.onload = res; s.onerror = rej;
document.head.appendChild(s);
});
window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/p
}
var pdf = await window.pdfjsLib.getDocument({data: arrayBuf}).promise;
var allText = "";
for (var pg = 1; pg <= pdf.numPages; pg++) {
var page = await pdf.getPage(pg);
var tc = await page.getTextContent();
var pageText = tc.items.map(function(item){return item.str;}).join(" ");
if (pageText.trim()) allText += "\n\n--- PAGINA " + pg + " ---\n" + pageText;
}
if (allText.length < 200) throw new Error("PDF parece ser apenas imagens.");
// Sanitiza: remove caracteres de controle não-imprimíveis que quebram JSON,
// normaliza unicode, mantém só ASCII + acentos latinos.
allText = allText
.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ") // controle (exceto \t, \n, \r)
.replace(/[\uD800-\uDFFF]/g, " ") // surrogate pairs órfãs
.replace(/\s+/g, " ") // normaliza espaços
.trim();
console.log("[parseJB] texto extraido: " + allText.length + " chars, " + pdf.numPages + " p
var sys = 'Voce e um parser de documentos financeiros. Recebera o TEXTO EXTRAIDO de um Jour
+ ' {"clientInfo":{"name":"","age":0,"profession":"","riskProfile":"","patrimony":0,"mont
+ '"jbDate":"",'
+ '"projections":{"retirementAge":0,"capitalAtRetirement":0,"percentMeta":0,"realReturnRa
+ '"allocationMacro":{"classes":[{"name":"","currentPercent":0,"suggestedPercent":0,"curr
+ '"allocationDetail":[{"class":"Renda Fixa","subclass":"Pós-fixado","percentOfClass":48,
+ '"currentPortfolio":[{"ticker":"","name":"","class":"","subclass":"","value":0,"percent
+ '"suggestedPortfolio":[{"ticker":"","name":"","class":"","subclass":"","value":0,"perce
+ '"movements":{"sells":[{"ticker":"","value":0,"qty":0}],"buys":[{"ticker":"","value":0,
+ '"assetRationales":[{"ticker":"","class":"","sector":"","currentPrice":0,"ceilingPrice"
+ '"feeFix":{"value":0,"percent":"","asset":""}}'
+ ' REGRAS GERAIS: 1) Extraia TODOS os ativos de TODAS as classes. 2) Valores monetarios
+ ' ONDE PROCURAR CADA CAMPO (IMPORTANTE): '
+ ' - jbDate: PRIMEIRA PAGINA (capa do Journey Book), procure a DATA que aparece ACIMA do
+ ' - clientInfo.name: PRIMEIRA PAGINA (capa), nome completo do cliente.'
+ ' - clientInfo.age: pagina "Perfil do Investidor" ou "Dados do Cliente", campo "Idade".
+ ' - clientInfo.profession: pagina "Perfil do Investidor", campo "Profissao".'
+ ' - clientInfo.riskProfile: pagina "Perfil do Investidor" (ex: Conservador, Moderado, D
+ ' - clientInfo.patrimony: pagina "Perfil do Investidor", campo "Patrimonio" ou "Patrimo
+ ' - clientInfo.monthlyIncome: pagina "Perfil do Investidor", campo "Renda mensal".'
+ ' - clientInfo.monthlyExpenses: pagina "Perfil do Investidor", campo "Gastos mensais" o
+ ' - clientInfo.monthlyContribution: pagina "Perfil do Investidor", campo "Aporte mensal
+ ' - clientInfo.desiredIncome: pagina "Objetivos - Ciclo de Vida", campo "Renda desejada
+ ' - projections.retirementAge: pagina "Objetivos - Ciclo de Vida", campo "Idade de apos
+ ' - projections.capitalAtRetirement: capital projetado na aposentadoria, geralmente no
+ ' - projections.requiredContribution: aporte mensal necessario pra bater a meta, tambem
+ ' - clientInfo.horizon: se nao estiver explicito no JB, DEIXE null (vai ser calculado c
var resp = await fetch("/api/anthropic", {
method: "POST", headers: {"Content-Type":"application/json"},
body: JSON.stringify({
model: "claude-sonnet-4-6",
max_tokens: 8192,
stream: true, // ← streaming pra evitar timeout Vercel (60s) em PDFs longos
system: sys,
messages: [{role:"user", content: "TEXTO DO JOURNEY BOOK (" + pdf.numPages + " paginas)
})
});
if (!resp.ok) {
// Tenta extrair mensagem de erro detalhada
var errMsg = "API " + resp.status;
try {
var errText = await resp.text();
console.error("[parseJB] API error body:", errText);
try {
var errJson = JSON.parse(errText);
if (errJson.error) {
if (typeof errJson.error === "string") errMsg = errJson.error;
else if (errJson.error.message) errMsg = errJson.error.message;
else errMsg = JSON.stringify(errJson.error);
}
} catch (_) {
errMsg = errText.slice(0, 300);
}
} catch(_) {}
throw new Error("API " + resp.status + ": " + errMsg);
}
if (!resp.body) throw new Error("Sem body no response (streaming nao suportado)");
// ─── Consome SSE stream da Anthropic ───
// Formato: cada "event: content_block_delta\ndata: {...}\n\n"
// Acumula apenas os deltas de tipo "text_delta"
var reader = resp.body.getReader();
var decoder = new TextDecoder();
var buffer = "";
var raw = "";
while (true) {
var chunk = await reader.read();
if (chunk.done) break;
buffer += decoder.decode(chunk.value, { stream: true });
// Processa eventos completos (separados por \n\n)
var parts = buffer.split("\n\n");
buffer = parts.pop() || ""; // guarda o último incompleto
for (var p = 0; p < parts.length; p++) {
var lines = parts[p].split("\n");
var dataLine = null;
for (var li = 0; li < lines.length; li++) {
if (lines[li].indexOf("data:") === 0) {
dataLine = lines[li].slice(5).trim();
break;
}
}
if (!dataLine || dataLine === "[DONE]") continue;
try {
var evt = JSON.parse(dataLine);
if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta
raw += evt.delta.text;
} else if (evt.type === "error") {
throw new Error("Stream error: " + (evt.error ? evt.error.message : "unknown"));
}
} catch(parseErr) {
// Ignora eventos que não são JSON válido (ex: pings, comments)
}
}
}
if (!raw) throw new Error("Resposta vazia da IA");
// Limpa e parseia JSON
raw = raw.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"");
var si = raw.indexOf("{"); var ei = raw.lastIndexOf("}");
if (si >= 0 && ei > si) raw = raw.slice(si, ei + 1);
raw = raw.replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]").replace(/\n/g, " ").replace(/\t/g,
var parsed;
try { parsed = JSON.parse(raw); } catch(jsonErr) {
var repaired = raw;
var ob = (raw.match(/{/g)||[]).length; var cb = (raw.match(/}/g)||[]).length;
var oB = (raw.match(/\[/g)||[]).length; var cB = (raw.match(/\]/g)||[]).length;
for (var bi = 0; bi < oB - cB; bi++) repaired += "]";
for (var bri = 0; bri < ob - cb; bri++) repaired += "}";
repaired = repaired.replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]");
parsed = JSON.parse(repaired);
}
// ─── Pós-processamento: corrige classificações que a IA costuma errar ───
// 1) CRIs/CRAs/CDBs prefixados marcados como pós-fixado: se o nome claramente
// indica prefixado (via inferSubclasseRF), força o override.
// 2) BDRs (tickers terminados em 33/34/35/39) classificados como Ações BR:
// reclassifica como "Internacional".
if (parsed && typeof parsed === "object") {
function isBDRTicker(ticker) {
if (!ticker) return false;
var t = String(ticker).toUpperCase().trim();
return /^[A-Z]{3,5}(33|34|35|39)$/.test(t);
}
function looksLikeBrazilianStock(classLabel) {
if (!classLabel) return true; // null/vazio tb entra no override (IA deixou em branco)
var c = String(classLabel).toLowerCase();
return c.indexOf("acoes") >= 0 || c.indexOf("acao") >= 0
|| c.indexOf("ações") >= 0 || c.indexOf("ação") >= 0
|| c === "renda variavel" || c === "renda variável"
|| c === "rv" || c.indexOf("rv brasil") >= 0;
}
function sanitizeAsset(a) {
if (!a) return;
// Fix 1: RF — subclass incorreta quando nome sugere prefixado
var nome = a.name || a.ticker || "";
var inferredRF = inferSubclasseRF(nome);
if (inferredRF) {
var currentIx = a.subclass ? normalizeJBIndexadorName(a.subclass) : null;
// Caso 1a: IA não preencheu ou retornou slug diferente → infere do nome
if (!currentIx || (inferredRF === "prefixado" && currentIx === "pos_fixado")) {
// Mapeia slug → label PT-BR pra manter consistência com o resto do JSON
var label = inferredRF === "prefixado" ? "Pré-fixado"
: inferredRF === "ipca" ? "Inflação"
: inferredRF === "pos_fixado" ? "Pós-fixado"
: inferredRF === "fundo_rf" ? "Fundo RF" : null;
if (label) a.subclass = label;
}
}
// Fix 2: BDR classificado como Ações BR → Internacional
if (isBDRTicker(a.ticker) && looksLikeBrazilianStock(a.class)) {
a.class = "Internacional";
// Subclasse: se tava vazia ou inadequada, seta "Renda Variável" ou similar
if (!a.subclass || a.subclass === "Ações" || a.subclass === "Acoes") {
a.subclass = "Renda Variável";
}
// Aplica nos arrays principais de ativos
["currentPortfolio", "suggestedPortfolio", "assetRationales"].forEach(function(key){
if (Array.isArray(parsed[key])) parsed[key].forEach(sanitizeAsset);
}
}
});
}
return parsed;
}
/* ─── Detecta conflitos entre jbData e um profile existente ───
Retorna { hasConflicts: boolean, conflicts: [{field, current, fromJB}] }
Usado pra avisar o consultor se o JB tem dados divergentes dos já digitados.
*/
function detectJBConflicts(profile, jbData) {
var conflicts = [];
if (!profile || !jbData || !jbData.clientInfo) return { hasConflicts: false, conflicts: con
var ci = jbData.clientInfo;
function check(field, currentVal, jbVal, label) {
if (!currentVal && currentVal !== 0) return; // campo vazio, sem conflito
if (!jbVal && jbVal !== 0) return; // JB vazio, sem conflito
var curStr = String(currentVal).trim().toLowerCase();
var jbStr = String(jbVal).trim().toLowerCase();
if (curStr !== jbStr && curStr.length > 0 && jbStr.length > 0) {
conflicts.push({ field: field, label: label, current: currentVal, fromJB: jbVal });
}
}
check("name", profile.name, ci.name, "Nome");
check("age", profile.age, ci.age ? String(ci.age) : null, "Idade");
check("profession", profile.profession, ci.profession, "Profissão");
check("totalWealth", profile.totalWealth, ci.patrimony ? String(ci.patrimony) : null, "Patr
check("monthlyIncome", profile.monthlyIncome, ci.monthlyIncome ? String(ci.monthlyIncome) :
check("monthlyContribution", profile.monthlyContribution, ci.monthlyContribution ? String(c
check("horizon", profile.horizon, ci.horizon ? String(ci.horizon) : null, "Horizonte");
check("riskProfile", profile.riskProfile, ci.riskProfile, "Perfil de risco");
return { hasConflicts: conflicts.length > 0, conflicts: conflicts };
}
/* ─── Aplica dados do JB a um profile ───
options:
- overwriteExisting: se true, sobrescreve campos já preenchidos com valores do JB.
se false, só preenche campos vazios.
Retorna o profile atualizado (novo objeto).
*/
function applyJBToProfile(profile, jbData, options) {
options = options || {};
var overwrite = !!options.overwriteExisting;
var updated = Object.assign({}, profile, {jbData: jbData, jbImportDate: new Date().toISOStr
if (jbData.clientInfo) {
var ci = jbData.clientInfo;
function fill(field, val, transform) {
if (!val && val !== 0) return;
var tv = transform ? transform(val) : val;
if (overwrite || !updated[field]) updated[field] = tv;
}
fill("name", ci.name);
fill("age", ci.age, function(v){ return String(v); });
fill("profession", ci.profession);
if (ci.riskProfile) updated.riskProfile = ci.riskProfile; // sempre aplica
fill("totalWealth", ci.patrimony, function(v){ return String(v); });
fill("monthlyIncome", ci.monthlyIncome, function(v){ return String(v); });
fill("monthlyContribution", ci.monthlyContribution, function(v){ return String(v); fill("monthlyExpenses", ci.monthlyExpenses, function(v){ return String(v); });
});
fill("desiredIncome", ci.desiredIncome, function(v){ return String(v); });
if (ci.horizon) updated.horizon = String(ci.horizon);
if (ci.objective) {
var obj = ci.objective + (ci.desiredIncome ? ". Renda desejada: R$ " + ci.desiredIncome
if (overwrite || !updated.longTermGoals) updated.longTermGoals = obj;
}
}
// Idade de aposentadoria e data de referência vêm em projections (ou jbDate global)
if (jbData.projections) {
if (jbData.projections.retirementAge) {
if (overwrite || !updated.retirementAge) updated.retirementAge = String(jbData.projecti
}
}
// jbDate = data de emissão do Journey Book → vira referenceDate do perfil
if (jbData.jbDate) {
if (overwrite || !updated.referenceDate) updated.referenceDate = jbData.jbDate;
}
// Horizonte = retirementAge - age (calcula se não veio explícito)
if (!updated.horizon || updated.horizon === "5") { // "5" é o default genérico do makeEmpt
var ageNum = parseInt(updated.age) || 0;
var retNum = parseInt(updated.retirementAge) || 0;
if (ageNum > 0 && retNum > ageNum) {
updated.horizon = String(retNum - ageNum);
}
}
if (jbData.allocationMacro && jbData.allocationMacro.classes) {
var allocMap = {"Renda Fixa":"Renda Fixa","Ações":"Ações BR","Acoes":"Ações BR","FIIs":"F
var newAlloc = Object.assign({}, updated.allocation || {});
jbData.allocationMacro.classes.forEach(function(c) {
var mapped = allocMap[c.name] || c.name;
if (newAlloc[mapped]) newAlloc[mapped] = {target: c.suggestedPercent || 0, current: c.c
});
updated.allocation = newAlloc;
}
updated.updatedAt = new Date().toISOString().slice(0,10);
return updated;
}
/* ─── Detecta conflitos entre profileData (de Asset Alloc) e um profile existente ───
Similar a detectJBConflicts mas recebe profileData direto (não jbData).
*/
function detectAssetAllocConflicts(profile, profileData) {
var conflicts = [];
if (!profile || !profileData) return { hasConflicts: false, conflicts: conflicts };
function check(field, currentVal, newVal, label) {
if (!currentVal && currentVal !== 0) return;
if (!newVal && newVal !== 0) return;
var curStr = String(currentVal).trim().toLowerCase();
var newStr = String(newVal).trim().toLowerCase();
if (curStr !== newStr && curStr.length > 0 && newStr.length > 0) {
conflicts.push({ field: field, label: label, current: currentVal, fromJB: newVal });
}
}
check("name", profile.name, profileData.name, "Nome");
check("age", profile.age, profileData.age, "Idade");
check("birthDate", profile.birthDate, profileData.birthDate, "Data de nascimento");
check("profession", profile.profession, profileData.profession, "Profissão");
check("totalWealth", profile.totalWealth, profileData.totalWealth, "Patrimônio");
check("monthlyIncome", profile.monthlyIncome, profileData.monthlyIncome, "Renda mensal");
check("monthlyContribution", profile.monthlyContribution, profileData.monthlyContribution,
check("monthlyExpenses", profile.monthlyExpenses, profileData.monthlyExpenses, "Gastos mens
check("retirementAge", profile.retirementAge, profileData.retirementAge, "Idade aposentador
check("desiredIncome", profile.desiredIncome, profileData.desiredIncome, "Renda desejada");
check("riskProfile", profile.riskProfile, profileData.riskProfile, "Perfil de risco");
check("horizon", profile.horizon, profileData.horizon, "Horizonte (anos)");
check("referenceDate", profile.referenceDate, profileData.referenceDate, "Data de referênci
return { hasConflicts: conflicts.length > 0, conflicts: conflicts };
}
/* ─── Aplica profileData (de Asset Alloc) a um profile ───
options:
- overwriteExisting: se true, sobrescreve. se false, só preenche vazios.
*/
/* ─── Monta um jbData sintético a partir dos dados da Asset Allocation ───
Permite que o app use Asset Alloc como substituto do Journey Book,
destravando abas que dependem de jbData (Estratégia, Recomendação, etc).
O jbData sintético tem o mínimo necessário:
- clientInfo (dados do cliente)
- allocationMacro.classes (com currentPercent e suggestedPercent)
- currentPortfolio (ativos atuais da planilha)
- jbDate (data do relatório)
- origem: "asset_alloc_synthetic" pra saber que é sintético
*/
function buildJbDataFromAssetAlloc(profileData, snapshotAtual, allocMacroAlvo, allocMacroAtua
if (!profileData && !snapshotAtual) return null;
// Converte suggestedPortfolio do parser (já no formato esperado pelo consumidor jbData)
// em array de {ticker, name, class, subclass, percentPortfolio, value}
var suggestedPortfolio = [];
if (Array.isArray(suggestedPortfolioFromAlloc)) {
// Agrega por ticker (se mesmo ticker aparecer em 2 abas, soma os %)
var byTicker = {};
suggestedPortfolioFromAlloc.forEach(function(a){
if (!a || typeof a.percentPortfolio !== "number") return;
var key = a.ticker || a.id || a.name;
if (!key) return;
if (!byTicker[key]) {
byTicker[key] = {
ticker: a.ticker || null,
name: a.name || a.ticker || key,
class: a.classe || null,
subclass: a.subclasse || null,
percentPortfolio: 0,
value: 0,
};
}
byTicker[key].percentPortfolio += a.percentPortfolio;
byTicker[key].value += (a.value || 0);
});
Object.keys(byTicker).forEach(function(k){
var entry = byTicker[k];
entry.percentPortfolio = +entry.percentPortfolio.toFixed(4);
entry.value = +entry.value.toFixed(2);
suggestedPortfolio.push(entry);
});
}
var jbData = {
origem: "asset_alloc_synthetic",
jbDate: (profileData && profileData.referenceDate) || (snapshotAtual && snapshotAtual.sna
clientInfo: {
name: profileData ? profileData.name : null,
age: profileData && profileData.age ? Number(profileData.age) : null,
profession: profileData ? profileData.profession : null,
riskProfile: profileData ? profileData.riskProfile : null,
patrimony: profileData && profileData.totalWealth ? Number(profileData.totalWealth) : 0
monthlyIncome: profileData && profileData.monthlyIncome ? Number(profileData.monthlyInc
monthlyExpenses: profileData && profileData.monthlyExpenses ? Number(profileData.monthl
monthlyContribution: profileData && profileData.monthlyContribution ? Number(profileDat
horizon: profileData && profileData.horizon ? String(profileData.horizon) : "",
desiredIncome: profileData && profileData.desiredIncome ? Number(profileData.desiredInc
objective: "",
liquidityNeed: "",
},
projections: {
retirementAge: profileData && profileData.retirementAge ? Number(profileData.retirement
capitalAtRetirement: 0,
estimatedRetirementIncome: profileData && profileData.desiredIncome ? Number(profileDat
requiredContribution: 0,
percentMeta: 0,
},
allocationMacro: { classes: [], availableCash: 0 },
currentPortfolio: [],
suggestedPortfolio: suggestedPortfolio, // AGORA preenchido a partir das abas por allocationDetail: [], // vazio — sem detalhamento RF por indexador (Asset Alloc classe
só tem
};
// Monta allocationMacro.classes unindo % alvo e % atual
var CLASS_LABELS = {
renda_fixa: "Renda Fixa",
acoes_br: "Ações",
fiis: "FIIs",
internacional: "Internacional",
alternativos: "Alternativo",
};
var CLASS_KEYS = ["renda_fixa", "acoes_br", "fiis", "internacional", "alternativos"];
var totalPatr = (snapshotAtual && snapshotAtual.patrimonio_total) || 0;
CLASS_KEYS.forEach(function(k) {
var curPct = (allocMacroAtual && allocMacroAtual[k]) || 0;
var sugPct = (allocMacroAlvo && allocMacroAlvo[k]) || 0;
var curVal = totalPatr > 0 ? +((curPct / 100) * totalPatr).toFixed(2) : 0;
var sugVal = totalPatr > 0 ? +((sugPct / 100) * totalPatr).toFixed(2) : 0;
if (curPct > 0 || sugPct > 0) {
jbData.allocationMacro.classes.push({
name: CLASS_LABELS[k],
currentPercent: curPct,
suggestedPercent: sugPct,
currentValue: curVal,
suggestedValue: sugVal,
});
}
});
// Monta currentPortfolio a partir dos ativos do snapshot
if (snapshotAtual && Array.isArray(snapshotAtual.ativos)) {
snapshotAtual.ativos.forEach(function(a) {
if (!a || !a.ticker) return; // só ativos com ticker pra jb.currentPortfolio
jbData.currentPortfolio.push({
ticker: a.ticker,
name: a.nome_original || a.ticker,
class: a.classe,
subclass: a.subclasse,
value: a.valor,
percentPortfolio: a.pct_total || 0,
});
});
}
return jbData;
}
function applyAssetAllocToProfile(profile, profileData, allocMacroAlvo, allocMacroAtual, snap
options = options || {};
var overwrite = !!options.overwriteExisting;
var suggestedPortfolio = options.suggestedPortfolio || null; // NOVO: array de alvos por a
var updated = Object.assign({}, profile);
function fill(field, val) {
if (val === null || val === undefined || val === "") return;
if (overwrite || !updated[field] || updated[field] === "" || (field === "horizon" && upda
updated[field] = val;
}
}
fill("name", profileData.name);
fill("birthDate", profileData.birthDate);
fill("age", profileData.age);
fill("profession", profileData.profession);
fill("totalWealth", profileData.totalWealth);
fill("monthlyIncome", profileData.monthlyIncome);
fill("monthlyContribution", profileData.monthlyContribution);
fill("monthlyExpenses", profileData.monthlyExpenses);
fill("retirementAge", profileData.retirementAge);
fill("desiredIncome", profileData.desiredIncome);
fill("referenceDate", profileData.referenceDate);
fill("horizon", profileData.horizon);
if (profileData.riskProfile) updated.riskProfile = profileData.riskProfile; // sempre apli
if (profileData.hasEmergencyReserve === true) updated.hasEmergencyReserve = true;
// Alocação por classe (target da aba Simulação + current também da Simulação)
var hasAlvo = allocMacroAlvo && Object.keys(allocMacroAlvo).length > 0;
var hasAtual = allocMacroAtual && Object.keys(allocMacroAtual).length > 0;
if (hasAlvo || hasAtual) {
var allocMap = { renda_fixa: "Renda Fixa", acoes_br: "Ações BR", fiis: "FIIs", internacio
var newAlloc = Object.assign({}, updated.allocation || {});
Object.keys(allocMap).forEach(function(k) {
var label = allocMap[k];
if (!newAlloc[label]) return;
var entry = Object.assign({}, newAlloc[label]);
if (hasAlvo && typeof allocMacroAlvo[k] === "number") entry.target = allocMacroAlvo[k];
if (hasAtual && typeof allocMacroAtual[k] === "number") entry.current = allocMacroAtual
newAlloc[label] = entry;
});
updated.allocation = newAlloc;
}
// Cria jbData sintético pra destravar as abas que dependem dele (Estratégia, Recomendação)
// Só sobrescreve se ainda não existe jbData OU se o existente é sintético (permite reimpor
var hasRealJb = updated.jbData && updated.jbData.origem !== "asset_alloc_synthetic";
if (!hasRealJb) {
var syntheticJb = buildJbDataFromAssetAlloc(profileData, snapshotAtual, allocMacroAlvo, a
if (syntheticJb) {
updated.jbData = syntheticJb;
updated.jbImportDate = new Date().toISOString().slice(0,10);
}
}
updated.assetAllocImportDate = new Date().toISOString().slice(0,10);
updated.updatedAt = new Date().toISOString().slice(0,10);
return updated;
}
/* ═══ TICKER OVERRIDES (M2) ═══
Overrides sobrescrevem o catálogo seed. Todo mundo lê; só admin escreve
via RPC upsert_ticker_override.
*/
async function loadTickerOverrides() {
try {
var res = await supabase.from("ticker_overrides").select("*");
if (res.error) { console.error("[overrides] load error:", res.error); return {}; }
var lookup = {};
(res.data || []).forEach(function(r){
if (r.ticker) lookup[r.ticker.toUpperCase()] = r;
});
return lookup;
} catch(err) { console.error("[overrides] load exception:", err); return {}; }
}
async function upsertTickerOverride(ticker, classe, subclasse, setor, segmento, intl, note) {
var res = await supabase.rpc("upsert_ticker_override", {
p_ticker: ticker,
p_classe: classe,
p_subclasse: subclasse,
p_setor: setor,
p_segmento: segmento,
p_intl: !!intl,
p_note: note || null
});
if (res.error) throw new Error(res.error.message);
return res.data;
}
/* ═══ LOOKUPS AUXILIARES ═══ */
// Monta mapa ticker → [nomes das carteiras Suno que contêm o ticker].
// Formato real de carteiras_data: { carteiras: [{id, name, intl}], ativos: {cartId: [{ticker
function buildSunoCarteirasLookup() {
var lookup = {};
try {
var s = localStorage.getItem("tt-carteiras-suno");
if (!s) return lookup;
var data = JSON.parse(s);
if (!data || typeof data !== "object") return lookup;
var carteiras = Array.isArray(data.carteiras) ? data.carteiras : [];
var ativosMap = (data.ativos && typeof data.ativos === "object") ? data.ativos : {};
carteiras.forEach(function(cart){
if (!cart || !cart.id) return;
var ativos = ativosMap[cart.id];
if (!Array.isArray(ativos)) return;
var nomeCarteira = cart.name || cart.id;
ativos.forEach(function(a){
if (!a || !a.ticker) return;
var tk = String(a.ticker).toUpperCase().trim();
if (!tk) return;
if (!lookup[tk]) lookup[tk] = [];
if (lookup[tk].indexOf(nomeCarteira) < 0) lookup[tk].push(nomeCarteira);
});
});
} catch(e) { console.warn("[suno] lookup build error:", e); }
return lookup;
}
// Retorna mapa {asset_id: status_recomendacao} do snapshot 'atual' mais recente
// do cliente. Usado pra herdar status ao importar um novo snapshot.
async function buildPreviousStatusLookup(clientProfileId) {
var lookup = {};
try {
var res = await supabase
.from("client_snapshots")
.select("data")
.eq("client_profile_id", clientProfileId)
.eq("tipo", "atual")
.order("snapshot_date", { ascending: false })
.limit(1);
if (res.error) return lookup;
var row = res.data && res.data[0];
if (!row || !row.data || !Array.isArray(row.data.ativos)) return lookup;
row.data.ativos.forEach(function(a){
if (a && a.id && a.status_recomendacao) lookup[a.id] = a.status_recomendacao;
});
} catch(e) { console.warn("[snapshot] previous status lookup error:", e); }
return lookup;
}
/* ═══ END CLIENT SNAPSHOTS ═══ */
var INTL_SUBS = {
"Dollar Income": ["VNOM","HPQ","EWBC","ALLY","BTI"],
"Hidden Value": ["PAM","GPRK","IRS","HCC","AMR","PROSY","BABA","BFH"],
"Great Companies": ["SIRI","LBRDA","AMZN","GOOG","META","BKNG","BLK","BRKB"]
};
function makeData() {
return {
Dividendos: [
{"ticker": "WIZC3", "name": "Wiz", "quarter": "4T25", "highlight": false, "sentiment":
{"ticker": "BBSE3", "name": "BB Seguridade", "quarter": "4T25", "highlight": false, "se
{"ticker": "BBAS3", "name": "Banco do Brasil", "quarter": "4T25", "highlight": true, "s
{"ticker": "UNIP6", "name": "Unipar", "quarter": "4T25", "highlight": false, "sentiment
{"ticker": "VALE3", "name": "Vale", "quarter": "4T25", "highlight": false, "sentiment":
{"ticker": "PETR4", "name": "Petrobras", "quarter": "4T25", "highlight": false, "sentim
{"ticker": "AXIA6", "name": "Axia Energia", "quarter": "4T25", "highlight": false, "sen
{"ticker": "TUPY3", "name": "Tupy", "quarter": "4T25", "highlight": true, "sentiment":
{"ticker": "ITSA4", "name": "Itaúsa", "quarter": "4T25", "highlight": false, "sentiment
{"ticker": "SLCE3", "name": "SLC Agrícola", "quarter": "", "highlight": false, "sentime
{"ticker": "EGIE3", "name": "Engie Brasil", "quarter": "4T25", "highlight": false, "sen
{"ticker": "AGRO3", "name": "BrasilAgro", "quarter": "4T25", "highlight": false, "senti
{"ticker": "SEER3", "name": "Ser Educacional", "quarter": "4T25", "highlight": true, "s
],
Valor: [
{"ticker": "B3SA3", "name": "B3", "quarter": "4T25", "highlight": true, "sentiment": "p
{"ticker": "KLBN4", "name": "Klabin", "quarter": "4T25", "highlight": false, "sentiment
{"ticker": "TTEN3", "name": "3tentos", "quarter": "4T25", "highlight": false, "sentimen
{"ticker": "PRIO3", "name": "PRIO SA", "quarter": "4T25", "highlight": false, "sentimen
{"ticker": "BRBI11", "name": "BR Advisory Partners Participações S.A.", "quarter": "4T2
{"ticker": "PNVL3", "name": "Panvel", "quarter": "4T25", "highlight": false, "sentiment
{"ticker": "GMAT3", "name": "Grupo Mateus", "quarter": "4T25", "highlight": false, "sen
{"ticker": "VIVA3", "name": "Vivara", "quarter": "4T25", "highlight": true, "sentiment"
{"ticker": "EZTC3", "name": "Eztec", "quarter": "4T25", "highlight": true, "sentiment":
{"ticker": "TIMS3", "name": "TIM Brasil", "quarter": "4T25", "highlight": false, "senti
{"ticker": "VAMO3", "name": "Vamos", "quarter": "4T25", "highlight": false, "sentiment"
{"ticker": "BRKM5", "name": "Braskem", "quarter": "4T25", "highlight": false, "sentimen
],
"Small Caps": [
{"ticker": "FIQE3", "name": "Unifique Telecomunicações", "quarter": "4T25", "highlight"
{"ticker": "RECV3", "name": "PetroRecôncavo", "quarter": "4T25", "highlight": false, "s
{"ticker": "RANI3", "name": "Irani Papel e Embalagem S.A.", "quarter": "4T25", "highlig
{"ticker": "ABCB4", "name": "Banco ABC Brasil", "quarter": "4T25", "highlight": false,
{"ticker": "CAMB3", "name": "Cambuci", "quarter": "4T25", "highlight": false, "sentimen
{"ticker": "FESA4", "name": "Ferbasa", "quarter": "4T25", "highlight": false, "sentimen
{"ticker": "SHUL4", "name": "Schulz", "quarter": "4T25", "highlight": false, "sentiment
{"ticker": "BRSR6", "name": "Banrisul", "quarter": "4T25", "highlight": true, "sentimen
{"ticker": "KEPL3", "name": "Kepler Weber", "quarter": "4T25", "highlight": false, "sen
{"ticker": "SOJA3", "name": "Boa Safra", "quarter": "4T25", "highlight": false, "sentim
{"ticker": "CLSC4", "name": "CELESC", "quarter": "4T25", "highlight": false, "sentiment
{"ticker": "MLAS3", "name": "Grupo Multi", "quarter": "4T25", "highlight": false, "sent
],
Internacional: [
{"ticker": "VNOM", "name": "Viper Energy Partners LP", "quarter": "2025", "highlight":
{"ticker": "HPQ", "name": "HP Inc.", "quarter": "1T26", "highlight": false, "sentiment"
{"ticker": "EWBC", "name": "East West Bancorp Inc", "quarter": "4Q25", "highlight": fal
{"ticker": "ALLY", "name": "Ally Financial Inc", "quarter": "2025", "highlight": false,
{"ticker": "BTI", "name": "British American Tobacco", "quarter": "2025", "highlight": f
{"ticker": "PAM", "name": "Pampa Energía", "quarter": "2025", "highlight": false, "sent
{"ticker": "GPRK", "name": "GeoPark", "quarter": "2025", "highlight": false, "sentiment
{"ticker": "IRS", "name": "IRSA Inversiones y Representaciones Sociedad Anónima", "quar
{"ticker": "HCC", "name": "Warrior Met Coal Inc", "quarter": "4T25", "highlight": false
{"ticker": "AMR", "name": "Alpha Metallurgical Resources Inc", "quarter": "2025", "high
{"ticker": "PROSY", "name": "Prosus/Tencent", "quarter": "2025", "highlight": false, "s
{"ticker": "BABA", "name": "Alibaba", "quarter": "4T25", "highlight": false, "sentiment
{"ticker": "BFH", "name": "Bread Financial Holdings", "quarter": "4T25", "highlight": f
{"ticker": "SIRI", "name": "Sirius XM Holdings Inc", "quarter": "4Q25", "highlight": fa
{"ticker": "LBRDA", "name": "Liberty Broadband Corp - Series A", "quarter": "4Q25", "hi
{"ticker": "AMZN", "name": "Amazon", "quarter": "4Q25", "highlight": true, "sentiment":
{"ticker": "GOOG", "name": "Alphabet Inc", "quarter": "4T25", "highlight": true, "senti
{"ticker": "META", "name": "Meta Platforms", "quarter": "4T25", "highlight": true, "sen
{"ticker": "BKNG", "name": "Booking Holdings Inc.", "quarter": "4T25", "highlight": tru
{"ticker": "BLK", "name": "BlackRock", "quarter": "4Q25", "highlight": false, "sentimen
{"ticker": "BRKB", "name": "Berkshire Hathaway", "quarter": "2025", "highlight": false,
]
};
}
/* ═══ PDF TEXT SANITIZER ═══
Remove emojis e caracteres não-Latin1 que o jsPDF helvetica não renderiza.
Previne o lixo "Ø=ÜÊ" no PDF. */
function sanitizePDFText(s) {
if (s === null || s === undefined) return "";
var str = String(s);
str = str.replace(/[\u{1F000}-\u{1FFFF}]/gu, "");
str = str.replace(/[\u{2600}-\u{27BF}]/gu, "");
str = str.replace(/[\u{2300}-\u{23FF}]/gu, "");
str = str.replace(/[\u{2B00}-\u{2BFF}]/gu, "");
str = str.replace(/[\u{FE00}-\u{FE0F}]/gu, "");
str = str.replace(/[\u{200B}-\u{200F}]/gu, "");
str = str.normalize("NFC");
str = str.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, "");
return str;
}
function uniqueArr(arr) { var s={}; var o=[]; for(var i=0;i<arr.length;i++){var v=arr[i]; if(
/* ─────────────────────────────────────────────────────────────────────────────
Helpers de câmbio, performance e IR
Usados em Estratégia (JB), Recomendação Mensal (Estado) e Ordens.
Tudo client-side: AwesomeAPI é gratuita; cálculos rodam no browser.
───────────────────────────────────────────────────────────────────────── */
// Cache simples in-memory pra evitar refetch dentro de 1h.
var _fxCache = { rate: null, fetchedAt: 0, ttlMs: 60 * 60 * 1000 };
function fetchUsdBrl() {
var now = Date.now();
if (_fxCache.rate && (now - _fxCache.fetchedAt) < _fxCache.ttlMs) {
return Promise.resolve(_fxCache.rate);
}
return fetch("https://economia.awesomeapi.com.br/last/USD-BRL")
.then(function(r){ return r.ok ? r.json() : null; })
.then(function(d){
if (!d || !d.USDBRL || !d.USDBRL.bid) return null;
var bid = parseFloat(d.USDBRL.bid);
if (!isFinite(bid) || bid <= 0) return null;
_fxCache.rate = bid;
_fxCache.fetchedAt = Date.now();
return bid;
})
.catch(function(){ return null; });
}
/* Calcula performance (preço médio do cliente, preço atual, L/P %, L/P financeiro).
Trata o quirk do Gorila pra ativos internacionais: preço atual exportado em R$
(convertido) e preço médio em USD (moeda original). Para BR, comparação direta.
Retorna null se não dá pra calcular (RF/Caixa, dados incompletos).
*/
function calcPerformanceAtivo(ativo, fxUsdBrl) {
if (!ativo) return null;
var classe = ativo.classe || ativo.class;
if (classe === "renda_fixa" || classe === "caixa") return null;
var pm = Number(ativo.preco_medio);
var pa = Number(ativo.preco);
var qtd = Number(ativo.quantidade);
if (!isFinite(pm) || pm <= 0 || !isFinite(pa) || pa <= 0 || !isFinite(qtd) || qtd <= 0) ret
if (classe === "internacional") {
if (!fxUsdBrl || fxUsdBrl <= 0) return { unsupported: true, reason: "Sem câmbio USD/BRL"
var paUsd = pa / fxUsdBrl;
var diffUnit = paUsd - pm;
var pct = (diffUnit / pm) * 100;
return {
moeda: "USD",
precoMedio: pm,
precoAtual: paUsd,
diffPct: pct,
diffFinanceiro: diffUnit * qtd,
valorAtual: paUsd * qtd,
isEstimativa: true,
fxNote: "câmbio " + fxUsdBrl.toFixed(2)
};
}
var diffUnitBr = pa - pm;
var pctBr = (diffUnitBr / pm) * 100;
return {
moeda: "BRL",
precoMedio: pm,
precoAtual: pa,
diffPct: pctBr,
diffFinanceiro: diffUnitBr * qtd,
valorAtual: pa * qtd,
isEstimativa: false
};
}
/* Estimativa de IR pra venda de ativos (swing trade — Suno nunca recomenda day trade).
AVISO LEGAL: Esta é uma ESTIMATIVA com base nas regras gerais da legislação
brasileira. Não é cálculo tributário definitivo — não considera compensação de
prejuízos acumulados, somatório com outras vendas no mesmo mês de outras
contas, regimes especiais, etc. Cliente deve consultar contador.
Regras:
- Ações BR swing trade: 15% sobre ganho. Isenção se total de vendas no mês ≤ R$ 20k.
(Assume essa ser a única venda de ações do mês; aviso explicita isso.)
- FIIs: 20% sobre ganho. Sem isenção R$ 20k.
- FI-Infra / FIP-IE / Deb. incentivadas: 0% (isento PF).
- ETFs BR: 15% sobre ganho. Sem isenção R$ 20k.
- BDRs: 15% sobre ganho. Sem isenção R$ 20k.
- Internacional (Lei 14.754/2023): 15% fixo sobre ganho em USD.
- Renda Fixa, Caixa: não calculado.
*/
function calcEstimativaIR(opts) {
if (!opts) return null;
var classe = opts.classe || "";
var nome = (opts.nome || opts.ticker || "").toUpperCase();
var ticker = (opts.ticker || "").toUpperCase();
if (classe === "renda_fixa" || classe === "caixa") return null;
var ehInfra = nome.indexOf("INFRA") >= 0 || nome.indexOf("INCENTIVAD") >= 0 || nome.indexOf
if (ehInfra) {
return {
aplicavel: true, aliquota: 0,
baseCalc: opts.ganhoBRL || 0, irDevido: 0,
moeda: "BRL",
regra: "FI-Infra / Debênture incentivada",
motivo: "Isento de IR para pessoa física (Lei 12.431/2011)."
};
}
if (classe === "internacional") {
var ganhoUsd = Number(opts.ganhoUSD);
if (!isFinite(ganhoUsd)) return null;
if (ganhoUsd <= 0) {
return {
aplicavel: false, aliquota: 0.15,
baseCalc: ganhoUsd, irDevido: 0,
moeda: "USD",
regra: "Internacional (Lei 14.754/2023)",
motivo: "Sem ganho (prejuízo) — sem IR; pode compensar com ganhos futuros."
};
}
return {
aplicavel: true, aliquota: 0.15,
baseCalc: ganhoUsd, irDevido: ganhoUsd * 0.15,
moeda: "USD",
regra: "Internacional (Lei 14.754/2023)",
motivo: "15% sobre ganho em moeda original, apuração anual via DAA."
};
}
if (classe === "fiis") {
var ganhoFii = Number(opts.ganhoBRL);
if (!isFinite(ganhoFii)) return null;
if (ganhoFii <= 0) {
return {
aplicavel: false, aliquota: 0.20,
baseCalc: ganhoFii, irDevido: 0,
moeda: "BRL",
regra: "FII (Lei 9.779/1999)",
motivo: "Sem ganho (prejuízo) — sem IR. Pode compensar com ganhos futuros de FIIs."
};
}
return {
aplicavel: true, aliquota: 0.20,
baseCalc: ganhoFii, irDevido: ganhoFii * 0.20,
moeda: "BRL",
regra: "FII (Lei 9.779/1999)",
motivo: "20% sobre o ganho. DARF (código 6015) até o último dia útil do mês seguinte."
};
}
var ganho = Number(opts.ganhoBRL);
var vendaBrl = Number(opts.vendaBRL);
if (!isFinite(ganho)) return null;
var ehBDR = /^[A-Z]{3,5}(33|34|35|39)$/.test(ticker);
var ehETFbr = nome.indexOf("ETF") >= 0 || nome.indexOf("INDEX") >= 0 || /^IVVB11|^BOVA11|^S
if (ganho <= 0) {
return {
aplicavel: false, aliquota: 0.15,
baseCalc: ganho, irDevido: 0,
moeda: "BRL",
regra: ehBDR ? "BDR (15%)" : (ehETFbr ? "ETF BR (15%)" : "Ações BR swing trade (15%)"),
motivo: "Sem ganho (prejuízo) — sem IR. Pode compensar com ganhos futuros da mesma natu
};
}
if (!ehBDR && !ehETFbr && classe === "acoes_br") {
if (isFinite(vendaBrl) && vendaBrl <= 20000) {
return {
aplicavel: false, aliquota: 0.15,
baseCalc: ganho, irDevido: 0,
moeda: "BRL",
regra: "Ações BR swing trade",
motivo: "Isento — venda ≤ R$ 20.000 (assumindo única venda de ações no mês). Se houve
};
}
}
return {
aplicavel: true, aliquota: 0.15,
baseCalc: ganho, irDevido: ganho * 0.15,
moeda: "BRL",
regra: ehBDR ? "BDR (15%)" : (ehETFbr ? "ETF BR (15%)" : "Ações BR swing trade (15%)"),
motivo: ehBDR
? "BDRs não têm isenção de R$ 20k. DARF código 6015 até último dia útil do mês seguinte
: ehETFbr
? "ETFs de ações BR não têm isenção de R$ 20k. DARF código 6015."
: "Vendas mensais acima de R$ 20.000 perdem a isenção. DARF código 6015 até último di
};
}
function fmtMoneyAuto(v, moeda) {
if (!isFinite(v)) return "—";
var symbol = moeda === "USD" ? "US$ " : "R$ ";
var abs = Math.abs(v);
var formatted = abs < 100
? abs.toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits: 2})
: abs.toLocaleString("pt-BR", {maximumFractionDigits: 0});
return (v < 0 ? "-" : "") + symbol + formatted;
}
/* Repara JSON truncado (ex: resposta de IA cortada pelo limite de tokens).
Fecha strings abertas, arrays pendentes, chaves pendentes e remove virgula a direita.
Nao e um parser completo - faz o melhor esforco para recuperar um JSON sintaticamente vali
Retorna o proprio raw se nao for capaz de reparar. */
function repairTruncatedJson(raw) {
if (!raw || typeof raw !== "string") return raw;
var s = raw.trim();
// Remove virgula final imediata (comum em truncamento no meio de array/objeto)
s = s.replace(/,\s*$/, "");
// Percorre contando aspas/chaves/colchetes fora de strings
var inString = false;
var escape = false;
var stack = []; // guarda '{' ou '['
for (var i = 0; i < s.length; i++) {
var ch = s[i];
if (escape) { escape = false; continue; }
if (ch === "\\") { escape = true; continue; }
if (ch === '"') { inString = !inString; continue; }
if (inString) continue;
if (ch === "{" || ch === "[") stack.push(ch);
else if (ch === "}" || ch === "]") stack.pop();
}
// Se terminou dentro de uma string, fecha com aspas
if (inString) s += '"';
// Remove virgula pendente antes do fechamento que vamos adicionar
s = s.replace(/,\s*$/, "");
// Fecha o que sobrou na pilha, do topo pro fundo
while (stack.length > 0) {
var open = stack.pop();
s += (open === "{" ? "}" : "]");
}
return s;
}
/* ═══ FINANCIAL PLANNING MATH (metodologia Suno) ═══
Cálculos de ciclo de vida, evolução patrimonial e sensibilidades.
Implementação fiel à metodologia do Journey Book da Suno:
- Taxa de retorno (ganho de capital) e yield (proventos) por perfil.
- Cálculos em base DIÁRIA com taxa de retorno convertida para o dia.
- Data de aposentadoria = data_nascimento + 365 × idade_aposentadoria.
- Capital Humano = PV de anuidade diária com renda diária = renda_mensal / 30.
- Capital Financeiro = FV diária com PMT diário = aporte_mensal / 30.
- Renda = capital × yield mensal; % Meta = renda_hoje / renda_desejada.
Validado contra 2 Journey Books reais (João Pedro e José Roberto) com
precisão <0,25% em todos os indicadores. */
// Tabela de taxas por perfil (base anual).
// retorno = ganho de capital (capitaliza patrimônio). yield = proventos (gera renda).
var TAXAS_PERFIL = {
"Conservador": {retorno: 0.04, yield: 0.04},
"Moderado": {retorno: 0.05, yield: 0.045},
"Dinâmico": {retorno: 0.06, yield: 0.05},
"Arrojado": {retorno: 0.065, yield: 0.055},
"Sofisticado": {retorno: 0.07, yield: 0.06}
};
function retornoPorPerfil(perfil) {
var t = TAXAS_PERFIL[perfil];
return t ? t.retorno : 0.05;
}
function yieldPorPerfil(perfil) {
var t = TAXAS_PERFIL[perfil];
return t ? t.yield : 0.045;
}
// ─── Helpers de data e idade ────────────────────────────────────────────
// Data de referência para os cálculos:
// - Se prof.referenceDate for válido, usa essa data (reproduz Journey Book antigo).
// - Senão usa a data atual.
function dataReferenciaDoPerfil(prof, fallback) {
if (prof && prof.referenceDate) {
var d = new Date(prof.referenceDate);
if (!isNaN(d.getTime())) return d;
}
return fallback || new Date();
}
// Idade fracionária em anos a partir da data de nascimento.
// Usa 365 dias por ano (consistente com a metodologia Suno).
function idadeFracionariaDeBirthDate(birthDate, refDate) {
if (!birthDate) return null;
var bd = new Date(birthDate);
if (isNaN(bd.getTime())) return null;
var ref = refDate || new Date();
var diffMs = ref.getTime() - bd.getTime();
if (diffMs <= 0) return 0;
return diffMs / (1000 * 60 * 60 * 24 * 365);
}
// Idade real do perfil em anos (fracionária se houver birthDate).
// Retrocompatibilidade: se o perfil antigo só tem prof.age, usa como inteiro.
function idadeRealDoPerfil(prof, refDate) {
var ref = refDate || dataReferenciaDoPerfil(prof);
var frac = idadeFracionariaDeBirthDate(prof && prof.birthDate, ref);
if (frac != null) return frac;
var n = Number(prof && prof.age);
return isFinite(n) && n > 0 ? n : 0;
}
// Calcula dias entre a data de referência e a data de aposentadoria (birthDate + 365*idadeAp
// Se o perfil só tem prof.age (legacy), aproxima por (idadeApos - age) × 365.
function diasAteAposentadoria(prof, idadeApos, refDate) {
var ref = refDate || dataReferenciaDoPerfil(prof);
var ia = Number(idadeApos);
if (!isFinite(ia) || ia <= 0) return 0;
if (prof && prof.birthDate) {
var bd = new Date(prof.birthDate);
if (!isNaN(bd.getTime())) {
var MS_DAY = 24 * 60 * 60 * 1000;
var aposMs = bd.getTime() + ia * 365 * MS_DAY;
return Math.round((aposMs - ref.getTime()) / MS_DAY);
}
}
var idadeAnos = Number(prof && prof.age);
if (!isFinite(idadeAnos) || idadeAnos <= 0) return 0;
return Math.max(0, Math.round((ia - idadeAnos) * 365));
}
// ─── Cálculos do Journey Book ───────────────────────────────────────────
// Calcula capital financeiro futuro usando taxa DIÁRIA (metodologia Suno).
// CF = VP × (1+r_d)^d + PMT_d × ((1+r_d)^d - 1) / r_d
// Onde r_d é taxa diária derivada do retorno anual, d é dias, PMT_d = aporte/30.
function capitalFinanceiroDiario(patrimonio, aporteMensal, retornoAA, dias) {
var P = Number(patrimonio) || 0;
var A = Number(aporteMensal) || 0;
var r = Number(retornoAA) || 0;
var n = Number(dias) || 0;
if (n <= 0) return P;
var pmtDia = A / 30;
if (r === 0) return P + pmtDia * n;
var rDia = Math.pow(1 + r, 1/365) - 1;
var fator = Math.pow(1 + rDia, n);
return P * fator + pmtDia * (fator - 1) / rDia;
}
// Calcula capital humano via PV de anuidade diária.
// CH = renda_dia × (1 - (1+r_d)^-d) / r_d
function capitalHumanoDiario(rendaMensal, retornoAA, dias) {
var R = Number(rendaMensal) || 0;
var r = Number(retornoAA) || 0;
var n = Number(dias) || 0;
if (n <= 0 || R <= 0) return 0;
var rendaDia = R / 30;
if (r === 0) return rendaDia * n;
var rDia = Math.pow(1 + r, 1/365) - 1;
return rendaDia * (1 - Math.pow(1 + rDia, -n)) / rDia;
}
// Formata R$ no padrão brasileiro
function fmtBRL(v) {
var n = Number(v) || 0;
return "R$ " + n.toLocaleString("pt-BR", {minimumFractionDigits: 0, maximumFractionDigits:
}
function fmtBRLCents(v) {
var n = Number(v) || 0;
return "R$ " + n.toLocaleString("pt-BR", {minimumFractionDigits: 2, maximumFractionDigits:
}
function fmtPct(v, decimals) {
var n = Number(v) || 0;
return (n * 100).toFixed(decimals===undefined?1:decimals) + "%";
}
// Retorna objeto completo com todos os cálculos do Journey Book Suno.
// Usa idade fracionária real se houver birthDate; senão cai em prof.age.
// Usa prof.referenceDate se preenchido (reproduz Journey Book antigo), senão usa hoje.
function calcularPlanejamento(prof, refDate) {
var ref = refDate || dataReferenciaDoPerfil(prof);
var idadeReal = idadeRealDoPerfil(prof, ref);
var idadeExib = Math.floor(idadeReal);
var patrimonio = Number(prof.totalWealth) || 0;
var rendaMensal = Number(prof.monthlyIncome) || 0;
var aporteMensal = Number(prof.monthlyContribution) || 0;
var idadeApos = Number(prof.retirementAge) || (Math.ceil(idadeReal) + 20);
var rendaDesejada = Number(prof.desiredIncome) || rendaMensal;
var gastosMensais = Number(prof.monthlyExpenses) || rendaMensal * 0.7;
var retorno = retornoPorPerfil(prof.riskProfile);
var yieldAA = yieldPorPerfil(prof.riskProfile);
// Fórmulas auxiliares
var retornoDia = Math.pow(1 + retorno, 1/365) - 1;
var retornoMes = Math.pow(1 + retorno, 1/12) - 1;
var yieldMes = Math.pow(1 + yieldAA, 1/12) - 1;
// Data e dias até aposentadoria
var diasAteApos = diasAteAposentadoria(prof, idadeApos, ref);
var anosAteApos = diasAteApos / 365;
// Data de aposentadoria (para exibição)
var dataAposentadoria = null;
if (prof.birthDate) {
var bd = new Date(prof.birthDate);
if (!isNaN(bd.getTime())) {
dataAposentadoria = new Date(bd.getTime() + idadeApos * 365 * 24 * 60 * 60 * 1000);
}
}
// ─── Indicadores principais ───────────────────────────────────────────
var capitalFinal = capitalFinanceiroDiario(patrimonio, aporteMensal, retorno, diasAteApos);
var capitalHum = capitalHumanoDiario(rendaMensal, retorno, diasAteApos);
var riquezaTotal = capitalFinal + capitalHum;
// Renda = capital × yield mensal
var rendaAoAposentar = capitalFinal * yieldMes;
var rendaHojeEstim = patrimonio * yieldMes;
// % Meta = renda que o cliente JÁ GERARIA HOJE / renda desejada na aposentadoria
var pctMeta = rendaDesejada > 0 ? rendaHojeEstim / rendaDesejada : 0;
// Patrimônio necessário para gerar a renda desejada pelo yield do perfil.
// É também o valor mostrado como linha de "Meta" no gráfico de evolução.
var capitalNecessario = yieldMes > 0 ? rendaDesejada / yieldMes : 0;
// Aporte mensal necessário para atingir o capitalNecessario até a idade de aposentadoria.
// PMT = (FV - VP × (1+r_m)^n) / ((((1+r_m)^n) - 1) / r_m)
// Com taxa mensal e nper em meses (dias/30).
var aporteNecessario = 0;
var nperM = diasAteApos / 30;
if (retornoMes !== 0 && nperM > 0) {
var fatorM = Math.pow(1 + retornoMes, nperM);
if (fatorM > 1) {
aporteNecessario = Math.max(0, (capitalNecessario - patrimonio * fatorM) / ((fatorM - 1
}
}
// Idade do atingimento: idade em que o cliente atinge o capitalNecessario mantendo
// o aporte atual. Usa NPER em anos (taxa anual, PMT = aporte × 12) e soma a idade
// em dias já vivida dividida por 365.
// Retorna null se já atingiu (patrim >= capitalNecessario) para o PDF/UI mostrarem vazio.
var idadeParaMeta = null;
if (retorno > 0 && capitalNecessario > 0 && patrimonio > 0 && capitalNecessario > patrimoni
var pmtAno = aporteMensal * 12;
var nperAnos = null;
if (pmtAno > 0) {
var numA = capitalNecessario + pmtAno / retorno;
var denA = patrimonio + pmtAno / retorno;
if (numA > 0 && denA > 0 && numA > denA) {
nperAnos = Math.log(numA / denA) / Math.log(1 + retorno);
}
} else {
nperAnos = Math.log(capitalNecessario / patrimonio) / Math.log(1 + retorno);
}
if (nperAnos != null && isFinite(nperAnos) && nperAnos >= 0 && prof.birthDate) {
var bdim = new Date(prof.birthDate);
if (!isNaN(bdim.getTime())) {
var diasVividos = Math.floor((ref.getTime() - bdim.getTime()) / (24*60*60*1000));
var idadeTotal = (nperAnos * 365 + diasVividos) / 365;
var anosInt = Math.floor(idadeTotal);
var mesesInt = Math.round((idadeTotal - anosInt) * 12);
if (mesesInt >= 12) { anosInt += 1; mesesInt -= 12; }
idadeParaMeta = {anos: anosInt, meses: mesesInt, idade: anosInt, idadeFrac: idadeTota
}
}
}
// ─── Séries para gráficos ────────────────────────────────────────────
// Ciclo de vida: ponto inicial em idade fracionária (hoje), pontos intermediários
// ano a ano, último ponto exato na idade de aposentadoria. Evita "dip" visual
// no final que acontece quando o último ponto está fora do range real de tempo.
var cicloVida = [];
cicloVida.push({
idade: idadeReal,
capitalFinanceiro: patrimonio,
capitalHumano: capitalHum,
riquezaTotal: patrimonio + capitalHum
});
var anosFloor = Math.floor(anosAteApos);
for (var t = 1; t <= anosFloor; t++) {
var diasPassados = t * 365;
var diasRestantes = Math.max(0, diasAteApos - diasPassados);
var capFt = capitalFinanceiroDiario(patrimonio, aporteMensal, retorno, diasPassados);
var capHt = capitalHumanoDiario(rendaMensal, retorno, diasRestantes);
cicloVida.push({
idade: idadeReal + t,
capitalFinanceiro: capFt,
capitalHumano: capHt,
riquezaTotal: capFt + capHt
});
}
// Ponto final exato na data de aposentadoria (se houver resíduo de tempo)
if (diasAteApos > anosFloor * 365 + 1) {
cicloVida.push({
idade: idadeApos,
capitalFinanceiro: capitalFinal,
capitalHumano: 0,
riquezaTotal: capitalFinal
});
}
// Evolução bienal até 8 anos depois da aposentadoria
var evolucaoBienal = [];
var anosProjecao = Math.ceil(anosAteApos) + 8;
for (var t2 = 0; t2 <= anosProjecao; t2 += 2) {
var diasT2 = t2 * 365;
var capF2 = capitalFinanceiroDiario(patrimonio, aporteMensal, retorno, diasT2);
evolucaoBienal.push({
ano: t2,
idade: idadeExib + t2,
patrimonio: capF2
});
}
// ─── Tabelas de sensibilidade ────────────────────────────────────────
// Para cada variação, recalcula via metodologia diária e aplica yield mensal para a var sensAporte = [-4000, -2000, 0, 2000, 4000].map(function(d) {
var aporteT = aporteMensal + d;
var cap = capitalFinanceiroDiario(patrimonio, aporteT, retorno, diasAteApos);
return {valor: aporteT, delta: d, patrimonio: cap, renda: cap * yieldMes};
renda.
});
var sensRetorno = [0.04, 0.05, 0.06, 0.065, 0.07].map(function(rr) {
var cap = capitalFinanceiroDiario(patrimonio, aporteMensal, rr, diasAteApos);
return {valor: rr, patrimonio: cap, renda: cap * yieldMes};
});
var sensIdade = [idadeApos - 2, idadeApos - 1, idadeApos, idadeApos + 1, idadeApos + var diasI = diasAteAposentadoria(prof, i, ref);
var cap = capitalFinanceiroDiario(patrimonio, aporteMensal, retorno, diasI);
return {valor: i, patrimonio: cap, renda: cap * yieldMes};
2].map
});
return {
// Entradas
idade: idadeExib,
idadeReal: idadeReal,
dataReferencia: ref,
dataAposentadoria: dataAposentadoria,
diasAteApos: diasAteApos,
patrimonio: patrimonio,
rendaMensal: rendaMensal,
aporteMensal: aporteMensal,
idadeApos: idadeApos,
rendaDesejada: rendaDesejada,
gastosMensais: gastosMensais,
retorno: retorno,
yield: yieldAA,
retornoDia: retornoDia,
retornoMes: retornoMes,
yieldMes: yieldMes,
anosAteApos: anosAteApos,
// Resultados principais
capitalFinal: capitalFinal,
capitalHumano: capitalHum,
riquezaTotal: riquezaTotal,
capitalNecessario: capitalNecessario,
pctMeta: pctMeta,
rendaAoAposentar: rendaAoAposentar,
rendaHojeEstim: rendaHojeEstim,
idadeParaMeta: idadeParaMeta,
aporteNecessario: aporteNecessario,
// Séries
cicloVida: cicloVida,
evolucaoBienal: evolucaoBienal,
// Sensibilidades
sensAporte: sensAporte,
sensRetorno: sensRetorno,
sensIdade: sensIdade
};
}
/* ═══ END FINANCIAL PLANNING ═══ */
function migrateStock(s) {
if (s.thesisPros && s.resultPros) return s;
var allPros = s.pros || [];
var allCons = s.cons || [];
s.thesisPros = s.thesisPros || [];
s.thesisCons = s.thesisCons || [];
s.resultPros = s.resultPros || [];
s.resultCons = s.resultCons || [];
for (var i = 0; i < allPros.length; i++) {
var p = allPros[i];
var isResult = /[\+\-]\d|%|a\/a|t\/t|tri |bi |mi |R\$|US\$|recorde|caiu|subiu|cresceu|mar
if (isResult) { if (s.resultPros.indexOf(p) < 0) s.resultPros.push(p); }
else { if (s.thesisPros.indexOf(p) < 0) s.thesisPros.push(p); }
}
for (var j = 0; j < allCons.length; j++) {
var c = allCons[j];
var isResultC = /[\+\-]\d|%|a\/a|t\/t|tri |bi |mi |R\$|US\$|caiu|subiu|cresceu|margem|luc
if (isResultC) { if (s.resultCons.indexOf(c) < 0) s.resultCons.push(c); }
else { if (s.thesisCons.indexOf(c) < 0) s.thesisCons.push(c); }
}
if (s.thesisPros.length === 0 && s.resultPros.length > 0) {
s.thesisPros = s.resultPros.slice(0, Math.min(2, s.resultPros.length));
}
delete s.pros;
delete s.cons;
return s;
}
function migrateData(data) {
var migrated = {};
Object.keys(data).forEach(function(k) {
migrated[k] = (data[k] || []).map(function(s) { return migrateStock(s); });
});
return migrated;
}
function mergeStock(ex, inc) {
var prev = ex.history || [];
if (ex.result && ex.quarter && ex.quarter !== inc.quarter) {
prev = prev.concat([{quarter:ex.quarter,result:ex.result,date:ex.lastUpdated||""}]);
}
var m = {};
m.ticker = inc.ticker||ex.ticker; m.name = inc.name||ex.name; m.quarter = inc.quarter||ex.q
m.highlight = inc.highlight!==undefined?inc.highlight:ex.highlight; m.sentiment = inc.senti
m.intlSub = inc.intlSub||ex.intlSub;
if (inc._smartMerge) {
m.thesis = inc.thesis || ex.thesis || "";
m.thesisPros = inc.thesisPros || [];
m.thesisCons = inc.thesisCons || [];
m.resultPros = inc.resultPros || [];
m.resultCons = inc.resultCons || [];
} else {
m.thesis = inc.thesis&&inc.thesis.length>(ex.thesis||"").length?inc.thesis:(ex.thesis||in
m.thesisPros = uniqueArr((ex.thesisPros||ex.pros||[]).concat(inc.thesisPros||[]));
m.thesisCons = uniqueArr((ex.thesisCons||ex.cons||[]).concat(inc.thesisCons||[]));
m.resultPros = inc.resultPros||(inc.pros?inc.pros:ex.resultPros)||[];
m.resultCons = inc.resultCons||(inc.cons?inc.cons:ex.resultCons)||[];
}
m.result = inc.result||ex.result; m.sunoView = inc.sunoView||ex.sunoView;
m.history = prev; m.lastUpdated = new Date().toISOString().slice(0,10);
delete m._smartMerge;
return m;
}
function SentimentBadge(p) {
var c={positive:{l:"Positivo",bg:"rgba(34,197,94,0.1)",c:"#4ade80",b:"rgba(34,197,94,0.2)"}
return <span style={{display:"inline-block",padding:"2px 9px",borderRadius:"20px",fontSize:
}
function PointsList(p) {
var items = p.items||[];
if(!items.length) return <div style={{fontSize:"11px",color:"rgba(255,255,255,0.2)",fontSty
return items.map(function(t,i){return <div key={i} style={{fontSize:"11.5px",color:"rgba(25
}
function RankBadge(p) {
if (!p.rank && !p.score) return null;
var scoreColor = p.score >= 8 ? "#4ade80" : p.score >= 5 ? "#fbbf24" : "#f87171";
var delta = (typeof p.score === "number" && typeof p.prevScore === "number") ? p.score - p.
var showDelta = delta !== null && Math.abs(delta) >= 1.5;
return (
<div style={{display:"flex",alignItems:"center",gap:"4px"}}>
{p.rank && <div style={{background:"rgba(255,255,255,0.06)",borderRadius:"6px",padding:
{p.score && <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid " {showDelta && <div style={{fontSize:"9px",fontWeight:800,color:delta>0?"#4ade80":"#f871
</div>
+ scor
);
}
var TONE_OPTIONS = [
{key:"simples",label:"Simples",desc:"Leigo"},
{key:"intermediario",label:"Intermediário",desc:"Noções básicas"},
{key:"profissional",label:"Profissional",desc:"Técnico"}
];
var TONE_MAP = {
"simples":"REGRA DE TOM — SIMPLES (para quem nunca investiu):"
+ "\n- Escreva como se explicasse para um familiar que nao entende nada de investimentos.
+ "\n- PROIBIDO usar termos tecnicos: P/L, EBITDA, yield, spread, duration, ROE, ROIC, mu
+ "\n- Use ANALOGIAS do dia-a-dia para explicar conceitos. Exemplos:"
+ "\n * Em vez de 'margem bruta de 45%': 'de cada R$100 que a empresa fatura, R$45 sobra
+ "\n * Em vez de 'margem liquida de 18%': 'no final das contas, depois de pagar tudo (i
+ "\n * Em vez de 'EBITDA cresceu 12%': 'o lucro das operacoes do dia-a-dia cresceu 12%'
+ "\n * Em vez de 'P/L de 8x': 'pelo preco atual, voce recuperaria o investimento em cer
+ "\n * Em vez de 'yield de 7%': 'a empresa distribui cerca de R$7 por ano para cada R$1
+ "\n * Em vez de 'alavancagem de 2x': 'a empresa deve o dobro do que gera de lucro por
+ "\n- CUIDADO: nao use a mesma analogia para conceitos diferentes. Margem bruta e margem
+ "\n- Frases CURTAS, maximo 20 palavras por frase."
+ "\n- Inclua numeros importantes mas sempre com contexto (ex: 'lucrou R$500 milhoes, 30%
+ "\n- Tom de conversa amigavel e acolhedora, sem ser condescendente.",
"intermediario":"REGRA DE TOM — INTERMEDIARIO (cliente com nocoes basicas):"
+ "\n- O cliente investe ha alguns anos, entende o basico mas nao e profissional do merca
+ "\n- PODE usar termos populares SEM explicar: lucro liquido, receita, dividendo, + "\n- PODE usar MAS EXPLIQUE brevemente na primeira vez que aparecer no texto:"
+ "\n * P/L → 'P/L (quantas vezes o lucro anual o mercado paga pela acao)'"
+ "\n * EBITDA → 'EBITDA (lucro operacional antes de juros e impostos)'"
+ "\n * Yield → 'yield (retorno em dividendos sobre o preco da acao)'"
+ "\n * ROE → 'ROE (retorno sobre o patrimonio — quanto a empresa gera de lucro com o di
+ "\n * Margem liquida → 'margem liquida (percentual da receita que vira lucro de verdad
acao,
+ "\n- EVITE completamente (ou substitua por versao simples): duration, beta, Sharpe, car
+ "\n- Paragrafos de 2-3 frases, com numeros relevantes."
+ "\n- Tom profissional e acessivel — como um consultor de confianca explicando para o cl
"profissional":"REGRA DE TOM — PROFISSIONAL (cliente experiente do mercado):"
+ "\n- Linguagem tecnica completa de mercado financeiro. O cliente domina todos os concei
+ "\n- Use LIVREMENTE todos os termos e indicadores: P/L, P/VP, EV/EBITDA, yield, dividen
+ "\n- Inclua TODOS os numeros relevantes com precisao (percentuais com 1 casa decimal)."
+ "\n- Faca comparacoes com peers, benchmarks e historico quando os dados permitirem."
+ "\n- Analise densa e aprofundada. Paragrafos podem ser mais longos."
+ "\n- Tom de relatorio de research de corretora institucional (XP, BTG, Itau BBA)."
};
var TONE_MAP_SHORT = {
"simples":"linguagem simples com analogias do dia-a-dia, SEM termos tecnicos, para quem nun
"intermediario":"linguagem acessivel, termos populares liberados, termos avancados explicad
"profissional":"linguagem tecnica completa com todos os indicadores e termos do mercado, to
};
function getToneInstruction(tone, short) { return short ? (TONE_MAP_SHORT[tone]||TONE_MAP_SHO
function ToneSelector(p) {
var val = p.value || "simples";
var color = p.color || "#DC2626";
return (
<div style={{display:"flex",gap:"6px",alignItems:"center"}}>
<label style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",whiteSpace:"nowrap"}}>Tom:<
{TONE_OPTIONS.map(function(t){
var active = val === t.key;
return <button key={t.key} onClick={function(){p.onChange(t.key);}} style={{padding:"
})}
</div>
);
}
function StockCard(p) {
var s = p.stock;
var [open,setOpen] = useState(false);
var [del,setDel] = useState(false);
var [moveMenu,setMoveMenu] = useState(false);
var [copyMenu,setCopyMenu] = useState(false);
var hist = s.history||[];
var rp = s.resultPros||[]; var rc = s.resultCons||[];
var tp = s.thesisPros||s.pros||[]; var tc = s.thesisCons||s.cons||[];
var hasResultPoints = rp.length>0 || rc.length>0;
var DEFAULT_KEYS = ["Dividendos","Valor","Small Caps","Internacional:Dollar Income","Intern
var allKeys = p.allKeys || DEFAULT_KEYS;
var curKey = p.currentKey || "";
var existsIn = p.existsIn || {};
function lbl(k){var ix=k.indexOf(":");return ix<0?k:k.slice(ix+1);}
var moveTargets = allKeys.filter(function(x){return x!==curKey;});
// Copiar: remove a atual + as que já têm a ação; também bloqueia copy entre subcarteiras I
var curIsIntl = curKey.indexOf("Internacional:")===0;
var copyTargets = allKeys.filter(function(x){
if(x===curKey)return false;
if(existsIn[x])return false;
if(curIsIntl && x.indexOf("Internacional:")===0)return false; // 1 ticker por Internacion
return true;
});
return (
<div style={{background:"#111",borderRadius:"12px",overflow:"hidden",border:"1px solid rg
<div onClick={function(){setOpen(!open);}} style={{padding:"14px 18px",cursor:"pointer"
<div style={{display:"flex",alignItems:"center",gap:"12px"}}>
<div style={{position:"relative",flexShrink:0}}>
<div style={{background:"#DC2626",borderRadius:"8px",width:"40px",height:"40px",d
{s._rank && <div style={{position:"absolute",top:"-6px",left:"-6px",background:"#
</div>
<div>
<div style={{display:"flex",alignItems:"center",gap:"5px"}}><span style={{fontWei
<div style={{color:"rgba(255,255,255,0.4)",fontSize:"11px",marginTop:"1px"}}>{s.n
</div>
</div>
<div style={{display:"flex",alignItems:"center",gap:"10px"}}><RankBadge score={s.rank
</div>
{open&&(
<div style={{padding:"16px 18px"}}>
<div style={{marginBottom:"16px"}}>
<div style={{fontSize:"9px",fontWeight:700,color:"#DC2626",textTransform:"upperca
<div style={{fontSize:"12.5px",color:"rgba(255,255,255,0.65)",lineHeight:1.6,marg
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px"}}>
<div><div style={{fontSize:"9px",fontWeight:600,color:"rgba(74,222,128,0.6)",ma
<div><div style={{fontSize:"9px",fontWeight:600,color:"rgba(248,113,113,0.6)",m
</div>
</div>
<div style={{marginBottom:"16px",background:"rgba(251,191,36,0.03)",border:"1px sol
<div style={{fontSize:"9px",fontWeight:700,color:"#fbbf24",textTransform:"upperca
<div style={{fontSize:"12.5px",color:"rgba(255,255,255,0.7)",lineHeight:1.6,margi
{hasResultPoints&&(
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px",borderTop:
<div><div style={{fontSize:"9px",fontWeight:700,color:"#4ade80",marginBottom:
<div><div style={{fontSize:"9px",fontWeight:700,color:"#f87171",marginBottom:
</div>
)}
</div>
{hist.length>0&&(<div style={{marginBottom:"14px"}}><div style={{fontSize:"9px",fon
<div style={{marginBottom:"14px"}}><div style={{fontSize:"9px",fontWeight:700,color
<div style={{borderTop:"1px solid rgba(255,255,255,0.05)",paddingTop:"10px",display
{p.onMove && moveTargets.length>0 && (
moveMenu ? (
<div style={{display:"flex",gap:"4px",alignItems:"center",flexWrap:"wrap"}}>
<span style={{fontSize:"10px",color:"rgba(255,255,255,0.4)"}}>Mover para:</
{moveTargets.map(function(t){return <button key={t} onClick={function(e){e.
<button onClick={function(e){e.stopPropagation();setMoveMenu(false);}} styl
</div>
) : (
<button onClick={function(e){e.stopPropagation();setMoveMenu(true);setCopyMen
)
)}
{p.onCopy && copyTargets.length>0 && (
copyMenu ? (
<div style={{display:"flex",gap:"4px",alignItems:"center",flexWrap:"wrap"}}>
<span style={{fontSize:"10px",color:"rgba(255,255,255,0.4)"}}>Copiar para:<
{copyTargets.map(function(t){return <button key={t} onClick={function(e){e.
<button onClick={function(e){e.stopPropagation();setCopyMenu(false);}} styl
</div>
) : (
<button onClick={function(e){e.stopPropagation();setCopyMenu(true);setMoveMen
)
)}
{!del?(<button onClick={function(e){e.stopPropagation();setDel(true);setMoveMenu(
<div style={{display:"flex",gap:"6px",alignItems:"center"}}><span style={{fontS
)}
</div>
</div>
)}
</div>
);
}
/* ─── Diff helpers ─── */
function diffList(oldArr, newArr) {
oldArr = oldArr || []; newArr = newArr || [];
var kept = []; var added = []; var removed = [];
for (var i = 0; i < newArr.length; i++) {
if (oldArr.indexOf(newArr[i]) >= 0) kept.push(newArr[i]);
else added.push(newArr[i]);
for (var j = 0; j < oldArr.length; j++) {
if (newArr.indexOf(oldArr[j]) < 0) removed.push(oldArr[j]);
}
}
return { kept: kept, added: added, removed: removed };
}
function DiffPointsList(p) {
var d = p.diff;
if (!d) return null;
var total = d.kept.length + d.added.length + d.removed.length;
if (total === 0) return <div style={{fontSize:"11px",color:"rgba(255,255,255,0.2)",fontStyl
return (
<div>
{d.removed.map(function(t,i){return <div key={"r"+i} style={{fontSize:"11px",color:"rgb
{d.kept.map(function(t,i){return <div key={"k"+i} style={{fontSize:"11px",color:"rgba(2
{d.added.map(function(t,i){return <div key={"a"+i} style={{fontSize:"11px",color:"rgba(
</div>
);
}
function PreviewPanel(p) {
var nw = p.newData;
var old = p.oldData;
var isNew = !old;
var diffTP = old ? diffList(old.thesisPros, nw.thesisPros) : null;
var diffTC = old ? diffList(old.thesisCons, nw.thesisCons) : null;
var diffRP = old ? diffList(old.resultPros, nw.resultPros) : null;
var diffRC = old ? diffList(old.resultCons, nw.resultCons) : null;
var statsAdd = 0; var statsRem = 0; var statsKeep = 0;
if (!isNew) {
[diffTP,diffTC,diffRP,diffRC].forEach(function(d) {
if (d) { statsAdd += d.added.length; statsRem += d.removed.length; statsKeep += d.kept.
});
}
var secS = {marginBottom:"12px"};
var lblS = {fontSize:"9px",fontWeight:700,textTransform:"uppercase",letterSpacing:"1.2px",m
return (
<div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(251,191,36,0.2)",
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBo
<div style={{display:"flex",alignItems:"center",gap:"8px"}}>
<span style={{fontSize:"16px"}}>&#128269;</span>
<div>
</div>
</div>
<SentimentBadge sentiment={nw.sentiment}/>
</div>
<div style={{fontSize:"13px",fontWeight:700,color:"#fbbf24"}}>{isNew ? "Preview —
<div style={{fontSize:"11px",color:"rgba(255,255,255,0.4)"}}>{nw.ticker} — {nw.na
{!isNew && (
<div style={{display:"flex",gap:"8px",marginBottom:"14px",flexWrap:"wrap"}}>
<span style={{fontSize:"10px",padding:"3px 10px",borderRadius:"10px",background:"rg
<span style={{fontSize:"10px",padding:"3px 10px",borderRadius:"10px",background:"rg
<span style={{fontSize:"10px",padding:"3px 10px",borderRadius:"10px",background:"rg
</div>
)}
<div style={secS}>
<div style={Object.assign({},lblS,{color:"#DC2626"})}>Tese</div>
<div style={{fontSize:"12px",color:"rgba(255,255,255,0.6)",lineHeight:1.6}}>{nw.thesi
{old && old.thesis !== nw.thesis && <div style={{fontSize:"10px",color:"rgba(251,191,
</div>
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginBottom:"12px
<div>
</div>
<div>
</div>
</div>
<div style={Object.assign({},lblS,{color:"rgba(74,222,128,0.7)"})}>Favoráveis da Te
{isNew ? <PointsList items={nw.thesisPros} color="#4ade80" icon="+"/> : <DiffPoints
<div style={Object.assign({},lblS,{color:"rgba(248,113,113,0.7)"})}>Riscos da Tese<
{isNew ? <PointsList items={nw.thesisCons} color="#f87171" icon="-"/> : <DiffPoints
<div style={secS}>
<div style={Object.assign({},lblS,{color:"#fbbf24"})}>Resultado ({nw.quarter})</div>
<div style={{fontSize:"12px",color:"rgba(255,255,255,0.6)",lineHeight:1.6}}>{nw.resul
</div>
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginBottom:"12px
<div>
</div>
<div>
</div>
</div>
<div style={Object.assign({},lblS,{color:"rgba(74,222,128,0.7)"})}>Destaques Positi
{isNew ? <PointsList items={nw.resultPros} color="#4ade80" icon="+"/> : <DiffPoints
<div style={Object.assign({},lblS,{color:"rgba(248,113,113,0.7)"})}>Pontos de Atenç
{isNew ? <PointsList items={nw.resultCons} color="#f87171" icon="-"/> : <DiffPoints
<div style={secS}>
<div style={Object.assign({},lblS,{color:"#DC2626"})}>Visão Suno</div>
<div style={{fontSize:"12px",color:"rgba(255,255,255,0.6)",lineHeight:1.6,padding:"8p
</div>
<div style={{display:"flex",gap:"8px",borderTop:"1px solid rgba(255,255,255,0.06)",padd
<button onClick={p.onConfirm} style={{padding:"9px 22px",borderRadius:"8px",border:"n
<button onClick={p.onDiscard} style={{padding:"9px 22px",borderRadius:"8px",border:"1
</div>
</div>
);
}
function AddPanel(p) {
var [mode,setMode]=useState("ai");var [port,setPort]=useState("Dividendos");var [isub,setIs
var [aiText,setAiText]=useState("");var [aiLoad,setAiLoad]=useState(false);var [aiErr,setAi
var [mT,setMT]=useState("");var [mN,setMN]=useState("");var [mQ,setMQ]=useState("");var [mT
var [mTP,setMTP]=useState("");var [mTC,setMTC]=useState("");var [mRP,setMRP]=useState("");v
var [mR,setMR]=useState("");var [mSV,setMSV]=useState("");var [mSe,setMSe]=useState("neutra
var [writingTone,setWritingTone]=useState("profissional");
// Preview state
var [preview, setPreview] = useState(null); // { newData, oldData }
// Explicit stock selection for updating
var [selTicker, setSelTicker] = useState("__auto__");
var portfolioStocks = (p.currentData || {})[port] || [];
function handleFile(e){var f=e.target.files[0];if(!f)return;setFn(f.name);var r=new FileRea
async function handleAI(){if(!aiText.trim())return;setAiLoad(true);setAiErr("");setPreview(
var isPdf=aiText.indexOf("__PDF__")===0;
var ef=port==="Internacional"?',"intlSub":"'+(isub||"Dollar Income")+'"':"";
// Find existing stock
var existingStock = null;
var allLists = p.currentData || {};
var portfolioList = allLists[port] || [];
if (selTicker !== "__auto__" && selTicker !== "__new__") {
// Explicit selection
for (var xi = 0; xi < portfolioList.length; xi++) {
if (portfolioList[xi].ticker === selTicker) { existingStock = portfolioList[xi]; brea
}
} else if (selTicker === "__auto__") {
// Auto-detect from text
for (var pi = 0; pi < portfolioList.length; pi++) {
var st = portfolioList[pi];
if (aiText.toUpperCase().indexOf(st.ticker) >= 0) {
existingStock = st;
break;
}
}
}
// selTicker === "__new__" means force new entry
var existingContext = "";
if (existingStock) {
existingContext = "\n\nDADOS ATUAIS DESTA EMPRESA NA BASE:\n" + JSON.stringify({
ticker: existingStock.ticker, name: existingStock.name, quarter: existingStock.quarte
thesis: existingStock.thesis,
thesisPros: existingStock.thesisPros || [],
thesisCons: existingStock.thesisCons || [],
resultPros: existingStock.resultPros || [],
resultCons: existingStock.resultCons || [],
result: existingStock.result,
sunoView: existingStock.sunoView,
sentiment: existingStock.sentiment
}, null, 0);
}
var sys = 'Voce e um analista financeiro brasileiro especializado. Sua tarefa e analisar
+ '\n\nTOM DE ESCRITA: ' + getToneInstruction("profissional", false)
+ (existingStock ? ' Voce recebera tambem os DADOS ATUAIS da empresa na base. Voce deve
+ ' REGRAS IMPORTANTES:'
+ ' 1) thesisPros e thesisCons sao pontos ESTRUTURAIS e PERMANENTES da tese de investim
+ ' 2) resultPros e resultCons sao destaques ESPECIFICOS do ultimo resultado trimestral
+ ' 3) Se um ponto antigo da tese ou resultado foi CONTRADITO por dados novos, REMOVA o
+ ' 4) Se o texto traz um NOVO TRIMESTRE, os resultPros e resultCons devem ser SUBSTITU
+ ' 5) Priorize qualidade sobre quantidade - so mantenha pontos realmente relevantes e
+ ' 6) O campo "result" deve ser um resumo conciso (maximo 3 frases) do resultado MAIS
+ ' 7) O campo "thesis" deve ser uma descricao atualizada e concisa (maximo 4 frases) d
+ ' 8) Mantenha pontos da tese que CONTINUAM VALIDOS mesmo se nao mencionados no novo t
+ ' 9) RANKSCORE: Atribua uma nota de 1.0 a 10.0 no campo "rankScore" avaliando a QUALI
+ ' 10) REGRA CRITICA DE FIDELIDADE AO RELATORIO: O sunoView e a thesis devem refletir
+ ' 11) FONTE UNICA DE VERDADE: Quando houver conflito entre "DADOS ATUAIS" e "NOVO TEX
+ ' Responda SOMENTE com JSON puro, sem markdown, sem backticks. Estrutura: {"ticker":"
var userContent = (existingStock ? "DADOS ATUAIS:" + existingContext + "\n\nNOVO TEXTO PA
var msgs;
if (isPdf) {
var b64 = aiText.replace("__PDF__","");
msgs = [{role:"user",content:[
{type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
{type:"text",text:userContent + "Analise o PDF acima e gere a ficha consolidada no fo
]}];
} else {
// Limite aumentado de 15k para 80k chars para suportar relatorios Suno completos.
msgs = [{role:"user",content: userContent + aiText.slice(0,80000)}];
}
// max_tokens: 6000 e suficiente para teses consolidadas (tese mais longa da base atual u
// Mantido baixo porque plano Hobby do Vercel tem timeout de 10s; 16000 tokens levavam ~3
var resp=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application
if(!resp.ok){
var eb=await resp.text();
// Mensagem amigavel para timeout de funcao serverless (Vercel Hobby = 10s).
if (resp.status === 504 || eb.indexOf("FUNCTION_INVOCATION_TIMEOUT") >= 0) {
throw new Error("A IA demorou demais para responder (timeout do servidor). Tente um t
}
throw new Error("API "+resp.status+": "+eb.slice(0,300));
}
var d=await resp.json();if(!d.content||!d.content.length)throw new Error("Vazio");
var raw="";for(var i=0;i<d.content.length;i++){if(d.content[i].text)raw+=d.content[i].tex
// Detecta resposta truncada pelo limite de tokens (camada 3: aviso claro ao usuario).
var wasTruncated = d.stop_reason === "max_tokens";
raw=raw.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"");var si=raw.indexOf("{");va
// Camada 2: tenta reparar JSON truncado fechando strings/chaves/colchetes pendentes.
var parsed;
try {
parsed = JSON.parse(raw);
} catch (jsonErr) {
console.warn("[handleAI] JSON.parse falhou, tentando reparo:", jsonErr.message);
var repaired = repairTruncatedJson(raw);
try {
parsed = JSON.parse(repaired);
console.log("[handleAI] JSON reparado com sucesso");
} catch (e2) {
if (wasTruncated) {
throw new Error("A resposta da IA foi truncada por ser muito longa. Tente um texto
}
throw new Error("Resposta nao e JSON valido: " + jsonErr.message);
}
}
if(!parsed.ticker)throw new Error("Sem ticker");
if (wasTruncated) {
console.warn("[handleAI] Resposta truncada mas JSON reparado - revise o preview com ate
}
if(port==="Internacional"&&!parsed.intlSub)parsed.intlSub=isub;
parsed._smartMerge = true;
// Show preview instead of saving directly
setPreview({ newData: parsed, oldData: existingStock || null });
}catch(err){console.error(err);setAiErr("Erro: "+err.message);}setAiLoad(false);}
function confirmPreview() {
if (!preview) return;
p.onAdd(preview.newData, port);
setPreview(null);
setAiText("");
setFn("");
setSelTicker("__auto__");
}
function discardPreview() {
setPreview(null);
}
function handleManual(){if(!mT.trim()||!mN.trim())return;
var entry={ticker:mT.trim().toUpperCase(),name:mN.trim(),quarter:mQ.trim()||"N/A",sentime
thesisPros:mTP.split("\n").filter(function(l){return l.trim();}).map(function(l){return
thesisCons:mTC.split("\n").filter(function(l){return l.trim();}).map(function(l){return
resultPros:mRP.split("\n").filter(function(l){return l.trim();}).map(function(l){return
resultCons:mRC.split("\n").filter(function(l){return l.trim();}).map(function(l){return
result:mR.trim(),sunoView:mSV.trim()};
if(port==="Internacional")entry.intlSub=isub;
p.onAdd(entry,port);setMT("");setMN("");setMQ("");setMTh("");setMTP("");setMTC("");setMRP
var iS={width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255
var lS={fontSize:"10px",fontWeight:600,color:"rgba(255,255,255,0.5)",marginBottom:"4px",dis
return(
<div style={{background:"#111",borderRadius:"12px",padding:"20px",border:"1px solid rgba(
<div style={{fontSize:"9px",fontWeight:700,color:"#DC2626",textTransform:"uppercase",le
<div style={{display:"flex",gap:"6px",marginBottom:"10px",flexWrap:"wrap"}}>{["Dividend
{port==="Internacional"&&<div style={{display:"flex",gap:"6px",marginBottom:"12px"}}>{[
<div style={{display:"flex",gap:"4px",marginBottom:"14px",background:"rgba(255,255,255,
<button onClick={function(){setMode("ai");setPreview(null);}} style={{flex:1,padding:
<button onClick={function(){setMode("manual");setPreview(null);}} style={{flex:1,padd
</div>
{mode==="ai"&&(<div>
{/* Stock selector for consolidation */}
<div style={{marginBottom:"10px"}}>
<label style={lS}>Ativo para atualizar</label>
<select value={selTicker} onChange={function(e){setSelTicker(e.target.value);setPre
<option value="__auto__" style={{background:"#1a1a1a"}}>Detectar automaticamente
<option value="__new__" style={{background:"#1a1a1a"}}>Novo ativo (não existe na
{portfolioStocks.map(function(s){return <option key={s.ticker} value={s.ticker} s
</select>
{selTicker !== "__auto__" && selTicker !== "__new__" && (
<div style={{fontSize:"10px",color:"rgba(251,191,36,0.6)",marginTop:"4px"}}>A IA
)}
</div>
{/* ToneSelector removido: update de tese/resultado sempre usa tom profissional (ver
<textarea value={aiText.indexOf("__PDF__")===0?"[PDF: "+fn+"]":aiText} onChange={func
{aiErr&&<div style={{color:"#f87171",fontSize:"11px",marginTop:"6px",padding:"8px 10p
<div style={{display:"flex",gap:"8px",marginTop:"8px",alignItems:"center",flexWrap:"w
<button onClick={handleAI} disabled={aiLoad||!aiText.trim()||!!preview} style={{pad
<label style={{padding:"8px 18px",borderRadius:"8px",border:"1px solid rgba(255,255
{fn&&<button onClick={function(){setAiText("");setFn("");setPreview(null);}} style=
</div>
{/* Preview panel */}
{preview && <PreviewPanel newData={preview.newData} oldData={preview.oldData} onConfi
{!preview && <div style={{marginTop:"10px",padding:"8px 10px",background:"rgba(255,25
</div>)}
{mode==="manual"&&(<div style={{display:"flex",flexDirection:"column",gap:"10px"}}>
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"8px"}}><div><label
<div><label style={lS}>Tese</label><textarea value={mTh} onChange={function(e){setMTh
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px"}}><div><label sty
<div><label style={lS}>Resumo do Resultado</label><textarea value={mR} onChange={func
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px"}}><div><label sty
<div><label style={lS}>Visão Suno</label><textarea value={mSV} onChange={function(e){
<div style={{display:"flex",gap:"12px",alignItems:"center",flexWrap:"wrap"}}><div sty
<button onClick={handleManual} disabled={!mT.trim()||!mN.trim()} style={{padding:"10p
</div>)}
</div>
);
}
/* ─── Report PDF Generator ─── */
function ReportModal(p) {
var [clientName, setClientName] = useState("");
var [consultorName, setConsultorName] = useState("Rafael Manfroi Radaelli");
var [selTickers, setSelTickers] = useState({});
var [fields, setFields] = useState({tese:true,resultado:true,thesisPros:true,thesisCons:tru
var [generating, setGenerating] = useState(false);
var [genProgress, setGenProgress] = useState("");
var [writingTone, setWritingTone] = useState("simples");
} catc
// Novo: seleção de cliente cadastrado
var [clientProfiles] = useState(function(){ try { return loadClientProfiles() || []; var [selectedClientId, setSelectedClientId] = useState("");
var [loadingClientAssets, setLoadingClientAssets] = useState(false);
var [clientAssetsInfo, setClientAssetsInfo] = useState(null); // {matched, unmatched} após
var allStocks = [];
["Dividendos","Valor","Small Caps","Internacional"].forEach(function(port){
(p.data[port]||[]).forEach(function(s){ allStocks.push(Object.assign({_port:port},s)); })
});
// Cria set rápido de tickers disponíveis em p.data pra cruzar com ativos do cliente
var availableTickers = {};
allStocks.forEach(function(s){ if (s.ticker) availableTickers[String(s.ticker).toUpperCase(
// Seleciona cliente: busca snapshot atual mais recente, pré-seleciona tickers que cruzam c
// Usa snapshot.ativos (posição real atual) em vez de jbData.currentPortfolio (que pode est
async function selectClientProfile(clientId) {
setSelectedClientId(clientId);
if (!clientId) {
setClientAssetsInfo(null);
return;
}
var profile = clientProfiles.find(function(pr){return pr.id === clientId;});
if (!profile) return;
// Preenche nome automaticamente
if (profile.name) setClientName(profile.name);
// Busca snapshot atual mais recente
setLoadingClientAssets(true);
try {
var snaps = await fetchClientSnapshotsForMeeting(clientId);
var latestAtual = snaps && snaps.latestAtual;
var ativosCliente = [];
if (latestAtual && latestAtual.data && Array.isArray(latestAtual.data.ativos)) {
ativosCliente = latestAtual.data.ativos;
} else if (profile.jbData && Array.isArray(profile.jbData.currentPortfolio)) {
// Fallback pra currentPortfolio do jbData se não há snapshot atual
ativosCliente = profile.jbData.currentPortfolio;
}
// Cruza com tickers disponíveis em p.data
var matched = {};
var unmatched = [];
ativosCliente.forEach(function(a){
if (!a || !a.ticker) return;
var tk = String(a.ticker).toUpperCase().trim();
if (availableTickers[tk]) matched[tk] = true;
else unmatched.push(tk);
});
setSelTickers(matched);
setClientAssetsInfo({
matchedCount: Object.keys(matched).length,
unmatchedCount: unmatched.length,
unmatchedSample: unmatched.slice(0, 8),
source: latestAtual ? "snapshot_atual" : (profile.jbData ? "jb_current" : "nenhum")
});
} catch(e) {
console.warn("[ReportModal] falha ao carregar ativos do cliente:", e);
setClientAssetsInfo({ matchedCount: 0, unmatchedCount: 0, unmatchedSample: [], source:
}
setLoadingClientAssets(false);
}
function toggleTicker(t){setSelTickers(function(prev){var n=Object.assign({},prev);if(n[t])
function toggleField(f){setFields(function(prev){var n=Object.assign({},prev);n[f]=!n[f];re
function selectAll(){var n={};allStocks.forEach(function(s){n[s.ticker]=true;});setSelTicke
function selectNone(){setSelTickers({});}
var selCount = Object.keys(selTickers).length;
// Few-shot examples per tone (calibrated with consultant's real style)
var FEW_SHOT = {
"simples": {
example_input: {
result: "Resultado operacional excepcional com volumes recordes, forte geracao de cai
thesis: "Vale e uma das principais mineradoras do mundo com producao de baixo custo,
sunoView: "Recomendacao de COMPRA mantida com preco-teto de R$ 78,00. O ruido contabi
},
example_output: {
result: "A Vale teve um otimo trimestre. Produziu mais minerio do que em qualquer per
thesis: "Imagine a Vale como a dona de uma fazenda gigante, so que em vez de soja, el
sunoView: "Os analistas da Suno recomendam comprar Vale ate o preco de R$ 78,00. Hoje
}
},
"intermediario": {
example_input: {
result: "Resultado operacional excepcional com volumes recordes, forte geracao de cai
thesis: "Vale e uma das principais mineradoras do mundo com producao de baixo custo,
sunoView: "Recomendacao de COMPRA mantida com preco-teto de R$ 78,00. Valuation atrat
},
example_output: {
result: "A Vale entregou um trimestre operacionalmente forte, com producao recorde de
thesis: "A Vale e uma mineradora de classe mundial com o diferencial de ser produtora
sunoView: "A Suno mantem recomendacao de compra ate R$ 78,00. Os analistas consideram
}
},
"profissional": {
example_input: {
result: "Resultado operacional excepcional com volumes recordes, forte geracao de cai
thesis: "Vale e uma das principais mineradoras do mundo com producao de baixo custo e
sunoView: "Recomendacao de COMPRA mantida com preco-teto de R$ 78,00. Valuation atrat
},
example_output: {
result: "VALE3 reportou resultado acima do consenso no 4T25. EBITDA proforma atingiu
thesis: "Tese fundamentada em tres pilares: (i) posicao de low-cost producer com C1 c
sunoView: "Suno mantem recomendacao de compra com preco-teto de R$ 78,00, implicando
}
}
};
// AI rewrite helper - rewrites text fields in selected tone
async function rewriteTexts(stocks) {
setGenProgress("Adaptando textos ao tom selecionado...");
var batchSize = 2;
var rewritten = stocks.map(function(s){return Object.assign({},s);});
var toneRule = getToneInstruction(writingTone, false);
var fewShot = FEW_SHOT[writingTone] || FEW_SHOT["simples"];
for (var b = 0; b < rewritten.length; b += batchSize) {
var batch = rewritten.slice(b, b + batchSize);
setGenProgress("Adaptando " + batch.map(function(s){return s.ticker;}).join(", ") + " (
var toRewrite = batch.map(function(s){
return {
ticker: s.ticker,
thesis: fields.tese ? (s.thesis||"") : "",
result: fields.resultado ? (s.result||"") : "",
sunoView: fields.sunoView ? (s.sunoView||"") : "",
thesisPros: fields.thesisPros ? (s.thesisPros||[]) : [],
thesisCons: fields.thesisCons ? (s.thesisCons||[]) : [],
resultPros: fields.resultPros ? (s.resultPros||[]) : [],
resultCons: fields.resultCons ? (s.resultCons||[]) : []
};
});
try {
var sys = 'Voce e um tradutor de linguagem financeira. Sua UNICA tarefa e reescrever
+ '\n\n' + toneRule
+ '\n\nREGRAS CRITICAS:'
+ '\n1) Releia CADA frase antes de finalizar. Verifique se o tom esta correto.'
+ '\n2) NAO use a mesma analogia ou explicacao para conceitos diferentes (ex: marge
+ '\n3) Mantenha TODOS os dados numericos e fatos do texto original — so mude a for
+ '\n4) Se o texto original menciona um indicador, adapte ao tom: no simples use an
+ '\n5) Siga EXATAMENTE o estilo do exemplo abaixo. Ele define o padrao de escrita
+ '\n\nResponda SOMENTE com JSON puro: [{"ticker":"","thesis":"","result":"","sunoV
var userMsg = 'EXEMPLO DE REFERENCIA — este e o estilo EXATO que voce deve seguir:\n\
+ 'ANTES (resultado): ' + fewShot.example_input.result + '\n'
+ 'DEPOIS (resultado): ' + fewShot.example_output.result + '\n\n'
+ 'ANTES (tese): ' + fewShot.example_input.thesis + '\n'
+ 'DEPOIS (tese): ' + fewShot.example_output.thesis + '\n\n'
+ 'ANTES (visao): ' + fewShot.example_input.sunoView + '\n'
+ 'DEPOIS (visao): ' + fewShot.example_output.sunoView + '\n\n'
+ '---\n\nAgora reescreva estes textos NO MESMO ESTILO do exemplo acima:\n' + JSON.
var resp = await fetch("/api/anthropic", {method:"POST",headers:{"Content-Type":"appl
if (resp.ok) {
var d = await resp.json();
var raw = "";
for (var i=0;i<(d.content||[]).length;i++){if(d.content[i].type==="text"&&d.content
raw=raw.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"");
var si=raw.indexOf("[");var ei=raw.lastIndexOf("]");
if(si>=0&&ei>si){
var parsed=JSON.parse(raw.slice(si,ei+1));
parsed.forEach(function(rw){
for(var ri=b;ri<Math.min(b+batchSize,rewritten.length);ri++){
if(rewritten[ri].ticker===rw.ticker){
if(rw.thesis)rewritten[ri].thesis=rw.thesis;
if(rw.result)rewritten[ri].result=rw.result;
if(rw.sunoView)rewritten[ri].sunoView=rw.sunoView;
if(rw.thesisPros&&rw.thesisPros.length)rewritten[ri].thesisPros=rw.thesisPr
if(rw.thesisCons&&rw.thesisCons.length)rewritten[ri].thesisCons=rw.thesisCo
if(rw.resultPros&&rw.resultPros.length)rewritten[ri].resultPros=rw.resultPr
if(rw.resultCons&&rw.resultCons.length)rewritten[ri].resultCons=rw.resultCo
break;
}
}
});
}
}
} catch(err) { console.error("Rewrite error for batch " + b + ":", err); }
}
return rewritten;
}
async function generate() {
if (selCount === 0) return;
setGenerating(true); setGenProgress("Preparando...");
try {
var selected=allStocks.filter(function(s){return selTickers[s.ticker];});
selected.sort(function(a,b){return(b.rankScore||0)-(a.rankScore||0);});
// Rewrite texts in selected tone via AI
selected = await rewriteTexts(selected);
setGenProgress("Gerando PDF...");
var doc = new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
var W = 210; var H = 297; var ML = 24; var MR = 20; var CW = W - ML - MR;
var y = 0;
var C = {
black:[18,18,18],title:[30,30,30],body:[50,50,50],secondary:[100,100,100],
caption:[140,140,140],muted:[175,175,175],rule:[215,215,215],
bg_light:[245,245,245],bg_card:[250,250,252],
accent:[180,40,40],
positive:[25,120,65],positive_bg:[235,248,240],
negative:[170,45,45],negative_bg:[252,238,238],
neutral_tag:[90,90,90],
amber:[150,105,25],amber_bg:[255,248,232]
};
function setC(c){doc.setTextColor(c[0],c[1],c[2]);}
function setF(c){doc.setFillColor(c[0],c[1],c[2]);}
function setD(c){doc.setDrawColor(c[0],c[1],c[2]);}
function wrap(t,mw,sz){doc.setFontSize(sz);return doc.splitTextToSize(t||"",mw);}
function drawHeader(){
setF(C.accent);doc.rect(0,0,W,0.5,"F");
doc.setFontSize(6.5);doc.setFont("helvetica","bold");setC(C.muted);
doc.text("SUNO ADVISORY HUB",ML,8);
doc.setFont("helvetica","normal");
doc.text("PANORAMA DE RESULTADOS",W-MR,8,{align:"right"});
setD(C.rule);doc.line(ML,11,W-MR,11);
}
function newPage(){doc.addPage();drawHeader();return 18;}
function chk(needed){if(y+needed>H-16){y=newPage();return true;}return false;}
// COVER
setF(C.accent);doc.rect(0,0,W,1,"F");
setF(C.accent);doc.rect(24,40,0.8,100,"F");
doc.setFontSize(8);doc.setFont("helvetica","bold");setC(C.caption);
doc.text("SUNO CONSULTORIA",32,46);
doc.setFontSize(34);doc.setFont("helvetica","bold");setC(C.black);
doc.text("Panorama",32,64);
doc.text("de Resultados",32,80);
doc.setFontSize(10);doc.setFont("helvetica","normal");setC(C.secondary);
doc.text("Análise trimestral das empresas do seu portfólio",32,98);
if(clientName.trim()){
doc.setFontSize(7.5);doc.setFont("helvetica","normal");setC(C.secondary);
doc.text("ELABORADO PARA",32,170);
doc.setFontSize(18);doc.setFont("helvetica","bold");setC(C.title);
doc.text(clientName.trim(),32,179);
}
if(consultorName.trim()){
doc.setFontSize(7.5);doc.setFont("helvetica","normal");setC(C.secondary);
doc.text("CONSULTOR",32,200);
doc.setFontSize(10.5);doc.setFont("helvetica","normal");setC(C.body);
doc.text(consultorName.trim(),32,207);
}
setD(C.caption);doc.line(32,268,W-MR,268);
doc.setFontSize(8);doc.setFont("helvetica","normal");setC(C.secondary);
doc.text(new Date().toLocaleDateString("pt-BR",{day:"2-digit",month:"long",year:"numeri
setF(C.accent);doc.rect(0,H-1,W,1,"F");
// STOCKS
var curPort="";
for(var si=0;si<selected.length;si++){
var s=selected[si];
if(si===0){y=newPage();}
var estH=24;
if(fields.tese)estH+=6+wrap(s.thesis,CW-6,8).length*4;
if(fields.thesisPros)estH+=5+(s.thesisPros||[]).length*4;
if(fields.thesisCons)estH+=5+(s.thesisCons||[]).length*4;
if(fields.resultado)estH+=6+wrap(s.result,CW-6,8).length*4;
if(fields.resultPros)estH+=5+(s.resultPros||[]).length*4;
if(fields.resultCons)estH+=5+(s.resultCons||[]).length*4;
if(fields.sunoView)estH+=6+wrap(s.sunoView,CW-6,8).length*4;
chk(Math.min(estH,80));
if(s._port!==curPort){
curPort=s._port;
if(y>22)y+=4;
doc.setFontSize(6.5);doc.setFont("helvetica","bold");setC(C.accent);
doc.text(curPort.toUpperCase(),ML,y);
y+=4;setF(C.accent);doc.rect(ML,y,15,0.4,"F");y+=5;
}
setF(C.bg_card);setD(C.rule);doc.rect(ML,y-1,CW,18,"DF");
doc.setFontSize(16);doc.setFont("helvetica","bold");setC(C.title);
doc.text(s.ticker,ML+4,y+7);
doc.setFontSize(8.5);doc.setFont("helvetica","normal");setC(C.secondary);
doc.text(s.name+" · "+s.quarter,ML+4,y+13);
var badgeW=28;var badgeX=W-MR-badgeW-4;
var sc=s.rankScore||0;
var sentMap={positive:["POSITIVO","positive","positive_bg"],neutral:["NEUTRO","neutra
var sentInfo=sentMap[s.sentiment]||sentMap.neutral;
if(sc&&fields.nota){
var colName=sc>=8?"positive":sc>=5?"amber":"negative";
var bgName=colName+"_bg";
setF(C[bgName]||C.bg_light);doc.rect(badgeX,y+1.5,badgeW,7,"F");
doc.setFontSize(13);doc.setFont("helvetica","bold");setC(C[colName]);
doc.text(sc.toFixed(1),badgeX+badgeW/2,y+6.5,{align:"center"});
}
setF(C[sentInfo[2]]);doc.rect(badgeX,y+8.5,badgeW,5,"F");
doc.setFontSize(5.5);doc.setFont("helvetica","bold");setC(C[sentInfo[1]]);
doc.text(sentInfo[0],badgeX+badgeW/2,y+11.5,{align:"center"});
y+=21;
function drawText(label,text,lCol){
chk(12);
doc.setFontSize(6.5);doc.setFont("helvetica","bold");setC(lCol);
doc.text(label,ML+2,y);y+=5;
doc.setFontSize(8);doc.setFont("helvetica","normal");setC(C.body);
var lines=wrap(text,CW-6,8);
for(var i=0;i<lines.length;i++){chk(4.5);doc.setFontSize(8);doc.setFont("helvetica"
y+=3;
}
function drawBullets(label,items,bChar,bCol){
if(!items||!items.length)return;
chk(10);
doc.setFontSize(6.5);doc.setFont("helvetica","bold");setC(bCol);
doc.text(label,ML+2,y);y+=5;
for(var i=0;i<items.length;i++){
chk(5);
doc.setFontSize(7.5);doc.setFont("helvetica","bold");setC(bCol);
doc.text(bChar,ML+3,y);
doc.setFont("helvetica","normal");setC(C.body);
var il=wrap(items[i],CW-12,7.5);
for(var j=0;j<il.length;j++){doc.setFontSize(7.5);doc.setFont("helvetica","normal
y+=0.6;
}
y+=3;
}
if(fields.tese&&s.thesis)drawText("TESE DE INVESTIMENTO",s.thesis,C.title);
if(fields.thesisPros)drawBullets("PONTOS FAVORÁVEIS",s.thesisPros,"+",C.positive);
if(fields.thesisCons)drawBullets("RISCOS",s.thesisCons,"-",C.negative);
if(fields.resultado&&s.result)drawText("RESULTADO · "+s.quarter,s.result,C.amber);
if(fields.resultPros)drawBullets("DESTAQUES",s.resultPros,"+",C.positive);
if(fields.resultCons)drawBullets("ATENÇÃO",s.resultCons,"-",C.negative);
if(fields.sunoView&&s.sunoView)drawText("VISÃO SUNO",s.sunoView,C.accent);
y+=3;setD(C.rule);doc.line(ML,y,ML+25,y);y+=10;
}
var pc=doc.internal.getNumberOfPages();
for(var pg=2;pg<=pc;pg++){
doc.setPage(pg);
doc.setFontSize(6.5);doc.setFont("helvetica","normal");setC(C.muted);
doc.text((pg-1)+" | "+(pc-1),W/2,H-10,{align:"center"});
setF(C.accent);doc.rect(0,H-0.5,W,0.5,"F");
}
var fn="panorama-resultados"+(clientName.trim()?"-"+clientName.trim().replace(/\s+/g,"-
doc.save(fn);
}catch(err){
console.error(err);
alert("Erro ao gerar PDF: "+err.message);
}
setGenerating(false); setGenProgress("");
}
var iS = {width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,2
var lS = {fontSize:"10px",fontWeight:600,color:"rgba(255,255,255,0.5)",marginBottom:"4px",d
var fieldOpts = [
{k:"tese",l:"Tese de investimento"},{k:"thesisPros",l:"Favoráveis da tese"},{k:"thesisCon
{k:"resultado",l:"Resumo do resultado"},{k:"resultPros",l:"Destaques positivos"},{k:"resu
{k:"sunoView",l:"Visão Suno"},{k:"nota",l:"Nota (rankScore)"}
];
return (
<div style={p.inline?{padding:"0"}:{position:"fixed",inset:0,zIndex:2000,background:"rgba
<div style={{background:p.inline?"transparent":"#111",borderRadius:p.inline?"0":"14px",
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin
<div>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>Panorama de Resultados
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)",marginTop:"2px"}}>Rela
</div>
<button onClick={p.onClose} style={{background:"transparent",border:"none",color:"r
</div>
<div style={{marginBottom:"12px",background:"rgba(220,38,38,0.04)",border:"1px solid
<label style={Object.assign({},lS,{marginBottom:"6px",color:"#DC2626"})}>Cliente ca
<select value={selectedClientId} onChange={function(e){selectClientProfile(e.target
<option value="" style={{background:"#1a1a1a"}}>— Selecionar pra pré-carregar ati
{clientProfiles.map(function(pr){return <option key={pr.id} value={pr.id} style={
</select>
{loadingClientAssets && <div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",
{clientAssetsInfo && !loadingClientAssets && (
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.55)",marginTop:"6px",lineH
{clientAssetsInfo.source === "snapshot_atual" && <span> Posição do snapshot a
{clientAssetsInfo.source === "jb_current" && <span> Posição do JB (snapshot a
{clientAssetsInfo.source === "nenhum" && <span style={{color:"#f87171"}}>⚠ Clie
<b style={{color:"#4ade80"}}>{clientAssetsInfo.matchedCount} ativo{clientAssets
{clientAssetsInfo.unmatchedCount > 0 && (
<span style={{color:"rgba(255,255,255,0.4)"}}>
{" · "}
<span title={clientAssetsInfo.unmatchedSample.join(", ") + (clientAssetsInf
{clientAssetsInfo.unmatchedCount} fora das carteiras Suno (ignorados)
</span>
</span>
)}
</div>
)}
</div>
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(200px, 1fr))
<div><label style={lS}>Nome do Cliente</label><input value={clientName} onChange={f
<div><label style={lS}>Nome do Consultor</label><input value={consultorName} onChan
</div>
<div style={{marginBottom:"14px"}}>
<label style={Object.assign({},lS,{marginBottom:"6px"})}>Tom do texto no PDF</label
<ToneSelector value={writingTone} onChange={setWritingTone} color="#ef4444"/>
<div style={{fontSize:"9px",color:writingTone==="profissional"?"rgba(139,92,246,0.5
</div>
<div style={{marginBottom:"14px"}}>
<label style={Object.assign({},lS,{marginBottom:"6px"})}>Campos do relatório</label
<div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>
{fieldOpts.map(function(f){return <button key={f.k} onClick={function(){toggleFie
</div>
</div>
<div style={{marginBottom:"14px"}}>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marg
<label style={Object.assign({},lS,{marginBottom:0})}>Empresas ({selCount} selecio
<div style={{display:"flex",gap:"8px"}}>
<button onClick={selectAll} style={{fontSize:"10px",color:"rgba(74,222,128,0.7)
<button onClick={selectNone} style={{fontSize:"10px",color:"rgba(248,113,113,0.
</div>
</div>
<div style={{maxHeight:"260px",overflow:"auto",background:"rgba(255,255,255,0.02)",
{["Dividendos","Valor","Small Caps","Internacional"].map(function(port){
var ps = (p.data[port]||[]).slice().sort(function(a,b){return (b.rankScore||0)-
if (ps.length === 0) return null;
return <div key={port} style={{marginBottom:"8px"}}>
<div style={{fontSize:"9px",fontWeight:700,color:"#DC2626",textTransform:"upp
{ps.map(function(s){
var checked = !!selTickers[s.ticker];
var scColor = (s.rankScore||0)>=8?"#4ade80":(s.rankScore||0)>=5?"#fbbf24":"
return <div key={s.ticker} onClick={function(){toggleTicker(s.ticker);}} st
<div style={{width:"18px",height:"18px",borderRadius:"4px",border:checked
<span style={{fontSize:"12px",fontWeight:600,color:"#f1f5f9",minWidth:"50
<span style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",flex:1,overfl
{s.rankScore&&<span style={{fontSize:"10px",fontWeight:700,color:scColor,
</div>;
})}
</div>;
})}
</div>
</div>
<button onClick={generate} disabled={selCount===0||generating} style={{width:"100%",p
{generating?(genProgress||"Gerando..."):"Gerar PDF (" + selCount + " empresa" + (se
</button>
</div>
</div>
);
}
/* ─── Client Profiles System ─── */
var ALLOC_CLASSES = ["Renda Fixa","Ações BR","FIIs","Internacional","Alternativos"];
var RISK_PROFILES = ["Conservador","Moderado","Dinâmico","Arrojado","Sofisticado"];
var EXP_LEVELS = ["Iniciante","Intermediário","Avançado"];
/* ─── Labels globais (usados em vários componentes) ─── */
var CLASS_LABELS_V2 = {renda_fixa:"Renda Fixa", acoes_br:"Ações BR", fiis:"FIIs", internacion
var INDEXADOR_LABELS_V2 = {pos_fixado:"Pós-fixado", ipca:"IPCA+", prefixado:"Prefixado", fund
function makeEmptyProfile() {
return {
id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
name: "", birthDate: "", age: "", profession: "", maritalStatus: "",
totalWealth: "", monthlyIncome: "", monthlyContribution: "",
retirementAge: "", desiredIncome: "", monthlyExpenses: "",
referenceDate: "", // vazio = usa hoje. Preencher para reproduzir Journey Book antigo.
experience: "Intermediário", riskProfile: "Moderado",
horizon: "5", hasEmergencyReserve: true, liquidityNeed: "Baixa",
longTermGoals: "", strategy: "",
notes: "",
allocation: {
"Renda Fixa": {target: 30, current: 0},
"Ações BR": {target: 25, current: 0},
"FIIs": {target: 20, current: 0},
"Internacional": {target: 20, current: 0},
"Alternativos": {target: 5, current: 0}
},
jbData: null, // Journey Book data saved permanently
jbImportDate: null,
createdAt: new Date().toISOString().slice(0,10),
updatedAt: new Date().toISOString().slice(0,10)
};
}
function loadClientProfiles() {
try {
var s = localStorage.getItem("tt-clients");
if (s) return JSON.parse(s);
} catch(e) {}
return [];
}
function saveClientProfiles(profiles) {
try { localStorage.setItem("tt-clients", JSON.stringify(profiles)); } catch(e) {}
syncToCloud("client_profiles", {profiles: profiles, updated_at: new Date().toISOString()});
}
/* ═══════════════════════════════════════════════════════════════════════════
M3 — Overview + Timeline + Snapshot Viewer
═══════════════════════════════════════════════════════════════════════════
Derivação do ALVO: o alvo NÃO é um snapshot separado. Ele é derivado on-the-fly
do jbData do cliente toda vez que a tela renderiza. Fonte única de verdade.
Comparações:
- Alvo macro (por classe) ← jbData.allocationMacro.classes[].suggestedPercent
- Alvo por ativo ← jbData.suggestedPortfolio[].percentPortfolio
- Metas absolutas ← jbData.projections.{capitalAtRetirement, estimatedRetirementIncome,
*/
// Normaliza nome de classe do JB (pt-BR) pros slugs internos
function normalizeJBClasseName(name) {
if (!name) return null;
var n = String(name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
if (n.indexOf("renda fixa") >= 0) return "renda_fixa";
if (n.indexOf("acoes") >= 0 || n.indexOf("renda variavel") >= 0 || n.indexOf("rv brasil") >
if (n.indexOf("fii") >= 0 || n.indexOf("imobiliari") >= 0) return "fiis";
if (n.indexOf("internacion") >= 0 || n.indexOf("exterior") >= 0 || n.indexOf("global") >= 0
if (n.indexOf("alternat") >= 0 || n.indexOf("multimerc") >= 0) return "alternativos";
if (n.indexOf("caixa") >= 0 || n.indexOf("liquid") >= 0) return "caixa";
return null;
}
// Normaliza nome de indexador do JB (pt-BR) pros slugs internos
function normalizeJBIndexadorName(name) {
if (!name) return null;
var n = String(name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
if (n.indexOf("pos") >= 0 || n.indexOf("cdi") >= 0) return "pos_fixado";
if (n.indexOf("ipca") >= 0 || n.indexOf("inflac") >= 0) return "ipca";
if (n.indexOf("pre") >= 0 || n.indexOf("prefix") >= 0) return "prefixado";
if (n.indexOf("fundo") >= 0) return "fundo_rf";
return null;
}
// Deriva o alvo estruturado do jbData do cliente.
// ─── Auto-classificação de subclasse RF pelo nome do ativo ───
// Infere: pos_fixado | ipca | prefixado | fundo_rf | null
// Canoniza a subclasse de um ativo de RF pro slug interno (pos_fixado/ipca/prefixado/fundo_r
// Prioriza o campo a.subclasse se já for um slug válido, senão tenta normalizar o texto raw,
// senão infere pelo nome. Fallback final: "pos_fixado" (maioria dos ativos de RF no Brasil).
// Isso evita que subclasses inválidas ("estruturado", "previdencia", "multimercado", strings
// vindas do parser JB ou MyProfit) criem seções separadas no agrupamento por indexador.
var VALID_RF_SUBCLASSES = {pos_fixado:1, ipca:1, prefixado:1, fundo_rf:1};
function canonicalizeRFSubclasse(ativo) {
if (!ativo) return "pos_fixado";
var raw = ativo.subclasse;
if (raw && VALID_RF_SUBCLASSES[raw]) return raw;
if (raw) {
var normalized = normalizeJBIndexadorName(raw);
if (normalized && VALID_RF_SUBCLASSES[normalized]) return normalized;
}
var inferred = inferSubclasseRF(ativo.nome_original || ativo.ticker || ativo.id || "");
if (inferred && VALID_RF_SUBCLASSES[inferred]) return inferred;
return "pos_fixado"; // fallback seguro
}
function inferSubclasseRF(nome) {
if (!nome) return null;
var n = String(nome).toUpperCase()
.replace(/[ÁÀÃÂÄ]/g, "A").replace(/[ÉÈÊË]/g, "E").replace(/[ÍÌÎÏ]/g, "I")
.replace(/[ÓÒÕÔÖ]/g, "O").replace(/[ÚÙÛÜ]/g, "U").replace(/Ç/g, "C");
if (/FUNDO/.test(n) && /(RENDA FIXA|RF|TESOURO|CREDITO|DEBENTURE|DI\b|CRI|CRA|REFERENCIADO|
// Critério 2: "renda fixa" no nome (típico de nome de fundo tipo "Itaú Renda Fixa Referenc
if (/RENDA\s+FIXA/.test(n)) return "fundo_rf";
// Critério 3: abreviações comuns de fundo em qualquer posição do nome
// FIRF = Fundo de Investimento de Renda Fixa
// FIF = Fundo de Investimento em Fundos
// FIM RF / FI RF / FIC RF = fundos de RF
if (/\bFIRF\b/.test(n)) return "fundo_rf";
if (/\bFIF\s+(CIC\s+)?RF\b/.test(n)) return "fundo_rf";
if (/\bFI[A-Z]*\s+RF\b|\bFIC\s+RF\b|\bFIM\s+RF\b/.test(n)) return "fundo_rf";
// Critério 4: "Referenciado DI" (com ou sem a palavra "fundo") é clássico fundo RF pós-fix
if (/REFERENCIADO\s+DI\b/.test(n)) return "fundo_rf";
// Critério 5: previdência de renda fixa (PGBL/VGBL RF, Prev RF, Seg Prev FIRF)
if (/\b(PGBL|VGBL)\b/.test(n) && /(RF|RENDA FIXA|CONSERV|REFERENCIADO)/.test(n)) return "fu
if (/\bSEG\s+PREV\b|\bPREVIDENCIA\b/.test(n) && /(RF|FIRF|FIF|REFERENCIADO|RENDA FIXA)/.tes
// IPCA+
if (/IPCA/.test(n)) return "ipca";
if (/\bNTN.?B\b|NTNB/.test(n)) return "ipca";
if (/TESOURO\s+IPCA/.test(n)) return "ipca";
// Prefixado
if (/\bLTN\b/.test(n)) return "prefixado";
if (/\bNTN.?F\b|NTNF/.test(n)) return "prefixado";
if (/TESOURO\s+PREFIXADO|PREFIXAD[OA]/.test(n)) return "prefixado";
// Padrão Suno abreviado: "CRA Pré 13,35%", "CDB Pré X%", "LCA Pré X%" etc.
// Normalização remove o acento, vira "PRE". Pega "PRE" como palavra isolada
// seguida de número (taxa/percentual) pra não confundir com "PRESIDENTE", "PRE-SAL" if (/\bPRE\s+\d/.test(n)) return "prefixado";
// Fallback: padrão "<veículo RF> PRE" (CRA/CRI/CDB/LCA/LCI/DEB + PRE) mesmo sem número
if (/\b(CRA|CRI|CDB|LCA|LCI|LC|LF|DEB)\s+PRE\b/.test(n)) return "prefixado";
etc.
// Pós-fixado
if (/\d+\s*%?\s*CDI|\bCDI\b/.test(n)) return "pos_fixado";
if (/TESOURO\s+SELIC|\bSELIC\b/.test(n)) return "pos_fixado";
if (/POS.?FIXAD[OA]|POS FIXAD[OA]/.test(n)) return "pos_fixado";
if (/\b(LCA|LCI|CDB|LC|LF|LCRA|LIG)\b/.test(n)) return "pos_fixado";
// Poupança rende TR + juros fixos — na prática, trato como pós-fixado
if (/\bPOUPANCA\b/.test(n)) return "pos_fixado";
return null;
}
// Retorna { allocMacro: {classe: pct}, allocAtivos: {ticker: pct}, allocIndexadoresRF: {inde
function deriveTargetFromJB(jbData) {
if (!jbData) return null;
var allocMacro = {};
var allocAtivos = {};
var allocIndexadoresRF = {}; // pct do total do patrimônio (não da classe)
var metas = {};
// Macro por classe
if (jbData.allocationMacro && Array.isArray(jbData.allocationMacro.classes)) {
jbData.allocationMacro.classes.forEach(function(c){
var slug = normalizeJBClasseName(c.name);
if (slug && typeof c.suggestedPercent === "number") {
allocMacro[slug] = (allocMacro[slug] || 0) + c.suggestedPercent;
}
});
}
// Indexadores dentro de RF — converte percentOfClass em pct_do_total usando allocMacro.ren
var rfPct = allocMacro.renda_fixa || 0;
if (Array.isArray(jbData.allocationDetail) && rfPct > 0) {
jbData.allocationDetail.forEach(function(d){
var cls = normalizeJBClasseName(d.class);
if (cls !== "renda_fixa") return;
var ix = normalizeJBIndexadorName(d.subclass);
if (!ix) return;
// Usa percentOfClass preferencialmente (costuma ser mais confiável no JB)
var pctClass = typeof d.percentOfClass === "number" ? d.percentOfClass : null;
var pctTotal = typeof d.percentOfTotal === "number" ? d.percentOfTotal : null;
var finalPct;
if (pctTotal && pctTotal > 0) {
finalPct = pctTotal;
} else if (pctClass && pctClass > 0) {
finalPct = +((pctClass * rfPct) / 100).toFixed(2);
} else {
return;
}
});
allocIndexadoresRF[ix] = (allocIndexadoresRF[ix] || 0) + finalPct;
}
// Fallback pra jbData sintético (Asset Alloc): não tem allocationDetail, então
// agrega indexadores diretamente dos ativos de RF em suggestedPortfolio usando subclasse.
if (Object.keys(allocIndexadoresRF).length === 0 && Array.isArray(jbData.suggestedPortfolio
jbData.suggestedPortfolio.forEach(function(a){
if (!a) return;
var cls = a.class || a.classe;
if (cls !== "renda_fixa") return;
var ix = a.subclass || a.subclasse;
if (!ix) return;
var pct = typeof a.percentPortfolio === "number" ? a.percentPortfolio : 0;
if (pct > 0) allocIndexadoresRF[ix] = (allocIndexadoresRF[ix] || 0) + pct;
});
}
// Por ativo
if (Array.isArray(jbData.suggestedPortfolio)) {
jbData.suggestedPortfolio.forEach(function(a){
if (a && a.ticker && typeof a.percentPortfolio === "number") {
var tk = String(a.ticker).toUpperCase().trim();
if (tk) allocAtivos[tk] = (allocAtivos[tk] || 0) + a.percentPortfolio;
}
});
}
// Metas
if (jbData.projections) {
metas.capitalAlvo = jbData.projections.capitalAtRetirement || null;
metas.rendaPassivaMeta = jbData.projections.estimatedRetirementIncome || null;
metas.aporteMensalNecessario = jbData.projections.requiredContribution || null;
metas.idadeAposentadoria = jbData.projections.retirementAge || null;
metas.percentMeta = jbData.projections.percentMeta || null;
}
return { allocMacro: allocMacro, allocAtivos: allocAtivos, allocIndexadoresRF: allocIndexad
}
// Reconciles saved 'alvo' snapshot com alvo derivado do JB (fallback).
// Se existir snapshot 'alvo' salvo, usa ele; caso contrário, deriva do JB.
// Retorna o mesmo shape de deriveTargetFromJB.
function resolveTarget(savedAlvoSnapshot, jbData) {
if (savedAlvoSnapshot && savedAlvoSnapshot.data) {
var d = savedAlvoSnapshot.data;
var allocMacro = {};
if (d.alocacao) {
Object.keys(d.alocacao).forEach(function(k){
if (d.alocacao[k] && typeof d.alocacao[k].pct === "number") allocMacro[k] = d.alocaca
});
}
// allocAtivos: se o snapshot salvo tem o mapa pronto, usa. Se não, deriva do array d.ati
// (caso típico: snapshot gerado pelo buildAlvoFromJB, que grava ativos[] mas não allocAt
var allocAtivos = d.allocAtivos || {};
if (Object.keys(allocAtivos).length === 0 && Array.isArray(d.ativos)) {
d.ativos.forEach(function(a){
if (!a) return;
var tk = a.ticker || a.id || a.nome_original;
if (!tk) return;
var key = String(tk).toUpperCase().trim();
var pct = typeof a.pct_total === "number" ? a.pct_total : 0;
if (pct > 0) allocAtivos[key] = (allocAtivos[key] || 0) + pct;
});
}
// allocIndexadoresRF: se não tem, tenta derivar agrupando ativos de RF por subclasse.
// Quando a subclasse do ativo vier vazia (snapshots antigos gerados antes do fix do
// buildAlvoFromJB), tenta inferir pelo nome via inferSubclasseRF — assim o detalhamento
// por indexador funciona retroativamente sem precisar regenerar o snapshot.
// Também tenta resgatar ativos cuja classe está null/unknown mas o nome indica RF
// (CDB, Tesouro, CRI, LCA, etc.) — defensivo contra snapshots mal-classificados.
// Normaliza a subclasse pra slug canonical (pos_fixado/ipca/prefixado/fundo_rf) pra
// evitar perder ativos cujo a.subclasse esteja como "Pré-fixado" (texto cru) em vez do s
var allocIndexadoresRF = d.allocIndexadoresRF || {};
if (Object.keys(allocIndexadoresRF).length === 0 && Array.isArray(d.ativos)) {
var VALID_RF_SLUGS = {pos_fixado:1, ipca:1, prefixado:1, fundo_rf:1};
d.ativos.forEach(function(a){
if (!a) return;
var pct = typeof a.pct_total === "number" ? a.pct_total : 0;
if (pct <= 0) return;
var nome = a.nome_original || a.ticker || a.id || "";
// Descobre subclasse: slug direto OU normalizado de texto cru OU inferido pelo nome
var subFromField = null;
if (a.subclasse) {
if (VALID_RF_SLUGS[a.subclasse]) subFromField = a.subclasse;
else subFromField = normalizeJBIndexadorName(a.subclasse); // "Pré-fixado" -> "pre
}
var subInferida = inferSubclasseRF(nome);
var sub = subFromField || subInferida;
if (!sub || !VALID_RF_SLUGS[sub]) return;
// Aceita se classe explícita é RF, OU se classe está vazia/unknown mas nome parece R
var classeOk = a.classe === "renda_fixa"
|| (subInferida && (!a.classe || a.classe === "unknown"));
if (!classeOk) return;
allocIndexadoresRF[sub] = (allocIndexadoresRF[sub] || 0) + pct;
});
}
return {
allocMacro: allocMacro,
allocAtivos: allocAtivos,
allocIndexadoresRF: allocIndexadoresRF,
metas: d.objetivos || {},
source: "saved",
};
}
var derived = deriveTargetFromJB(jbData);
if (derived) derived.source = "jb_derived";
return derived;
}
/* Busca snapshot atual mais recente + alvo salvo do cliente.
Retorna {latestAtual, savedAlvo} ou {null, null} se falhar/não existir. */
async function fetchClientSnapshotsForMeeting(clientProfileId) {
try {
var res = await supabase.from("client_snapshots").select("*").eq("client_profile_id", cli
if (res.error || !res.data) return { latestAtual: null, savedAlvo: null };
var atuais = res.data.filter(function(s){return s.tipo==="atual";}).sort(function(a,b){re
var alvo = res.data.find(function(s){return s.tipo==="alvo";});
return { latestAtual: atuais[0] || null, savedAlvo: alvo || null };
} catch(e) {
console.warn("[meeting] snapshot fetch error:", e);
return { latestAtual: null, savedAlvo: null };
}
}
/* Monta bloco textual contextualizado com snapshot atual, alvo, gaps, metas, status.
Usado no contexto da geração de talking points (Preparo de Reunião) e no PDF.
Segue o mesmo padrão do buildClientContextBlock do AdvisorChat. */
function buildMeetingClientContextBlock(client, latestAtual, savedAlvo) {
if (!client || !latestAtual) return "";
var d = latestAtual.data || {};
var alloc = d.alocacao || {};
var ativos = d.ativos || [];
var reserva = d.reserva;
var patrAtual = d.patrimonio_total || 0;
var target = resolveTarget(savedAlvo, client.jbData);
var CLASS_LABELS_M = {
renda_fixa: "Renda Fixa", acoes_br: "Acoes BR", fiis: "FIIs",
internacional: "Internacional", alternativos: "Alternativos", caixa: "Caixa"
};
var INDEXADOR_LABELS_M = { pos_fixado: "Pos (CDI)", ipca: "IPCA+", prefixado: "Prefixado",
var lines = [];
lines.push("\n=== CONTEXTO DO CLIENTE (SNAPSHOT " + latestAtual.snapshot_date + ") ===");
// Metas
if (target && target.metas) {
var mt = target.metas;
if (mt.capitalAlvo) lines.push("Patrimonio-alvo: R$ " + mt.capitalAlvo.toLocaleString("pt
if (mt.rendaPassivaMeta) lines.push("Renda passiva projetada: R$ " + mt.rendaPassivaMeta.
if (mt.aporteMensalNecessario) lines.push("Aporte mensal previsto: R$ " + mt.aporteMensal
if (mt.idadeAposentadoria) lines.push("Idade de aposentadoria: " + mt.idadeAposentadoria
if (mt.capitalAlvo && patrAtual > 0) {
var progress = +((patrAtual / mt.capitalAlvo) * 100).toFixed(1);
lines.push("Progresso ate o alvo: " + progress + "%");
}
}
lines.push("Patrimonio atual: R$ " + patrAtual.toLocaleString("pt-BR", {maximumFractionDigi
// Gaps macro
var gapsMacro = [];
Object.keys(alloc).forEach(function(cls){
var a = alloc[cls]; if (!a || a.pct <= 0) return;
var tgt = target && target.allocMacro ? (target.allocMacro[cls] || 0) : 0;
if (tgt <= 0) return;
var gap = +(a.pct - tgt).toFixed(2);
gapsMacro.push({cls: cls, curPct: a.pct, tgtPct: tgt, gap: gap, absGap: Math.abs(gap)});
});
// Classes com alvo mas sem posicao
if (target && target.allocMacro) {
Object.keys(target.allocMacro).forEach(function(cls){
var tgt = target.allocMacro[cls]; if (tgt <= 0) return;
if (alloc[cls] && alloc[cls].pct > 0) return;
gapsMacro.push({cls: cls, curPct: 0, tgtPct: tgt, gap: -tgt, absGap: tgt});
});
}
gapsMacro.sort(function(a,b){return b.absGap - a.absGap;});
if (gapsMacro.length > 0) {
lines.push("\nGAPS POR CLASSE (atual vs alvo, ordenados por magnitude):");
gapsMacro.forEach(function(g){
var arrow = g.gap > 0 ? "acima" : "abaixo";
lines.push(" - " + CLASS_LABELS_M[g.cls] + ": " + g.curPct.toFixed(1) + "% vs alvo " +
});
}
// Gaps por indexador RF
var ixTotals = {};
ativos.forEach(function(at){
if (at.classe === "renda_fixa" && at.subclasse) {
ixTotals[at.subclasse] = (ixTotals[at.subclasse] || 0) + (at.pct_total || 0);
}
});
var gapsIx = [];
Object.keys(ixTotals).forEach(function(ix){
var atPct = +ixTotals[ix].toFixed(2);
var tgt = target && target.allocIndexadoresRF ? (target.allocIndexadoresRF[ix] || 0) : 0;
if (tgt > 0 || atPct > 0) {
var gap = +(atPct - tgt).toFixed(2);
gapsIx.push({ix: ix, atPct: atPct, tgtPct: tgt, gap: gap, absGap: Math.abs(gap)});
}
});
gapsIx.sort(function(a,b){return b.absGap - a.absGap;});
if (gapsIx.length > 0) {
lines.push("\nGAPS POR INDEXADOR RF:");
gapsIx.forEach(function(g){
var arrow = g.gap > 0 ? "acima" : "abaixo";
var s = " - " + (INDEXADOR_LABELS_M[g.ix] || g.ix) + ": " + g.atPct.toFixed(1) + "%";
if (g.tgtPct > 0) s += " vs alvo " + g.tgtPct.toFixed(1) + "% (" + arrow + " em " + g.a
lines.push(s);
});
}
// Reserva
if (reserva && (reserva.meses_cobertos !== null || reserva.meses_alvo !== null)) {
var resBits = [];
if (reserva.meses_cobertos !== null) resBits.push(reserva.meses_cobertos + " meses cobert
if (reserva.meses_alvo !== null) resBits.push("alvo " + reserva.meses_alvo + " meses");
lines.push("\nReserva: " + resBits.join(", ") + " (" + (reserva.dentro_da_rf ? "dentro da
}
// Ativos com status especial (prioridade: reducao, em_avaliacao)
var ativosReducao = ativos.filter(function(a){return a.status_recomendacao==="reducao";});
var ativosEmAv = ativos.filter(function(a){return a.status_recomendacao==="em_avaliacao";})
if (ativosReducao.length > 0) {
lines.push("\nATIVOS EM REDUCAO (prioridade de saida):");
ativosReducao.forEach(function(a){
lines.push(" - " + (a.ticker||a.nome_original) + " (" + (a.pct_total||0).toFixed(1) +
});
}
if (ativosEmAv.length > 0) {
lines.push("\nATIVOS EM AVALIACAO:");
ativosEmAv.forEach(function(a){
lines.push(" - " + (a.ticker||a.nome_original) + " (" + (a.pct_total||0).toFixed(1) +
});
}
// Ativos fora de carteira Suno (so RV)
var foraDeCarteira = ativos.filter(function(a){
return (!a.carteiras_suno || a.carteiras_suno.length === 0) && a.classe !== "renda_fixa"
});
if (foraDeCarteira.length > 0 && foraDeCarteira.length <= 15) {
lines.push("\nATIVOS FORA DA CARTEIRA SUNO:");
foraDeCarteira.forEach(function(a){
lines.push(" - " + (a.ticker||a.nome_original) + " (" + (a.pct_total||0).toFixed(1) +
});
}
lines.push("=== FIM DO CONTEXTO DO CLIENTE ===\n");
return lines.join("\n");
}
// Monta alvo editável inicial: se tem alvo salvo usa, senão parte do JB.
// Estrutura semelhante mas com campos de ativos como array pra UI de edição.
function buildEditableTarget(savedAlvo, jbData) {
var resolved = resolveTarget(savedAlvo, jbData);
if (!resolved) return null;
// Converte allocAtivos { ticker: pct } em array [{ticker, classe, subclasse, pct}]
var allTickers = Object.keys(resolved.allocAtivos || {});
var ativos = allTickers.map(function(tk){
// Tenta descobrir classe/subclasse pelo catálogo
var meta = lookupTicker(tk);
return {
ticker: tk,
classe: meta ? meta.classe : null,
subclasse: meta ? meta.subclasse : null,
setor: meta ? meta.setor : null,
pct: resolved.allocAtivos[tk] || 0,
};
});
return {
allocMacro: Object.assign({renda_fixa:0,acoes_br:0,fiis:0,internacional:0,alternativos:0,
allocIndexadoresRF: Object.assign({pos_fixado:0,ipca:0,prefixado:0,fundo_rf:0}, resolved.
ativos: ativos,
objetivos: Object.assign({capitalAlvo:null,rendaPassivaMeta:null,aporteMensalNecessario:n
reserva: (savedAlvo && savedAlvo.data && savedAlvo.data.reserva) || null,
};
}
// Retorna número positivo (acima) ou negativo (abaixo).
function pctGap(atual, alvo) {
return +((atual || 0) - (alvo || 0)).toFixed(2);
}
// Classifica intensidade do gap pra UX
function gapLevel(gap) {
var abs = Math.abs(gap);
if (abs < 3) return "ok"; if (abs < 8) return "warn"; // dentro da tolerância
// moderado
return "critical"; // forte
}
// Cores padrão pros níveis de gap
var GAP_COLORS = {
ok: "#4ade80",
warn: "#fbbf24",
critical: "#f87171",
neutral: "rgba(255,255,255,0.3)"
};
// Cores e labels padrão pras classes
var M3_CLASS_COLORS = {
renda_fixa: "#3b82f6", acoes_br: "#DC2626", fiis: "#f59e0b",
internacional: "#8b5cf6", alternativos: "#10b981", caixa: "#6b7280", unknown: "#ef4444"
};
var M3_CLASS_LABELS = {
renda_fixa: "Renda Fixa", acoes_br: "Ações BR", fiis: "FIIs",
internacional: "Internacional", alternativos: "Alternativos", caixa: "Caixa", unknown: "Não
};
var M3_INDEXADOR_LABELS = {pos_fixado:"Pós (CDI)", ipca:"IPCA+", prefixado:"Prefixado", fundo
/* ─── SnapshotOverview: painel inline com metas + comparação atual vs alvo ─── */
function SnapshotOverview(p) {
var snapshot = p.snapshot; // último snapshot 'atual' (já decoded)
var target = p.target; // resultado de resolveTarget (prioriza alvo salvo, c
var onOpenSnapshot = p.onOpenSnapshot; // callback pra abrir modal de detalhe
var onEditTarget = p.onEditTarget; // callback pra abrir editor de alvo
var onOpenGapDetail = p.onOpenGapDetail; // NEW: callback pra abrir modal de detalhamento p
var targetIsSaved = p.targetIsSaved; // true se o target vem de um snapshot salvo (não JB
if (!snapshot || !target) return null;
var alloc = snapshot.alocacao || {};
var metas = target.metas || {};
var patr = snapshot.patrimonio_total || 0;
// Progresso até a meta de patrimônio
var progressPct = metas.capitalAlvo ? Math.min(100, +((patr / metas.capitalAlvo) * 100).toF
var falta = metas.capitalAlvo ? Math.max(0, metas.capitalAlvo - patr) : null;
// Ordem de exibição das classes
var CLASS_ORDER = ["renda_fixa","acoes_br","fiis","internacional","alternativos","caixa"];
// Monta linhas comparativas (atual vs alvo)
var rows = CLASS_ORDER.map(function(cls){
var curPct = alloc[cls] ? alloc[cls].pct : 0;
var curVal = alloc[cls] ? alloc[cls].valor : 0;
var tgtPct = target.allocMacro[cls] || 0;
var gap = pctGap(curPct, tgtPct);
var level = gap === 0 ? "neutral" : gapLevel(gap);
return {
cls: cls, label: M3_CLASS_LABELS[cls], color: M3_CLASS_COLORS[cls],
curPct: curPct, curVal: curVal, tgtPct: tgtPct, gap: gap, level: level
};
});
return (
<div style={{marginTop:"18px",paddingTop:"16px",borderTop:"1px solid rgba(255,255,255,0.0
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBo
<div style={{fontSize:"10px",fontWeight:700,color:"#60a5fa",textTransform:"uppercase"
<div style={{display:"flex",alignItems:"center",gap:"8px"}}>
<span style={{fontSize:"9px",color:"rgba(255,255,255,0.35)",textTransform:"uppercas
{targetIsSaved ? "Alvo: editado manualmente" : "Alvo: derivado do JB"}
</span>
{onEditTarget && (
<button onClick={onEditTarget} style={{padding:"5px 11px",borderRadius:"6px",bord
{targetIsSaved ? "✎ Editar alvo" : "✎ Personalizar alvo"}
</button>
)}
</div>
</div>
{/* ─── Hero: metas do JB + progresso ─── */}
<div style={{background:"linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))
<div>
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"uppercas
<div style={{fontSize:"16px",fontWeight:800,color:"#f1f5f9"}}>R$ {patr.toLocaleSt
</div>
{metas.capitalAlvo && (
<div>
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"upperc
<div style={{fontSize:"16px",fontWeight:800,color:"#60a5fa"}}>R$ {metas.capital
</div>
)}
{metas.rendaPassivaMeta && (
<div>
</div>
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"upperc
<div style={{fontSize:"16px",fontWeight:800,color:"#4ade80"}}>R$ {metas.rendaPa
)}
{metas.aporteMensalNecessario && (
<div>
</div>
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"upperc
<div style={{fontSize:"14px",fontWeight:700,color:"rgba(255,255,255,0.75)"}}>R$
)}
{metas.idadeAposentadoria && (
<div>
</div>
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"upperc
<div style={{fontSize:"14px",fontWeight:700,color:"rgba(255,255,255,0.75)"}}>{m
)}
</div>
{progressPct !== null && (
<div style={{marginTop:"10px"}}>
<div style={{display:"flex",justifyContent:"space-between",fontSize:"10px",color:
<span>Progresso até o alvo</span>
<span style={{fontWeight:700,color:"#60a5fa"}}>{progressPct}% {falta > 0 </div>
&& " ·
<div style={{height:"8px",borderRadius:"4px",background:"rgba(255,255,255,0.05)",
<div style={{width:progressPct+"%",height:"100%",background:"linear-gradient(90
</div>
</div>
)}
</div>
{/* ─── Bloco macro: atual vs alvo por classe (DESTAQUE) ─── */}
<div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.0
<div style={{fontSize:"11px",fontWeight:800,color:"#fff",marginBottom:"12px",display:
<span>Alocação por Classe · Atual vs Alvo (JB)</span>
<span style={{fontSize:"9px",color:"rgba(255,255,255,0.35)",fontWeight:500,textTran
</div>
<div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
{rows.map(function(r){
var gapColor = GAP_COLORS[r.level];
var arrow = r.gap > 0 ? "▲" : (r.gap < 0 ? "▼" : "●");
// Normaliza barras pra mesma escala (max entre atual e alvo, pelo menos 30%)
var maxBar = Math.max(r.curPct, r.tgtPct, 30);
var curW = (r.curPct / maxBar) * 100;
var tgtW = (r.tgtPct / maxBar) * 100;
var clickable = !!onOpenGapDetail && r.cls !== "caixa";
return <div key={r.cls} onClick={clickable ? function(){ onOpenGapDetail(r.cls);
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
<div style={{display:"flex",alignItems:"center",gap:"6px"}}>
<div style={{width:"10px",height:"10px",borderRadius:"3px",background:r.col
<div style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9"}}>{r.label}{cli
</div>
<div style={{display:"flex",gap:"10px",alignItems:"center",fontSize:"10px",fo
<span style={{color:"rgba(255,255,255,0.8)",fontWeight:700}}>{r.curPct.toFi
<span style={{color:"rgba(255,255,255,0.35)"}}>alvo {r.tgtPct.toFixed(1)}%<
{r.tgtPct > 0 && <span style={{color:gapColor,fontWeight:700,minWidth:"64px
{r.tgtPct === 0 && r.curPct > 0 && <span style={{color:"rgba(255,255,255,0.
</div>
</div>
{/* Barra dupla: atual em cima, alvo embaixo em linha tracejada */}
<div style={{position:"relative",height:"18px"}}>
<div style={{position:"absolute",top:0,left:0,height:"12px",width:curW+"%",ba
<div style={{position:"absolute",top:"13px",left:0,height:"3px",width:tgtW+"%
</div>
</div>;
})}
</div>
{/* Reserva */}
{snapshot.reserva && (snapshot.reserva.meses_cobertos !== null || snapshot.reserva.me
<div style={{marginTop:"14px",paddingTop:"12px",borderTop:"1px dashed rgba(255,255,
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.6)",fontWeight:600}}>Res
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.75)",fontVariantNumeric:
{snapshot.reserva.meses_cobertos !== null && <span style={{fontWeight:700,col
{snapshot.reserva.meses_alvo !== null && <span style={{color:"rgba(255,255,25
<span style={{color:"rgba(255,255,255,0.35)",fontSize:"9px",marginLeft:"6px"}
</div>
</div>
</div>
)}
</div>
{/* Bloco "Gaps por ativo" removido — funcionalidade duplicada com o gráfico de alocaçã
por classe acima, que já abre o mesmo detalhamento ao clicar numa classe. */}
</div>
);
}
/* ─── SnapshotTimeline: régua horizontal + sparklines por classe ─── */
function SnapshotTimeline(p) {
var snapshots = (p.snapshots || []).slice(); // todos os snapshots do cliente
var target = p.target;
var onOpenSnapshot = p.onOpenSnapshot;
var collapsed = !!p.collapsed; // se true, mostra só o header
var onToggle = p.onToggle; // callback pra alternar collapsed
// Modo do gráfico de RF por indexador: "classe" (% dentro da RF, padrão) ou "carteira" (%
var [rfIndexMode, setRfIndexMode] = useState("classe");
if (snapshots.length === 0) return null;
// Ordena por data crescente (timeline evolutiva)
snapshots.sort(function(a,b){ return (a.snapshot_date||"").localeCompare(b.snapshot_date||"
// Só snapshots do tipo 'atual' vão nas sparklines (consistente temporalmente)
var atuais = snapshots.filter(function(s){ return s.tipo === "atual"; });
var CLASSES_SPARK = ["renda_fixa","acoes_br","fiis","internacional","alternativos"];
var INDEX_SPARK = ["pos_fixado","ipca","prefixado","fundo_rf"];
return (
<div style={{marginTop:"18px",paddingTop:"16px",borderTop:"1px solid rgba(255,255,255,0.0
<div onClick={onToggle} style={{display:"flex",justifyContent:"space-between",alignItem
<div style={{fontSize:"10px",fontWeight:700,color:"#60a5fa",textTransform:"uppercase"
{collapsed && <span style={{fontSize:"9px",color:"rgba(255,255,255,0.35)"}}>{snapshot
</div>
{!collapsed && (<>
{/* Régua horizontal */}
<div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.0
<div style={{position:"relative",height:"40px"}}>
<div style={{position:"absolute",left:0,right:0,top:"19px",height:"2px",background:
{snapshots.map(function(s,i){
var tipoColors = {inicial:"#8b5cf6", alvo:"#10b981", atual:"#60a5fa"};
var tc = tipoColors[s.tipo] || "#888";
var xPct = snapshots.length === 1 ? 50 : (i / (snapshots.length - 1)) * 100;
var patr = (s.data && s.data.patrimonio_total) || 0;
// Formato dd.mm.aaaa a partir de ISO yyyy-mm-dd
var dateFmt = (function(iso){
if (!iso || typeof iso !== "string") return "";
var parts = iso.slice(0,10).split("-");
if (parts.length !== 3) return iso;
return parts[2] + "." + parts[1] + "." + parts[0];
})(s.snapshot_date);
return <div key={s.id} style={{position:"absolute",left:"calc("+xPct+"% - 10px)",
<div style={{width:"20px",height:"20px",borderRadius:"50%",background:tc,border
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.5)",textAlign:"center",ma
</div>;
})}
</div>
<div style={{display:"flex",gap:"14px",marginTop:"18px",fontSize:"10px",justifyConten
{[{t:"inicial",l:"Inicial",c:"#8b5cf6"},{t:"alvo",l:"Alvo",c:"#10b981"},{t:"atual",
var count = snapshots.filter(function(s){return s.tipo===tt.t;}).length;
if (count === 0) return null;
return <div key={tt.t} style={{display:"flex",alignItems:"center",gap:"5px",color
<div style={{width:"8px",height:"8px",borderRadius:"50%",background:tt.c}}></di
{tt.l} ({count})
</div>;
})}
</div>
</div>
{/* Sparklines por classe */}
{atuais.length >= 1 && (
<div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.5)",marginBottom:"10px",font
Evolução por classe · linha cinza pontilhada = alvo (JB)
{atuais.length < 3 && <span style={{marginLeft:"8px",fontSize:"9px",color:"rgba(2
</div>
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(170px, 1fr
{CLASSES_SPARK.map(function(cls){
var color = M3_CLASS_COLORS[cls];
var tgt = target && target.allocMacro ? (target.allocMacro[cls] || 0) : 0;
var vals = atuais.map(function(s){
var a = s.data && s.data.alocacao && s.data.alocacao[cls];
return a ? a.pct : 0;
});
var allVals = vals.concat([tgt]);
var maxY = Math.max.apply(null, allVals.concat([5]));
var minY = 0;
var W = 150, H = 40;
var pts = vals.map(function(v,i){
var x = vals.length === 1 ? W/2 : (i / (vals.length - 1)) * W;
var y = H - ((v - minY) / (maxY - minY || 1)) * H;
return x.toFixed(1)+","+y.toFixed(1);
}).join(" ");
var tgtY = H - ((tgt - minY) / (maxY - minY || 1)) * H;
var last = vals[vals.length - 1] || 0;
var gap = pctGap(last, tgt);
var level = gap === 0 ? "neutral" : gapLevel(gap);
return <div key={cls} style={{padding:"8px 10px",background:"rgba(0,0,0,0.2)",b
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center
<div style={{display:"flex",alignItems:"center",gap:"5px"}}>
<div style={{width:"7px",height:"7px",borderRadius:"2px",background:color
<div style={{fontSize:"10px",color:"#f1f5f9",fontWeight:700}}>{M3_CLASS_L
</div>
<div style={{fontSize:"9px",color:GAP_COLORS[level],fontWeight:700,fontVari
</div>
<svg width={W} height={H} style={{display:"block"}}>
{/* Linha alvo */}
<line x1={0} y1={tgtY} x2={W} y2={tgtY} stroke="rgba(255,255,255,0.35)" str
{/* Linha da evolução */}
{vals.length > 1 && <polyline points={pts} fill="none" stroke={color} strok
{/* Pontos */}
{vals.map(function(v,i){
var x = vals.length === 1 ? W/2 : (i / (vals.length - 1)) * W;
var y = H - ((v - minY) / (maxY - minY || 1)) * H;
return <circle key={i} cx={x} cy={y} r="2.5" fill={color}/>;
})}
</svg>
</div>;
})}
</div>
{/* Sparklines por indexador dentro de Renda Fixa */}
<div style={{marginTop:"14px",paddingTop:"12px",borderTop:"1px dashed rgba(255,255,
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",ma
<div style={{fontSize:"10px",color:"rgba(96,165,250,0.75)",fontWeight:600,textT
<div style={{display:"flex",gap:"4px"}}>
{[{k:"classe",l:"% da RF",d:"Quanto cada indexador representa dentro da class
var isSel = rfIndexMode === opt.k;
return <button key={opt.k} onClick={function(){ setRfIndexMode(opt.k); }} t
style={{padding:"4px 10px",fontSize:"9px",fontWeight:700,borderRadius:"5p
{opt.l}
</button>;
})}
</div>
</div>
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(170px, 1
{INDEX_SPARK.map(function(ix){
var color = M3_CLASS_COLORS.renda_fixa;
// Alvo do indexador no modo selecionado:
// - carteira: direto do target (% do patrimônio total)
// - classe: reescala pro total da classe RF
var tgtCarteira = target && target.allocIndexadoresRF ? (target.allocIndexado
var tgtClasseTotal = 0;
if (target && target.allocIndexadoresRF) {
Object.keys(target.allocIndexadoresRF).forEach(function(k){ tgtClasseTotal
}
var tgt = rfIndexMode === "carteira"
? tgtCarteira
: (tgtClasseTotal > 0 ? +((tgtCarteira / tgtClasseTotal) * 100).toFixed(2)
// Valor atual por snapshot no modo selecionado
var vals = atuais.map(function(s){
var d = s.data || {};
var ativos = d.ativos || [];
var sumIx = 0, sumRF = 0;
ativos.forEach(function(a){
if (a.classe !== "renda_fixa") return;
var pct = a.pct_total || 0;
sumRF += pct;
// Usa canonicalizeRFSubclasse pra também capturar ativos com subclasse
// inválida (ex: "estruturado" salvo pela IA) ou vazia
if (canonicalizeRFSubclasse(a) === ix) sumIx += pct;
});
if (rfIndexMode === "carteira") return +sumIx.toFixed(2);
return sumRF > 0 ? +((sumIx / sumRF) * 100).toFixed(2) : 0;
});
var allVals = vals.concat([tgt]);
var maxY = Math.max.apply(null, allVals.concat([5]));
var minY = 0;
var W = 150, H = 40;
var pts = vals.map(function(v,i){
var x = vals.length === 1 ? W/2 : (i / (vals.length - 1)) * W;
var y = H - ((v - minY) / (maxY - minY || 1)) * H;
return x.toFixed(1)+","+y.toFixed(1);
}).join(" ");
var tgtY = H - ((tgt - minY) / (maxY - minY || 1)) * H;
var last = vals[vals.length - 1] || 0;
var gap = pctGap(last, tgt);
var level = gap === 0 ? "neutral" : gapLevel(gap);
return <div key={ix} style={{padding:"8px 10px",background:"rgba(0,0,0,0.2)",
<div style={{display:"flex",justifyContent:"space-between",alignItems:"cent
<div style={{fontSize:"10px",color:"#f1f5f9",fontWeight:700}}>{M3_INDEXAD
<div style={{fontSize:"9px",color:GAP_COLORS[level],fontWeight:700,fontVa
</div>
<svg width={W} height={H} style={{display:"block"}}>
<line x1={0} y1={tgtY} x2={W} y2={tgtY} stroke="rgba(255,255,255,0.35)" s
{vals.length > 1 && <polyline points={pts} fill="none" stroke={color} str
{vals.map(function(v,i){
var x = vals.length === 1 ? W/2 : (i / (vals.length - 1)) * W;
var y = H - ((v - minY) / (maxY - minY || 1)) * H;
return <circle key={i} cx={x} cy={y} r="2.5" fill={color}/>;
})}
</svg>
</div>;
})}
</div>
</div>
</div>
)}
</>)}
</div>
);
}
/* ─── SnapshotViewerModal: visualização e edição de um snapshot ───
Modo edição permite alterar: classe, subclasse (para RF), status, valor.
Ticker, nome, pct (calculado) são read-only.
Apenas o snapshot 'atual' mais recente pode ser editado. */
function SnapshotViewerModal(p) {
var snapshot = p.snapshot;
var target = p.target;
var onClose = p.onClose;
var onSaved = p.onSaved;
if (!snapshot) return null;
var isLatestAtual = p.isLatestAtual;
// Q1(b): todos os tipos editáveis via viewer. Alvo também pode ser editado pelo M4 (mais r
// mas o viewer permite ajustes granulares em qualquer tipo.
var canEdit = true;
var [editMode, setEditMode] = useState(false);
var [editedAtivos, setEditedAtivos] = useState(null); // array quando em edição
var [editedDate, setEditedDate] = useState(null); // data editada quando em modo edição
var [saving, setSaving] = useState(false);
var [saveError, setSaveError] = useState("");
var data = snapshot.data || {};
var ativosBase = data.ativos || [];
// Se em edição, usa editedAtivos, senão o original
var ativos = editMode && editedAtivos ? editedAtivos : ativosBase;
// Recalcula pct_total baseado nos valores (pra refletir edições)
var patrTotal = ativos.reduce(function(s,a){ return s + (a.valor || 0); }, 0);
ativos.forEach(function(a){ a.pct_total = patrTotal > 0 ? (a.valor / patrTotal) * 100 : 0;
// Recalcula alocação por classe
var alloc = {};
ativos.forEach(function(a){
var cls = a.classe || "unknown";
if (!alloc[cls]) alloc[cls] = {valor: 0, pct: 0};
alloc[cls].valor += (a.valor || 0);
Object.keys(alloc).forEach(function(cls){
alloc[cls].pct = patrTotal > 0 ? (alloc[cls].valor / patrTotal) * 100 : 0;
});
});
// Agrupa ativos por classe (e RF por indexador)
var CLASS_ORDER = ["renda_fixa","caixa","acoes_br","fiis","internacional","alternativos","u
var grouped = {};
ativos.forEach(function(a){
var cls = a.classe || "unknown";
if (!grouped[cls]) grouped[cls] = {};
if (cls === "renda_fixa") {
var ix = canonicalizeRFSubclasse(a);
if (!grouped[cls][ix]) grouped[cls][ix] = [];
grouped[cls][ix].push(a);
} else {
if (!grouped[cls]["_"]) grouped[cls]["_"] = [];
grouped[cls]["_"].push(a);
}
});
var overlayS = {position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",zIndex:2100,display:
var modalS = {background:"#0a0a0a",border:"1px solid rgba(255,255,255,0.08)",borderRadius:"
var tipoColors = {inicial:"#8b5cf6", alvo:"#10b981", atual:"#60a5fa"};
var tipoLabels = {inicial:"Inicial", alvo:"Alvo", atual:"Atual"};
var tc = tipoColors[snapshot.tipo] || "#888";
var STATUS_COLORS = {core:"#4ade80", manter:"#fbbf24", em_avaliacao:"#fb923c", reducao:"#f8
var STATUS_LABELS = {core:"Core", manter:"Manter", em_avaliacao:"Em avaliação", reducao:"Re
var STATUS_TOOLTIPS = {
core: "Core: posição estratégica de longo prazo, mantida independente de conjuntura.",
manter: "Manter: posição alinhada com o plano, sem ajustes no momento.",
em_avaliacao: "Em avaliação: posição sob análise, pode virar redução ou manter.",
reducao: "Redução: posição deve ser reduzida ou encerrada no próximo ciclo."
};
var CLASSES_EDITAVEIS = ["renda_fixa","acoes_br","fiis","internacional","alternativos","cai
var CLASSES_LABELS = {renda_fixa:"Renda Fixa", acoes_br:"Ações BR", fiis:"FIIs", internacio
var INDEXADORES = {pos_fixado:"Pós-fixado", ipca:"IPCA+", prefixado:"Prefixado", fundo_rf:"
function startEdit() {
// Clona os ativos (deep) pra editar sem mutar o snapshot original até salvar
var clone = ativosBase.map(function(a){ return Object.assign({}, a); });
setEditedAtivos(clone);
setEditedDate(snapshot.snapshot_date);
setEditMode(true);
setSaveError("");
}
function cancelEdit() {
setEditedAtivos(null);
setEditedDate(null);
setEditMode(false);
setSaveError("");
}
function updateAtivo(idx, field, value) {
setEditedAtivos(function(prev){
var next = prev.slice();
next[idx] = Object.assign({}, next[idx]);
next[idx][field] = value;
// Se mudou classe pra algo diferente de renda_fixa, limpa subclasse
if (field === "classe" && value !== "renda_fixa") next[idx].subclasse = null;
// Se mudou classe pra renda_fixa e não tem subclasse, default pos_fixado
if (field === "classe" && value === "renda_fixa" && !next[idx].subclasse) next[idx].sub
return next;
});
}
async function saveEdits() {
setSaving(true); setSaveError("");
try {
var isAlvo = snapshot.tipo === "alvo";
var ativosFinais, newAlloc, newPatr;
if (isAlvo) {
// ALVO: pct_total é a fonte de verdade (vem do JB ou editado manualmente pelo // Valor em R$ é secundário — pode ser 0 mesmo, não afeta a funcionalidade do alvo po
// A soma dos pct da classe preenche `alocacao[cls].pct` (a macro-alocação por consul
classe
ativosFinais = editedAtivos.map(function(a){
return Object.assign({}, a, {
valor: Number(a.valor) || 0,
pct_total: Number(a.pct_total) || 0,
});
});
newPatr = ativosFinais.reduce(function(s,a){ return s + (a.valor || 0); }, 0);
newAlloc = {};
ativosFinais.forEach(function(a){
var cls = a.classe || "unknown";
if (!newAlloc[cls]) newAlloc[cls] = {valor: 0, pct: 0};
newAlloc[cls].valor += a.valor;
newAlloc[cls].pct += a.pct_total || 0;
});
} else {
// Outros tipos (inicial, atual): valor em R$ é a fonte de verdade; pct derivado.
newPatr = editedAtivos.reduce(function(s,a){ return s + (Number(a.valor) || 0); }, 0)
ativosFinais = editedAtivos.map(function(a){
return Object.assign({}, a, {
valor: Number(a.valor) || 0,
pct_total: newPatr > 0 ? (Number(a.valor) / newPatr) * 100 : 0,
});
});
newAlloc = {};
ativosFinais.forEach(function(a){
var cls = a.classe || "unknown";
if (!newAlloc[cls]) newAlloc[cls] = {valor: 0, pct: 0};
newAlloc[cls].valor += a.valor;
});
Object.keys(newAlloc).forEach(function(cls){
newAlloc[cls].pct = newPatr > 0 ? (newAlloc[cls].valor / newPatr) * 100 : 0;
});
}
var newData = Object.assign({}, data, {
ativos: ativosFinais,
alocacao: newAlloc,
patrimonio_total: newPatr,
});
// Update no Supabase (inclui snapshot_date se foi editada)
var updatePayload = {data: newData};
if (editedDate && editedDate !== snapshot.snapshot_date) {
updatePayload.snapshot_date = editedDate;
}
var res = await supabase.from("client_snapshots").update(updatePayload).eq("id", if (res.error) throw new Error(res.error.message);
snapsh
// Atualiza o snapshot em memória
snapshot.data = newData;
if (editedDate) snapshot.snapshot_date = editedDate;
setEditMode(false); setEditedAtivos(null); setEditedDate(null);
if (onSaved) onSaved();
} catch(e) {
console.error("[snapshot edit] erro:", e);
setSaveError("Erro ao salvar: " + e.message);
}
setSaving(false);
}
var inputMiniS = {padding:"3px 6px",fontSize:10,borderRadius:4,border:"1px solid rgba(255,2
return (
<div style={overlayS} onClick={function(e){if(e.target===e.currentTarget && !editMode)onC
<div style={modalS}>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin
<div>
<div style={{display:"flex",alignItems:"center",gap:"10px"}}>
<span style={{fontSize:"9px",padding:"3px 10px",borderRadius:"10px",background:
{editMode ? (
<div style={{display:"flex",alignItems:"center",gap:"8px"}}>
<span style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>Snapshot <input
type="date"
value={editedDate || snapshot.snapshot_date}
onChange={function(e){ setEditedDate(e.target.value); }}
style={{padding:"4px 8px",borderRadius:6,border:"1px solid rgba(251,191,3
de</sp
/>
</div>
) : (
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>Snapshot de {snaps
)}
{editMode && <span style={{fontSize:"9px",padding:"3px 9px",borderRadius:"10px"
</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginTop:"4px"}}>R$ {
</div>
<div style={{display:"flex",alignItems:"center",gap:"8px"}}>
{canEdit && !editMode && <button onClick={startEdit} style={{padding:"6px 12px",b
{editMode && (function(){
// Botão "Auto-classificar RF" — só aparece em edit mode
function doAutoClassify() {
if (!editedAtivos || !Array.isArray(editedAtivos)) return;
var updated = editedAtivos.slice();
var countNew = 0, countOverrideSkipped = 0;
updated.forEach(function(a, idx){
if (a.classe !== "renda_fixa") return;
var inferred = inferSubclasseRF(a.nome_original || a.ticker || "");
if (!inferred) return;
if (!a.subclasse) {
updated[idx] = Object.assign({}, a, {subclasse: inferred});
countNew++;
} else if (a.subclasse !== inferred) {
// Já tem subclasse diferente: mantém (consultor editou manualmente)
countOverrideSkipped++;
}
});
if (countNew === 0 && countOverrideSkipped === 0) {
alert("Nenhum ativo de RF precisava classificar — todos já estão com return;
subcla
}
setEditedAtivos(updated);
var msg = countNew + " ativo(s) classificados automaticamente.";
if (countOverrideSkipped > 0) msg += " " + countOverrideSkipped + " já alert(msg);
tinha
}
return <button onClick={doAutoClassify} disabled={saving} title="Preenche a sub
})()}
{editMode && (function(){
// Botão "+ Adicionar ativo" — permite criar ativos do zero.
// Crítico pro caso ALVO vazio (clientes com Asset Alloc sem JB real):
// consultor adiciona os tickers do JB PDF manualmente pra habilitar alvo por a
function addNovoAtivo() {
var novo = {
id: "novo_" + Date.now(),
ticker: "",
nome_original: "",
classe: "acoes_br",
subclasse: null,
setor: null,
segmento: null,
intl: false,
classificacao_fonte: "manual",
precisa_revisao: false,
valor: 0,
pct_total: 0,
pct_classe: 0,
corretoras: [],
carteiras_suno: [],
status_recomendacao: snapshot.tipo === "alvo" ? "core" : "manter",
};
var next = (editedAtivos || []).concat([novo]);
setEditedAtivos(next);
}
return <button onClick={addNovoAtivo} disabled={saving} title="Adiciona um ativ
})()}
{editMode && <button onClick={cancelEdit} disabled={saving} style={{padding:"6px
{editMode && <button onClick={saveEdits} disabled={saving} style={{padding:"6px 1
<button onClick={onClose} style={{background:"transparent",border:"none",color:"r
</div>
</div>
{saveError && <div style={{background:"rgba(248,113,113,0.1)",border:"1px solid rgba(
{/* Banner pra snapshot ALVO vazio: aponta pro usuário que pode editar manualmente */
{snapshot.tipo === "alvo" && ativos.length === 0 && !editMode && (
<div style={{background:"rgba(16,185,129,0.06)",border:"1px solid rgba(16,185,129,0
<div style={{display:"flex",gap:"10px",alignItems:"flex-start"}}>
<span style={{fontSize:"14px",color:"#10b981"}}> </span>
<div style={{flex:1}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#10b981",marginBottom:"4px
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.6)",lineHeight:1.5}}>E
</div>
</div>
</div>
)}
{/* Legenda de status */}
<div style={{display:"flex",flexWrap:"wrap",gap:"10px",padding:"8px 12px",background:
<span style={{fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.4)",letterSpacing
{Object.keys(STATUS_LABELS).map(function(s){
var c = STATUS_COLORS[s];
return <span key={s} title={STATUS_TOOLTIPS[s]} style={{display:"inline-flex",ali
<span style={{width:8,height:8,borderRadius:2,background:c}}></span>
<b style={{color:c}}>{STATUS_LABELS[s]}</b>
</span>;
})}
</div>
{/* Barra alocação */}
<div style={{display:"flex",height:28,borderRadius:7,overflow:"hidden",border:"1px so
{Object.keys(alloc).map(function(cls){
var a = alloc[cls];
if (!a || a.pct <= 0) return null;
var color = M3_CLASS_COLORS[cls] || "#888";
return <div key={cls} style={{width:a.pct+"%",background:color,display:"flex",ali
})}
</div>
<div style={{display:"flex",flexWrap:"wrap",gap:10,fontSize:10,marginBottom:14}}>
{Object.keys(alloc).map(function(cls){
var a = alloc[cls]; if (!a || a.pct <= 0) return null;
var color = M3_CLASS_COLORS[cls] || "#888";
return <div key={cls} style={{display:"flex",alignItems:"center",gap:4,color:"rgb
<div style={{width:8,height:8,borderRadius:2,background:color}}></div>
{M3_CLASS_LABELS[cls]} {a.pct.toFixed(1)}%
</div>;
})}
</div>
{/* Reserva */}
{data.reserva && (data.reserva.meses_cobertos !== null || data.reserva.meses_alvo !==
<div style={{background:"rgba(74,222,128,0.05)",border:"1px solid rgba(74,222,128,0
<span style={{color:"rgba(255,255,255,0.65)",fontWeight:600}}>Reserva de emergênc
<span style={{color:"rgba(255,255,255,0.8)",fontVariantNumeric:"tabular-nums"}}>
{data.reserva.meses_cobertos !== null && <span style={{fontWeight:700,color:"#4
{data.reserva.meses_alvo !== null && <span style={{color:"rgba(255,255,255,0.5)
<span style={{color:"rgba(255,255,255,0.35)",fontSize:"10px",marginLeft:"6px"}}
</span>
</div>
)}
{/* Tabela agrupada */}
<div style={{border:"1px solid rgba(255,255,255,0.05)",borderRadius:10,overflow:"hidd
{CLASS_ORDER.map(function(cls){
var subgroups = grouped[cls]; if (!subgroups) return null;
var color = M3_CLASS_COLORS[cls];
var items = [];
Object.keys(subgroups).forEach(function(k){ items = items.concat(subgroups[k]); }
var classTotal = items.reduce(function(s,a){return s + (a.valor||0);}, 0);
return <div key={cls}>
<div style={{background:color+"15",borderLeft:"3px solid "+color,padding:"8px 1
<div style={{fontSize:11,fontWeight:800,color:color,textTransform:"uppercase"
<div style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>{items.length} ativo
</div>
{Object.keys(subgroups).map(function(sub){
var subItems = subgroups[sub];
var subLabel = cls === "renda_fixa" ? (M3_INDEXADOR_LABELS[sub] || sub) : nul
return <div key={sub}>
{subLabel && !editMode && <div style={{padding:"5px 14px",background:"rgba(
<table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
<tbody>
{subItems.map(function(a,i){
// Descobre o índice desse ativo no array editado (se em edição)
var editIdx = editMode ? editedAtivos.indexOf(a) : -1;
var displayName = a.ticker || (a.nome_original && a.nome_original.len
var sc = STATUS_COLORS[a.status_recomendacao] || "rgba(255,255,255,0.
return <tr key={a.id+"-"+i} style={{borderTop:"1px solid rgba(255,255
<td style={{padding:"5px 10px",color:"#f1f5f9",fontWeight:600,width
{editMode ? (
<div style={{display:"flex",flexDirection:"column",gap:"2px"}}>
<input type="text" placeholder="Ticker" value={a.ticker||""}
<input type="text" placeholder="Nome (opcional)" value={a.nom
</div>
) : displayName}
</td>
<td style={{padding:"5px 10px",color:"rgba(255,255,255,0.55)",fontS
{/* Classe (edit) */}
<td style={{padding:"5px 10px"}}>
{editMode ? (
<select value={a.classe||""} onChange={function(e){updateAtivo(
{CLASSES_EDITAVEIS.map(function(k){return <option key={k} val
</select>
) : null}
{/* Subclasse pra RF (edit) */}
{editMode && a.classe === "renda_fixa" && (
<select value={a.subclasse||""} onChange={function(e){updateAti
{Object.keys(INDEXADORES).map(function(k){return <option key=
</select>
)}
</td>
{/* Status */}
<td style={{padding:"5px 10px"}}>
{editMode ? (
<select value={a.status_recomendacao||"manter"} onChange={funct
{Object.keys(STATUS_LABELS).map(function(k){return <option ke
</select>
) : (
<span title={STATUS_TOOLTIPS[a.status_recomendacao]||""} style=
)}
</td>
{/* Valor */}
<td style={{padding:"5px 10px",textAlign:"right",fontVariantNumeric
{editMode ? (
<input type="number" value={a.valor||0} onChange={function(e){u
) : (
<span style={{color:"rgba(255,255,255,0.7)"}}>R$ {(a.valor||0).
)}
</td>
{/* PCT (editável no snapshot ALVO em edit mode, read-only nos outr
<td style={{padding:"5px 10px",textAlign:"right",color:"rgba(255,25
{editMode && snapshot.tipo === "alvo" ? (
<input
type="number"
step="0.01"
min="0"
max="100"
value={a.pct_total || 0}
onChange={function(e){updateAtivo(editIdx,"pct_total",Number(
style={Object.assign({},inputMiniS,{width:"60px",textAlign:"r
title="% do patrimônio alvo deste ticker"
/>
) : (
(a.pct_total||0).toFixed(2) + "%"
)}
</td>
{/* Remover ativo (só em edit mode) */}
{editMode && <td style={{padding:"5px 6px",textAlign:"center",width
<button
onClick={function(){
var next = editedAtivos.slice();
next.splice(editIdx, 1);
setEditedAtivos(next);
}}
title="Remover este ativo do snapshot"
style={{background:"transparent",border:"1px solid rgba(248,113
>✕</button>
</td>}
</tr>;
})}
</tbody>
</table>
</div>;
})}
</div>;
})}
</div>
{editMode && <div style={{marginTop:14,background:"rgba(251,191,36,0.04)",border:"1px
Ticker, nome, classe, status e valor são editáveis. Use <b>+ Adicionar ativo</b>
</div>}
<div style={{marginTop:"14px",display:"flex",justifyContent:"flex-end"}}>
{!editMode && <button onClick={onClose} style={{padding:"9px 18px",borderRadius:7,b
</div>
</div>
</div>
);
}
/* ─── SnapshotTargetEditorModal (M4): editor do snapshot 'alvo' ───
Abre com valores do alvo salvo OU derivados do JB (primeiro edit).
Regra Q3 alternativa: soma dos ativos listados por classe deve ser ≤ % da classe
(diferença é tratada como "genérico"). Aviso amarelo se estourar.
*/
function SnapshotTargetEditorModal(p) {
var clientProfileId = p.clientProfileId;
var clientName = p.clientName;
var jbData = p.jbData;
var savedAlvo = p.savedAlvo; var onClose = p.onClose;
var onSaved = p.onSaved;
// snapshot tipo='alvo' ou null
var [editable, setEditable] = useState(function(){ return buildEditableTarget(savedAlvo, jb
var [saving, setSaving] = useState(false);
var [error, setError] = useState("");
var [newTickerInput, setNewTickerInput] = useState("");
if (!editable) return null;
// Soma de alocação de ativos por classe (pra validação Q3 alternativa)
function sumAtivosPorClasse() {
var sum = {renda_fixa:0, acoes_br:0, fiis:0, internacional:0, alternativos:0, caixa:0};
editable.ativos.forEach(function(a){
var cls = a.classe && sum[a.classe] !== undefined ? a.classe : null;
if (cls) sum[cls] += (a.pct || 0);
});
// Arredonda
Object.keys(sum).forEach(function(k){ sum[k] = +sum[k].toFixed(2); });
return sum;
}
var somasPorClasse = sumAtivosPorClasse();
function updateMacroPct(cls, val) {
var v = parseFloat(val) || 0;
setEditable(function(prev){
return Object.assign({}, prev, { allocMacro: Object.assign({}, prev.allocMacro, { [cls]
});
}
function updateIndexadorPct(ix, val) {
var v = parseFloat(val) || 0;
setEditable(function(prev){
return Object.assign({}, prev, { allocIndexadoresRF: Object.assign({}, prev.allocIndexa
});
}
function updateAtivoField(idx, field, val) {
setEditable(function(prev){
var next = prev.ativos.slice();
var a = Object.assign({}, next[idx]);
if (field === "pct") a.pct = parseFloat(val) || 0;
else a[field] = val;
next[idx] = a;
return Object.assign({}, prev, { ativos: next });
});
}
function removeAtivo(idx) {
setEditable(function(prev){
var next = prev.ativos.slice();
next.splice(idx, 1);
return Object.assign({}, prev, { ativos: next });
});
}
function addAtivo(ticker) {
var tk = String(ticker||"").toUpperCase().trim();
if (!tk) return;
if (editable.ativos.some(function(a){return a.ticker===tk;})) { setError("Ticker "+tk+" j
var meta = lookupTicker(tk);
setEditable(function(prev){
return Object.assign({}, prev, {
ativos: prev.ativos.concat([{ ticker: tk, classe: meta ? meta.classe : null, subclass
});
});
setNewTickerInput("");
setError("");
}
function updateObjetivo(field, val) {
var v = val === "" ? null : (parseFloat(val) || null);
setEditable(function(prev){ return Object.assign({}, prev, { objetivos: Object.assign({},
}
function resetFromJB() {
if (!confirm("Redefinir a partir do JB? Edições manuais serão perdidas."))return;
setEditable(buildEditableTarget(null, jbData));
setError("");
}
// Autocomplete: tickers das carteiras Suno
var sunoTickers = [];
try {
var s = localStorage.getItem("tt-carteiras-suno");
if (s) {
var d = JSON.parse(s);
var ativosMap = (d && d.ativos) || {};
Object.keys(ativosMap).forEach(function(cid){
(ativosMap[cid]||[]).forEach(function(a){
if (a && a.ticker) {
var tk = String(a.ticker).toUpperCase().trim();
if (tk && sunoTickers.indexOf(tk) < 0) sunoTickers.push(tk);
}
});
});
}
} catch(e) {}
// Total da macro (pra conferência)
var totalMacro = Object.keys(editable.allocMacro).reduce(function(s,k){return s+(editable.a
totalMacro = +totalMacro.toFixed(2);
async function handleSave() {
// Validação: soma macro = 100 (tolerância 0.5pp)
if (Math.abs(totalMacro - 100) > 0.5) {
setError("Soma das classes macro deve ser 100% (atual: "+totalMacro.toFixed(1)+"%).");
return;
}
// Validação Q3 alternativa: soma ativos ≤ pct da classe pra cada classe
var violations = [];
Object.keys(editable.allocMacro).forEach(function(cls){
var macro = editable.allocMacro[cls] || 0;
var ativos = somasPorClasse[cls] || 0;
if (ativos > macro + 0.5) {
violations.push(M3_CLASS_LABELS[cls]+": ativos somam "+ativos.toFixed(1)+"% mas class
}
});
if (violations.length > 0) {
setError("Soma dos ativos excede o alvo da classe em: " + violations.join("; "));
return;
}
setSaving(true); setError("");
try {
var uid = await getUserId();
// Converte ativos [array] de volta pra { ticker: pct }
var allocAtivos = {};
editable.ativos.forEach(function(a){ if (a.ticker && a.pct > 0) allocAtivos[a.ticker] =
// Monta estrutura macro de alocação no shape usual (pct + valor=0 já que alvo não tem
var alocacao = {};
Object.keys(editable.allocMacro).forEach(function(cls){
alocacao[cls] = { pct: editable.allocMacro[cls] || 0, valor: 0 };
});
var snapshotData = {
version: 1,
tipo: "alvo",
snapshot_date: new Date().toISOString().slice(0,10),
origem: savedAlvo ? "manual_edit" : "jb_derived_edited",
alocacao: alocacao,
allocIndexadoresRF: editable.allocIndexadoresRF,
allocAtivos: allocAtivos,
objetivos: editable.objetivos,
reserva: editable.reserva,
ativos: [], // alvo não tem lista de ativos com valor
contagem: { total: Object.keys(allocAtivos).length }
};
await saveClientSnapshot(clientProfileId, "alvo", snapshotData);
if (onSaved) onSaved();
onClose();
} catch (e) {
console.error("[target] save error:", e);
setError("Erro ao salvar: " + (e.message || e));
} finally {
setSaving(false);
}
}
var inputS = {width:"100%",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,2
var thS = {padding:"6px 8px",textAlign:"left",color:"rgba(255,255,255,0.5)",fontWeight:700,
var CLASS_ORDER = ["renda_fixa","acoes_br","fiis","internacional","alternativos","caixa"];
var IX_ORDER = ["pos_fixado","ipca","prefixado","fundo_rf"];
var overlayS = {position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",zIndex:2150,display:
var modalS = {background:"#0a0a0a",border:"1px solid rgba(255,255,255,0.08)",borderRadius:1
return (
<div style={overlayS} onClick={function(e){if(e.target===e.currentTarget)onClose();}}>
<div style={modalS}>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin
<div>
<div style={{fontSize:16,fontWeight:800,color:"#fff"}}>Editar alvo · {clientName}
<div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginTop:3}}>
{savedAlvo ? "Editando alvo salvo — mudanças substituem o alvo atual" : "Inicia
</div>
</div>
<button onClick={onClose} style={{background:"transparent",border:"none",color:"rgb
</div>
{/* OBJETIVOS */}
<div style={{background:"linear-gradient(135deg, rgba(59,130,246,0.06), rgba(139,92,2
<div style={{fontSize:10,fontWeight:700,color:"#60a5fa",textTransform:"uppercase",l
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(170px, 1fr
<div>
<label style={{fontSize:10,color:"rgba(255,255,255,0.5)",display:"block",margin
<input type="number" min="0" value={editable.objetivos.capitalAlvo || ""} onCha
</div>
<div>
<label style={{fontSize:10,color:"rgba(255,255,255,0.5)",display:"block",margin
<input type="number" min="0" value={editable.objetivos.rendaPassivaMeta || ""}
</div>
<div>
<label style={{fontSize:10,color:"rgba(255,255,255,0.5)",display:"block",margin
<input type="number" min="0" value={editable.objetivos.aporteMensalNecessario |
</div>
<div>
<label style={{fontSize:10,color:"rgba(255,255,255,0.5)",display:"block",margin
<input type="number" min="0" value={editable.objetivos.idadeAposentadoria || ""
</div>
</div>
</div>
{/* MACRO POR CLASSE */}
<div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marg
<div style={{fontSize:10,fontWeight:700,color:"#fff",textTransform:"uppercase",le
<div style={{fontSize:10,color:Math.abs(totalMacro-100)<=0.5?"#4ade80":"#f87171",
</div>
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr
{CLASS_ORDER.map(function(cls){
var macro = editable.allocMacro[cls] || 0;
var ativosSum = somasPorClasse[cls] || 0;
var sobra = +(macro - ativosSum).toFixed(2);
var overflow = ativosSum > macro + 0.5;
return <div key={cls} style={{background:"rgba(0,0,0,0.2)",border:"1px solid "+
<div style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}>
<div style={{width:8,height:8,borderRadius:2,background:M3_CLASS_COLORS[cls
<div style={{fontSize:10,color:"#f1f5f9",fontWeight:700}}>{M3_CLASS_LABELS[
</div>
<input type="number" min="0" max="100" step="0.1" value={macro} onChange={fun
<div style={{fontSize:8,color:overflow?"#f87171":"rgba(255,255,255,0.4)",marg
ativos: {ativosSum.toFixed(1)}% · {overflow ? "excede!" : "genérico: "+sobr
</div>
</div>;
})}
</div>
</div>
{/* RF POR INDEXADOR */}
{(editable.allocMacro.renda_fixa || 0) > 0 && (
<div style={{background:"rgba(59,130,246,0.03)",border:"1px solid rgba(59,130,246,0
<div style={{fontSize:10,fontWeight:700,color:"rgba(96,165,250,0.9)",textTransfor
Renda Fixa · por indexador (% do patrimônio total)
</div>
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1
{IX_ORDER.map(function(ix){
return <div key={ix}>
<label style={{fontSize:10,color:"rgba(255,255,255,0.55)",display:"block",m
<input type="number" min="0" max="100" step="0.1" value={editable.allocInde
</div>;
})}
</div>
</div>
<div style={{fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:6}}>Soma dos inde
)}
{/* ATIVOS DO ALVO */}
<div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marg
<div style={{fontSize:10,fontWeight:700,color:"#fff",textTransform:"uppercase",le
<div style={{display:"flex",gap:5,alignItems:"center"}}>
<input type="text" list="suno-tickers-autocomplete" value={newTickerInput} onCh
<datalist id="suno-tickers-autocomplete">
{sunoTickers.map(function(tk){return <option key={tk} value={tk}/>;})}
</datalist>
<button onClick={function(){addAtivo(newTickerInput);}} style={{padding:"6px 12
</div>
</div>
{editable.ativos.length === 0 ? (
<div style={{padding:"20px",textAlign:"center",color:"rgba(255,255,255,0.3)",font
) : (
<div style={{maxHeight:320,overflowY:"auto",border:"1px solid rgba(255,255,255,0.
<table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
<thead style={{position:"sticky",top:0,zIndex:1}}>
<tr>
<th style={Object.assign({},thS,{width:"22%"})}>Ticker</th>
<th style={Object.assign({},thS,{width:"20%"})}>Classe</th>
<th style={Object.assign({},thS,{width:"20%"})}>Indexador / Setor</th>
<th style={Object.assign({},thS,{width:"18%",textAlign:"right"})}>Alvo %<
<th style={Object.assign({},thS,{width:"5%"})}></th>
</tr>
</thead>
<tbody>
{editable.ativos.map(function(a,idx){
var setoresDisp = WIZ_SETORES[a.classe] || [];
return <tr key={a.ticker+"-"+idx} style={{borderTop:"1px solid rgba(255,2
<td style={{padding:"5px 8px",color:"#f1f5f9",fontWeight:700}}>{a.ticke
<td style={{padding:"5px 8px"}}>
<select value={a.classe||""} onChange={function(e){updateAtivoField(i
<option value="" style={{background:"#1a1a1a"}}>—</option>
{WIZ_CLASSES.map(function(c){return <option key={c.v} value={c.v} s
</select>
</td>
<td style={{padding:"5px 8px"}}>
{a.classe === "renda_fixa" ? (
<select value={a.subclasse||""} onChange={function(e){updateAtivoFi
<option value="" style={{background:"#1a1a1a"}}>—</option>
{WIZ_INDEXADORES.map(function(i){return <option key={i.v} value={
</select>
) : setoresDisp.length > 0 ? (
<select value={a.setor||""} onChange={function(e){updateAtivoField(
<option value="" style={{background:"#1a1a1a"}}>—</option>
{setoresDisp.map(function(s){return <option key={s} value={s} sty
</select>
) : <span style={{color:"rgba(255,255,255,0.25)"}}>—</span>}
</td>
<td style={{padding:"5px 8px"}}>
<input type="number" min="0" max="100" step="0.01" value={a.pct} onCh
</td>
<td style={{padding:"5px 8px",textAlign:"center"}}>
<button onClick={function(){removeAtivo(idx);}} title="Remover" style
</td>
</tr>;
})}
</tbody>
</table>
</div>
)}
</div>
{error && <div style={{background:"rgba(248,113,113,0.08)",border:"1px solid rgba(248
<div style={{display:"flex",gap:8,justifyContent:"space-between"}}>
<button onClick={resetFromJB} style={{padding:"8px 14px",borderRadius:7,border:"1px
<div style={{display:"flex",gap:6}}>
<button onClick={onClose} style={{padding:"9px 14px",borderRadius:7,border:"1px s
<button onClick={handleSave} disabled={saving} style={{padding:"9px 18px",borderR
</div>
</div>
</div>
</div>
);
}
/* ─── Snapshot Wizard: cria novo snapshot 'atual' via upload de planilha Gorila ───
M2: upload → preview → revisar (edição + status + reserva) → save.
Edição de classificação alimenta ticker_overrides (admin) e persiste no snapshot.
*/
// Taxonomia pra dropdowns na tela de revisão
var WIZ_CLASSES = [
{v:"renda_fixa", l:"Renda Fixa"},
{v:"acoes_br", l:"Ações BR"},
{v:"fiis", l:"FIIs"},
{v:"internacional", l:"Internacional"},
{v:"alternativos", l:"Alternativos"},
{v:"caixa", l:"Caixa"}
];
var WIZ_SETORES = {
acoes_br: ["bancos","seguros","bolsas","mineracao","siderurgia","papel_celulose","petroleo_
fiis: ["tijolo","CRIs"],
internacional: ["s_p_500","nasdaq","mundo","europa","asia","setorial"],
alternativos: ["fi_infra","fiagro","cripto","commodities","multimercado","previdencia"],
renda_fixa: [],
caixa: []
};
var WIZ_SEGMENTOS = {
tijolo: ["logistica","shopping","varejo","lajes","hibrido","hospitalar","educacional","hote
CRIs: ["high_grade","high_yield","alta_liquidez","hibrido"]
};
var WIZ_INDEXADORES = [
{v:"pos_fixado", l:"Pós (CDI/Selic)"},
{v:"ipca", l:"IPCA+"},
{v:"prefixado", l:"Prefixado"},
{v:"fundo_rf", l:"Fundo RF"}
];
var WIZ_STATUS = [
{v:"core", l:"Core", color:"#4ade80"},
{v:"manter", l:"Manter", color:"#fbbf24"},
{v:"em_avaliacao", l:"Em avaliação", color:"#fb923c"},
{v:"reducao", l:"Redução", color:"#ef4444"}
];
var INDEXADOR_LABEL_MAP = {pos_fixado:"Pós (CDI)", ipca:"IPCA+", prefixado:"Prefixado", fundo
function SnapshotWizardModal(p) {
var clientProfileId = p.clientProfileId;
var clientName = p.clientName;
var isAdmin = !!p.isAdmin;
var onClose = p.onClose;
var onSaved = p.onSaved;
var [step, setStep] = useState("upload"); // upload | preview | revisar | saving | don
var [fileName, setFileName] = useState("");
var [snapshot, setSnapshot] = useState(null); // resultado do parser, editável em "revisar
var [ativosEdit, setAtivosEdit] = useState([]); // cópia editável dos ativos
var [originalClassifications, setOriginalClassifications] = useState({}); // pra detectar e
var [applyToCatalog, setApplyToCatalog] = useState({}); // {ticker: true/false} admin-only
var [reservaMeses, setReservaMeses] = useState("");
var [reservaAlvo, setReservaAlvo] = useState("");
var [reservaDentroRF, setReservaDentroRF] = useState(true);
var [error, setError] = useState("");
var [saving, setSaving] = useState(false);
var CLASS_COLORS = {
renda_fixa: "#3b82f6", acoes_br: "#DC2626", fiis: "#f59e0b",
internacional: "#8b5cf6", alternativos: "#10b981", caixa: "#6b7280", unknown: "#ef4444"
};
var CLASS_LABELS = {
renda_fixa: "Renda Fixa", acoes_br: "Ações BR", fiis: "FIIs",
internacional: "Internacional", alternativos: "Alternativos", caixa: "Caixa", unknown: "N
};
async function handleFile(file) {
setError("");
if (!file) return;
setFileName(file.name);
try {
var buf = await file.arrayBuffer();
// Monta lookups: overrides, carteiras Suno, snapshot anterior
var overridesLookup = await loadTickerOverrides();
var sunoCarteirasLookup = buildSunoCarteirasLookup();
var previousStatusLookup = await buildPreviousStatusLookup(clientProfileId);
var parserOptions = {
overridesLookup: overridesLookup,
sunoCarteirasLookup: sunoCarteirasLookup,
previousStatusLookup: previousStatusLookup
};
// Detecta formato automaticamente (Gorila vs MyProfit)
var formato = detectSpreadsheetFormat(buf);
console.log("[snapshot] formato detectado:", formato);
var snap;
if (formato === "myprofit") {
snap = parseMyProfitXlsx(buf, parserOptions);
} else if (formato === "gorila") {
snap = parseGorilaXlsx(buf, parserOptions);
} else {
throw new Error("Formato não reconhecido. Use planilha padrão Gorila ou MyProfit.");
}
setSnapshot(snap);
// Inicializa estado editável
setAtivosEdit(snap.ativos.map(function(a){return Object.assign({}, a);}));
var origMap = {};
snap.ativos.forEach(function(a){
if (a.ticker) origMap[a.ticker] = {classe:a.classe, setor:a.setor, segmento:a.segment
});
setOriginalClassifications(origMap);
setApplyToCatalog({});
setReservaMeses(""); setReservaAlvo(""); setReservaDentroRF(true);
setStep("preview");
} catch (e) {
console.error("[snapshot] parse error:", e);
setError("Erro ao ler planilha: " + (e.message || e));
setStep("error");
}
}
// Edita um campo de um ativo (usando índice na lista editável)
function editAsset(idx, field, val) {
setAtivosEdit(function(prev){
var next = prev.slice();
var a = Object.assign({}, next[idx]);
a[field] = val;
// Se mudou classe, limpa setor/segmento
if (field === "classe") { a.setor = null; a.segmento = null; }
// Se mudou setor, limpa segmento
if (field === "setor") { a.segmento = null; }
next[idx] = a;
return next;
});
}
function toggleApplyToCatalog(ticker) {
setApplyToCatalog(function(prev){
var nxt = Object.assign({}, prev);
nxt[ticker] = !prev[ticker];
return nxt;
});
}
// Recalcula alocação após edições (na hora de salvar)
function recalcAndBuildSnapshot() {
var totalPatrimonio = ativosEdit.reduce(function(s,a){return s + (a.valor||0);}, 0);
var alocacao = {
renda_fixa:{pct:0,valor:0}, acoes_br:{pct:0,valor:0}, fiis:{pct:0,valor:0},
internacional:{pct:0,valor:0}, alternativos:{pct:0,valor:0}, caixa:{pct:0,valor:0}, unk
};
ativosEdit.forEach(function(a){
var cls = alocacao[a.classe] ? a.classe : "unknown";
alocacao[cls].valor += (a.valor||0);
});
if (totalPatrimonio > 0) {
Object.keys(alocacao).forEach(function(c){
alocacao[c].pct = +((alocacao[c].valor / totalPatrimonio) * 100).toFixed(2);
});
}
0,
// Pcts por classe pra cada ativo
var totalPorClasse = {};
ativosEdit.forEach(function(a){totalPorClasse[a.classe] = (totalPorClasse[a.classe]||0) +
var ativosFinais = ativosEdit.map(function(a){
return Object.assign({}, a, {
pct_total: totalPatrimonio > 0 ? +((a.valor/totalPatrimonio)*100).toFixed(2) : pct_classe: totalPorClasse[a.classe] > 0 ? +((a.valor/totalPorClasse[a.classe])*100).
});
});
var reserva = null;
var rMes = parseInt(reservaMeses,10);
var rAlvo = parseInt(reservaAlvo,10);
if (!isNaN(rMes) || !isNaN(rAlvo)) {
reserva = {
meses_cobertos: isNaN(rMes) ? null : rMes,
meses_alvo: isNaN(rAlvo) ? null : rAlvo,
dentro_da_rf: !!reservaDentroRF
};
}
var contagem = {
total: ativosFinais.length,
precisa_revisao: ativosFinais.filter(function(a){return a.precisa_revisao;}).length,
unknown: ativosFinais.filter(function(a){return a.classe==="unknown";}).length,
};
return Object.assign({}, snapshot, {
alocacao: alocacao,
ativos: ativosFinais,
reserva: reserva,
contagem: contagem
});
}
async function handleSave() {
setSaving(true); setError("");
try {
// 1. Se admin marcou "aplicar ao catálogo" em edições, faz upsert dos overrides
if (isAdmin) {
var tickersToPersist = Object.keys(applyToCatalog).filter(function(t){return applyToC
for (var i = 0; i < tickersToPersist.length; i++) {
var tk = tickersToPersist[i];
var asset = ativosEdit.find(function(a){return a.ticker === tk;});
if (asset) {
try {
await upsertTickerOverride(tk, asset.classe, asset.subclasse, asset.setor, asse
} catch (ovErr) {
console.warn("[override] falhou para", tk, ovErr);
}
}
}
}
// 2. Salva snapshot
var finalSnap = recalcAndBuildSnapshot();
await saveClientSnapshot(clientProfileId, "atual", finalSnap);
setStep("done");
if (onSaved) onSaved();
} catch (e) {
console.error("[snapshot] save error:", e);
setError("Erro ao salvar: " + (e.message || e));
setStep("error");
} finally {
setSaving(false);
}
}
function resetWizard() {
setStep("upload"); setFileName(""); setSnapshot(null); setAtivosEdit([]);
setOriginalClassifications({}); setApplyToCatalog({});
setReservaMeses(""); setReservaAlvo(""); setReservaDentroRF(true);
setError("");
}
var overlayS = {position:"fixed",inset:0,background:"rgba(0,0,0,0.72)",zIndex:2000,display:
var modalS = {background:"#0a0a0a",border:"1px solid rgba(255,255,255,0.08)",borderRadius:"
// Currrent snapshot state (com edições pendentes) pra preview na aba revisar
var currentAlocacao = {};
if (step === "revisar" && snapshot) {
var totalTmp = ativosEdit.reduce(function(s,a){return s + (a.valor||0);}, 0);
WIZ_CLASSES.forEach(function(c){ currentAlocacao[c.v] = {pct:0, valor:0}; });
currentAlocacao.unknown = {pct:0, valor:0};
ativosEdit.forEach(function(a){
var cls = currentAlocacao[a.classe] ? a.classe : "unknown";
currentAlocacao[cls].valor += (a.valor||0);
if (totalTmp > 0) Object.keys(currentAlocacao).forEach(function(c){
currentAlocacao[c].pct = +((currentAlocacao[c].valor/totalTmp)*100).toFixed(2);
});
});
}
return (
<div style={overlayS} onClick={function(e){if(e.target===e.currentTarget)onClose();}}>
<div style={modalS}>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin
<div>
</div>
<button onClick={onClose} style={{background:"transparent",border:"none",color:"rgb
</div>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>Novo snapshot · {clien
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginTop:"2px"}}>Impo
{/* Steps indicator */}
{step !== "done" && step !== "error" && (
<div style={{display:"flex",gap:"4px",marginBottom:"16px"}}>
{[{k:"upload",l:"1 Upload"},{k:"preview",l:"2 Preview"},{k:"revisar",l:"3 Revisar
var isActive = step===s.k;
var stepOrder = ["upload","preview","revisar","saving"];
var isDone = stepOrder.indexOf(step) > stepOrder.indexOf(s.k);
return <div key={s.k} style={{flex:1,padding:"6px 10px",borderRadius:"6px",font
})}
</div>
)}
{/* STEP: upload */}
{step === "upload" && (
<div>
<label
style={{display:"block",border:"2px dashed rgba(59,130,246,0.3)",borderRadius:"
onDragOver={function(e){e.preventDefault();e.stopPropagation();e.currentTarget.
onDragLeave={function(e){e.preventDefault();e.stopPropagation();e.currentTarget
onDrop={function(e){e.preventDefault();e.stopPropagation();e.currentTarget.styl
<div style={{fontSize:"36px",marginBottom:"12px"}}> </div>
<div style={{color:"rgba(255,255,255,0.6)",fontSize:"13px",marginBottom:"6px"}}
<div style={{color:"rgba(255,255,255,0.35)",fontSize:"11px",marginBottom:"4px"}
<div style={{color:"rgba(255,255,255,0.3)",fontSize:"10px"}}>Classifica automat
<input type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={funct
</label>
</div>
)}
{/* STEP: preview */}
{step === "preview" && snapshot && (
<div>
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(130px, 1
<div style={{background:"rgba(255,255,255,0.03)",borderRadius:"8px",padding:"10
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"uppe
<div style={{fontSize:"16px",fontWeight:800,color:"#f1f5f9",marginTop:"2px"}}
</div>
<div style={{background:"rgba(255,255,255,0.03)",borderRadius:"8px",padding:"10
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"uppe
<div style={{fontSize:"14px",fontWeight:800,color:"#f1f5f9",marginTop:"2px"}}
</div>
<div style={{background:"rgba(255,255,255,0.03)",borderRadius:"8px",padding:"10
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"uppe
<div style={{fontSize:"16px",fontWeight:800,color:"#f1f5f9",marginTop:"2px"}}
</div>
<div style={{background:"rgba(255,255,255,0.03)",borderRadius:"8px",padding:"10
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"uppe
<div style={{fontSize:"16px",fontWeight:800,color:snapshot.contagem.precisa_r
</div>
</div>
<div style={{display:"flex",height:32,borderRadius:8,overflow:"hidden",border:"1p
{Object.keys(snapshot.alocacao).map(function(cls){
var a = snapshot.alocacao[cls];
if (a.pct <= 0) return null;
var color = CLASS_COLORS[cls] || "#888";
return <div key={cls} style={{width:a.pct+"%",background:color,display:"flex"
{a.pct > 6 ? a.pct.toFixed(1)+"%" : ""}
</div>;
})}
</div>
<div style={{display:"flex",flexWrap:"wrap",gap:12,fontSize:11,marginBottom:16}}>
{Object.keys(snapshot.alocacao).map(function(cls){
var a = snapshot.alocacao[cls];
if (a.pct <= 0) return null;
var color = CLASS_COLORS[cls] || "#888";
return <div key={cls} style={{display:"flex",alignItems:"center",gap:5,color:
<div style={{width:10,height:10,borderRadius:3,background:color}}></div>
{CLASS_LABELS[cls]} {a.pct.toFixed(1)}%
</div>;
})}
</div>
<div style={{fontSize:11,color:"rgba(255,255,255,0.45)",marginBottom:16,lineHeigh
Classificação inicial feita pelo parser. No próximo passo você revisa ativo por
</div>
<div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
<button onClick={resetWizard} style={{padding:"9px 16px",borderRadius:7,border:
<button onClick={function(){setStep("revisar");}} style={{padding:"9px 18px",bo
</div>
</div>
)}
{/* STEP: revisar */}
{step === "revisar" && snapshot && (
<div>
{/* Reserva de emergência */}
<div style={{background:"rgba(59,130,246,0.04)",border:"1px solid rgba(59,130,246
<div style={{fontSize:10,fontWeight:700,color:"#60a5fa",textTransform:"uppercas
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1.5fr",gap:10,alignIte
<div>
<label style={{fontSize:10,color:"rgba(255,255,255,0.5)",display:"block",ma
<input type="number" min="0" value={reservaMeses} onChange={function(e){set
</div>
<div>
<label style={{fontSize:10,color:"rgba(255,255,255,0.5)",display:"block",ma
<input type="number" min="0" value={reservaAlvo} onChange={function(e){setR
</div>
<div>
<label style={{fontSize:10,color:"rgba(255,255,255,0.5)",display:"block",ma
<div style={{display:"flex",gap:6}}>
<button onClick={function(){setReservaDentroRF(true);}} style={{flex:1,pa
<button onClick={function(){setReservaDentroRF(false);}} style={{flex:1,p
</div>
</div>
</div>
</div>
{/* Alocação atual (recalculada) */}
<div style={{display:"flex",height:24,borderRadius:6,overflow:"hidden",border:"1p
{Object.keys(currentAlocacao).map(function(cls){
var a = currentAlocacao[cls];
if (a.pct <= 0) return null;
var color = CLASS_COLORS[cls] || "#888";
return <div key={cls} style={{width:a.pct+"%",background:color,display:"flex"
})}
</div>
<div style={{display:"flex",flexWrap:"wrap",gap:10,fontSize:10,marginBottom:14}}>
{Object.keys(currentAlocacao).map(function(cls){
var a = currentAlocacao[cls];
if (a.pct <= 0) return null;
var color = CLASS_COLORS[cls] || "#888";
return <div key={cls} style={{display:"flex",alignItems:"center",gap:4,color:
<div style={{width:8,height:8,borderRadius:2,background:color}}></div>
{CLASS_LABELS[cls]} {a.pct.toFixed(1)}%
</div>;
})}
</div>
{/* Tabela agrupada por classe */}
<SnapshotRevisionTable
ativos={ativosEdit}
originalClassifications={originalClassifications}
applyToCatalog={applyToCatalog}
isAdmin={isAdmin}
onEdit={editAsset}
onToggleApply={toggleApplyToCatalog}
/>
<div style={{display:"flex",gap:8,justifyContent:"space-between",marginTop:14}}>
<button onClick={function(){setStep("preview");}} style={{padding:"9px 14px",bo
<button onClick={handleSave} disabled={saving} style={{padding:"9px 18px",borde
</div>
</div>
)}
{/* STEP: done */}
{step === "done" && (
<div style={{textAlign:"center",padding:"30px 10px"}}>
<div style={{fontSize:36,marginBottom:12}}> </div>
<div style={{fontSize:15,fontWeight:700,color:"#fff",marginBottom:6}}>Snapshot sa
<div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:20}}>A <button onClick={onClose} style={{padding:"10px 24px",borderRadius:8,border:"none
</div>
timeli
)}
{/* STEP: error */}
{step === "error" && (
<div style={{textAlign:"center",padding:"30px 10px"}}>
<div style={{fontSize:36,marginBottom:12}}> </div>
<div style={{fontSize:14,fontWeight:700,color:"#f87171",marginBottom:8}}>Algo deu
<div style={{fontSize:11,color:"rgba(255,255,255,0.55)",marginBottom:16,lineHeigh
<button onClick={resetWizard} style={{padding:"10px 24px",borderRadius:8,border:"
</div>
)}
</div>
</div>
);
}
/* ─── Tabela agrupada pra tela de revisão ─── */
function SnapshotRevisionTable(p) {
var ativos = p.ativos;
var isAdmin = p.isAdmin;
var originalClassifications = p.originalClassifications || {};
var applyToCatalog = p.applyToCatalog || {};
var onEdit = p.onEdit;
var onToggleApply = p.onToggleApply;
// Agrupamento: classe → (só pra RF) indexador → ativos
var CLASS_ORDER = ["renda_fixa","caixa","acoes_br","fiis","internacional","alternativos","u
var CLASS_LABELS = {renda_fixa:"Renda Fixa", caixa:"Caixa", acoes_br:"Ações BR", fiis:"FIIs
var CLASS_COLORS = {renda_fixa:"#3b82f6", acoes_br:"#DC2626", fiis:"#f59e0b", internacional
// Monta grupos mantendo referência ao índice original no array (pra edição)
var grouped = {};
ativos.forEach(function(a, idx){
var cls = a.classe || "unknown";
if (!grouped[cls]) grouped[cls] = {};
if (cls === "renda_fixa") {
var ix = canonicalizeRFSubclasse(a);
if (!grouped[cls][ix]) grouped[cls][ix] = [];
grouped[cls][ix].push({asset:a, idx:idx});
} else {
if (!grouped[cls]["_"]) grouped[cls]["_"] = [];
grouped[cls]["_"].push({asset:a, idx:idx});
}
});
var selS = {background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",b
var thS = {padding:"6px 8px",textAlign:"left",color:"rgba(255,255,255,0.5)",fontWeight:700,
var tdS = {padding:"5px 8px",borderTop:"1px solid rgba(255,255,255,0.03)",color:"rgba(255,2
function isEdited(a) {
if (!a.ticker || !originalClassifications[a.ticker]) return false;
var o = originalClassifications[a.ticker];
return o.classe !== a.classe || o.setor !== (a.setor||null) || o.segmento !== (a.segmento
}
return (
<div style={{border:"1px solid rgba(255,255,255,0.05)",borderRadius:10,overflow:"hidden",
{CLASS_ORDER.map(function(cls){
var subgroups = grouped[cls];
if (!subgroups) return null;
var color = CLASS_COLORS[cls];
var allItems = [];
Object.keys(subgroups).forEach(function(k){ subgroups[k].forEach(function(it){allItem
var classTotal = allItems.reduce(function(s,it){return s + (it.asset.valor||0);}, 0);
return <div key={cls}>
<div style={{background:color+"15",borderLeft:"3px solid "+color,padding:"8px 12px"
<div style={{fontSize:11,fontWeight:800,color:color,textTransform:"uppercase",let
<div style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>{allItems.length} ativo{
</div>
{Object.keys(subgroups).map(function(sub){
var items = subgroups[sub];
var subLabel = cls === "renda_fixa" ? (INDEXADOR_LABEL_MAP[sub] || sub) : null;
return <div key={sub}>
{subLabel && <div style={{padding:"5px 14px",background:"rgba(59,130,246,0.04)"
<table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
<thead>
<tr>
<th style={Object.assign({},thS,{width:"24%"})}>Ativo</th>
<th style={Object.assign({},thS,{width:"11%"})}>Classe</th>
<th style={Object.assign({},thS,{width:"11%"})}>Setor</th>
<th style={Object.assign({},thS,{width:"11%"})}>Segmento</th>
{cls==="renda_fixa" && <th style={Object.assign({},thS,{width:"10%"})}>In
<th style={Object.assign({},thS,{width:"11%"})}>Status</th>
<th style={Object.assign({},thS,{width:"9%",textAlign:"right"})}>Valor</t
<th style={Object.assign({},thS,{width:"6%",textAlign:"right"})}>%</th>
{isAdmin && <th style={Object.assign({},thS,{width:"7%",textAlign:"center
</tr>
</thead>
<tbody>
{items.map(function(it){
var a = it.asset; var idx = it.idx;
var displayName = a.ticker || (a.nome_original.length > 40 ? a.nome_origi
var setoresDisp = WIZ_SETORES[a.classe] || [];
var segmentosDisp = WIZ_SEGMENTOS[a.setor] || [];
var edited = isEdited(a);
var statusObj = WIZ_STATUS.find(function(s){return s.v===a.status_recomen
return <tr key={a.id+"-"+idx} style={{background: edited ? "rgba(251,191,
<td style={Object.assign({},tdS,{color:"#f1f5f9",fontWeight:600})} titl
<td style={tdS}>
<select value={a.classe||""} onChange={function(e){onEdit(idx,"classe
{WIZ_CLASSES.map(function(c){return <option key={c.v} value={c.v} s
<option value="unknown" style={{background:"#1a1a1a"}}>Não classifi
</select>
</td>
<td style={tdS}>
{setoresDisp.length > 0 ? (
<select value={a.setor||""} onChange={function(e){onEdit(idx,"setor
<option value="" style={{background:"#1a1a1a"}}>—</option>
{setoresDisp.map(function(s){return <option key={s} value={s} sty
</select>
) : <span style={{color:"rgba(255,255,255,0.25)"}}>—</span>}
</td>
<td style={tdS}>
{segmentosDisp.length > 0 ? (
<select value={a.segmento||""} onChange={function(e){onEdit(idx,"se
<option value="" style={{background:"#1a1a1a"}}>—</option>
{segmentosDisp.map(function(s){return <option key={s} value={s} s
</select>
) : <span style={{color:"rgba(255,255,255,0.25)"}}>—</span>}
</td>
{cls==="renda_fixa" && <td style={tdS}>
<select value={a.subclasse||""} onChange={function(e){onEdit(idx,"sub
{WIZ_INDEXADORES.map(function(i){return <option key={i.v} value={i.
</select>
</td>}
<td style={tdS}>
<select value={a.status_recomendacao||"core"} onChange={function(e){o
{WIZ_STATUS.map(function(s){return <option key={s.v} value={s.v} st
</select>
</td>
<td style={Object.assign({},tdS,{textAlign:"right",fontVariantNumeric:"
<td style={Object.assign({},tdS,{textAlign:"right",color:"rgba(255,255,
{isAdmin && <td style={Object.assign({},tdS,{textAlign:"center"})}>
{a.ticker && edited ? (
<input type="checkbox" checked={!!applyToCatalog[a.ticker]} onChang
) : <span style={{color:"rgba(255,255,255,0.15)"}}>—</span>}
</td>}
</tr>;
})}
</tbody>
</table>
</div>;
})}
</div>;
})}
{isAdmin && (
<div style={{padding:"10px 14px",background:"rgba(251,191,36,0.04)",borderTop:"1px so
<strong>Modo admin:</strong> ativos editados recebem a marca ●. Marque "Catálogo" p
</div>
)}
</div>
);
}
function ClientProfileEditor(p) {
var prof = p.profile;
var onChange = p.onChange;
var compact = p.compact;
function set(field, val) {
var updated = Object.assign({}, prof);
updated[field] = val;
updated.updatedAt = new Date().toISOString().slice(0,10);
onChange(updated);
}
function setAlloc(cls, field, val) {
var updated = Object.assign({}, prof);
var alloc = Object.assign({}, updated.allocation || {});
alloc[cls] = Object.assign({}, alloc[cls] || {target:0,current:0});
alloc[cls][field] = parseFloat(val) || 0;
updated.allocation = alloc;
updated.updatedAt = new Date().toISOString().slice(0,10);
onChange(updated);
}
var iS = {width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,2
var lS = {fontSize:"10px",fontWeight:600,color:"rgba(255,255,255,0.5)",marginBottom:"3px",d
var selS = Object.assign({}, iS);
var secTitle = {fontSize:"9px",fontWeight:700,color:"#DC2626",textTransform:"uppercase",let
var allocObj = prof.allocation || {};
var totalTarget = ALLOC_CLASSES.reduce(function(s,c){return s + ((allocObj[c]||{}).target||
var totalCurrent = ALLOC_CLASSES.reduce(function(s,c){return s + ((allocObj[c]||{}).current
// Idade derivada da data de nascimento (fonte de verdade para o planejamento).
// Se não houver birthDate, cai em prof.age (campo legado) para não quebrar cadastros antig
// Usa a data de referência do perfil (ou hoje) para o cálculo.
var idadeDerivada = (function(){
var ref = dataReferenciaDoPerfil(prof);
var frac = idadeFracionariaDeBirthDate(prof.birthDate, ref);
if (frac != null) return Math.floor(frac);
var n = Number(prof.age);
return isFinite(n) && n > 0 ? n : null;
})();
var hojeISO = new Date().toISOString().slice(0,10);
return (
<div>
{/* Personal data */}
<div style={secTitle}>Dados Pessoais</div>
<div style={{display:"grid",gridTemplateColumns:compact?"1fr 1fr":"1fr 1fr 1fr 1fr",gap
<div><label style={lS}>Nome completo *</label><input value={prof.name||""} onChange={
<div>
<label style={lS}>Data de nascimento</label>
<input type="date" max={hojeISO} value={prof.birthDate||""} onChange={function(e){s
{idadeDerivada != null && <div style={{fontSize:"9px",color:"rgba(255,255,255,0.35)
</div>
<div><label style={lS}>Profissão</label><input value={prof.profession||""} onChange={
<div><label style={lS}>Estado civil</label><select value={prof.maritalStatus||""} onC
<option value="" style={{background:"#1a1a1a"}}>—</option>
<option value="Solteiro(a)" style={{background:"#1a1a1a"}}>Solteiro(a)</option>
<option value="Casado(a)" style={{background:"#1a1a1a"}}>Casado(a)</option>
<option value="Divorciado(a)" style={{background:"#1a1a1a"}}>Divorciado(a)</option>
<option value="Viúvo(a)" style={{background:"#1a1a1a"}}>Viúvo(a)</option>
<option value="União estável" style={{background:"#1a1a1a"}}>União estável</option>
</select></div>
</div>
<div style={{display:"grid",gridTemplateColumns:compact?"1fr":"1fr 1fr 1fr 1fr",gap:"8p
<div>
<label style={lS}>Data de início do contrato</label>
<input type="date" max={hojeISO} value={prof.contractStartDate||""} onChange={funct
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.35)",marginTop:"3px"}}>Usada
</div>
</div>
{/* Financial data */}
<div style={secTitle}>Dados Financeiros</div>
<div style={{display:"grid",gridTemplateColumns:compact?"1fr 1fr":"1fr 1fr 1fr",gap:"8p
<div><label style={lS}>Patrimônio total (R$)</label><input value={prof.totalWealth||"
<div><label style={lS}>Renda mensal (R$)</label><input value={prof.monthlyIncome||""}
<div><label style={lS}>Capacidade de aporte mensal (R$)</label><input value={prof.mon
</div>
{/* Planejamento de Aposentadoria */}
<div style={secTitle}>Planejamento de Aposentadoria</div>
<div style={{display:"grid",gridTemplateColumns:compact?"1fr 1fr":"1fr 1fr 1fr",gap:"8p
<div><label style={lS}>Idade de aposentadoria</label><input value={prof.retirementAge
<div><label style={lS}>Renda mensal desejada na aposentadoria (R$)</label><input valu
<div><label style={lS}>Gastos mensais atuais (R$)</label><input value={prof.monthlyEx
</div>
<div style={{display:"grid",gridTemplateColumns:"1fr",gap:"8px",marginBottom:"8px"}}>
<div>
<label style={lS}>Data de referência do cálculo (opcional)</label>
<input type="date" max={hojeISO} value={prof.referenceDate||""} onChange={function(
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.35)",marginTop:"3px"}}>Em bra
</div>
</div>
{/* Investor profile */}
<div style={secTitle}>Perfil Investidor</div>
<div style={{display:"grid",gridTemplateColumns:compact?"1fr 1fr":"1fr 1fr 1fr 1fr",gap
<div><label style={lS}>Experiência</label>
<div style={{display:"flex",gap:"3px"}}>{EXP_LEVELS.map(function(x){return <button
</div>
<div><label style={lS}>Apetite para risco</label>
<div style={{display:"flex",gap:"3px"}}>{RISK_PROFILES.map(function(x){
var colors = {Conservador:"#60a5fa",Moderado:"#4ade80",Dinâmico:"#a78bfa",Arrojad
return <button key={x} onClick={function(){set("riskProfile",x);}} style={{flex:1
})}</div>
</div>
<div><label style={lS}>Horizonte (anos)</label><input value={prof.horizon||""} <div><label style={lS}>Necessidade de liquidez</label><select value={prof.liquidityNe
<option value="Baixa" style={{background:"#1a1a1a"}}>Baixa</option>
<option value="Média" style={{background:"#1a1a1a"}}>Média</option>
<option value="Alta" style={{background:"#1a1a1a"}}>Alta</option>
</select></div>
</div>
<div style={{display:"grid",gridTemplateColumns:"1fr",gap:"8px",marginBottom:"8px"}}>
<div style={{display:"flex",alignItems:"center",gap:"8px"}}>
<button onClick={function(){set("hasEmergencyReserve",!prof.hasEmergencyReserve);}}
<span style={{fontSize:"11px",color:"rgba(255,255,255,0.5)"}}>Possui reserva de eme
</div>
</div>
onChan
{/* Goals & Strategy */}
<div style={secTitle}>Objetivos e Estratégia</div>
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",marginBottom:"8px"}
<div><label style={lS}>Objetivos de longo prazo</label><textarea value={prof.longTerm
<div><label style={lS}>Estratégia definida</label><textarea value={prof.strategy||""}
</div>
<div><label style={lS}>Observações adicionais</label><textarea value={prof.notes||""} o
{/* Allocation targets */}
<div style={secTitle}>Alocação — Meta vs Atual (%)</div>
<div style={{background:"rgba(255,255,255,0.02)",borderRadius:"8px",border:"1px solid r
<div style={{display:"grid",gridTemplateColumns:"1fr 80px 80px 60px",gap:"4px",margin
<div style={{fontSize:"9px",fontWeight:600,color:"rgba(255,255,255,0.3)"}}>Classe</
<div style={{fontSize:"9px",fontWeight:600,color:"#fbbf24",textAlign:"center"}}>Met
<div style={{fontSize:"9px",fontWeight:600,color:"#60a5fa",textAlign:"center"}}>Atu
<div style={{fontSize:"9px",fontWeight:600,color:"rgba(255,255,255,0.2)",textAlign:
</div>
{ALLOC_CLASSES.map(function(cls){
var al = allocObj[cls] || {target:0,current:0};
var diff = al.current - al.target;
var diffColor = Math.abs(diff) <= 3 ? "#4ade80" : Math.abs(diff) <= 8 ? "#fbbf24" :
return <div key={cls} style={{display:"grid",gridTemplateColumns:"1fr 80px 80px 60p
<div style={{fontSize:"11px",fontWeight:600,color:"rgba(255,255,255,0.6)"}}>{cls}
<input value={al.target||""} onChange={function(e){setAlloc(cls,"target",e.target
<input value={al.current||""} onChange={function(e){setAlloc(cls,"current",e.targ
<div style={{fontSize:"10px",fontWeight:700,color:diffColor,textAlign:"center"}}>
</div>;
})}
<div style={{display:"grid",gridTemplateColumns:"1fr 80px 80px 60px",gap:"4px",alignI
<div style={{fontSize:"10px",fontWeight:700,color:"rgba(255,255,255,0.6)"}}>Total</
<div style={{fontSize:"10px",fontWeight:700,color:totalTarget===100?"#4ade80":"#f87
<div style={{fontSize:"10px",fontWeight:700,color:totalCurrent===100?"#4ade80":"#f8
<div></div>
</div>
{totalTarget !== 100 && <div style={{fontSize:"9px",color:"#f87171",marginTop:"2px"}}
</div>
</div>
);
}
/* ─── Client Editor with Tabs (Perfil | Planejamento) ─── */
function ClientEditorWithTabs(p) {
var [activeTab, setActiveTab] = useState("perfil");
var tabBase = {flex:1,padding:"10px",border:"none",cursor:"pointer",fontWeight:700,fontSize
var tabActive = {color:"#DC2626",borderBottom:"2px solid #DC2626"};
return (
<div>
<div style={{display:"flex",gap:"4px",marginBottom:"16px",borderBottom:"1px solid rgba(
<button onClick={function(){setActiveTab("perfil");}} style={Object.assign({},tabBase
<button onClick={function(){setActiveTab("planejamento");}} style={Object.assign({},t
</div>
{activeTab==="perfil" && <ClientProfileEditor profile={p.profile} onChange={p.onChange}
{activeTab==="planejamento" && <PlanningTab profile={p.profile}/>}
</div>
);
}
/* ─── Planning Tab: Ciclo de Vida + Evolução + Sensibilidades ─── */
function PlanningTab(p) {
var prof = p.profile || {};
// Verifica se há dados mínimos (birthDate é preferido; age funciona como fallback)
var temIdade = !!prof.birthDate || (prof.age && Number(prof.age) > 0);
var canCalc = temIdade && prof.totalWealth && prof.monthlyIncome;
if (!canCalc) {
return <div style={{padding:"40px 20px",textAlign:"center",color:"rgba(255,255,255,0.3)",
Preencha na aba <b style={{color:"rgba(255,255,255,0.6)"}}>Perfil</b>:<br/>
<span style={{fontSize:"11px"}}>Data de nascimento · Patrimônio total · Renda mensal</s
</div>;
}
var planej = calcularPlanejamento(prof);
var sectionTitle = {fontSize:"11px",fontWeight:700,color:"#DC2626",textTransform:"uppercase
var kpiCard = {background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)
var kpiLabel = {fontSize:"9px",fontWeight:600,color:"rgba(255,255,255,0.4)",textTransform:"
var kpiValue = {fontSize:"16px",fontWeight:700,color:"#f1f5f9"};
var kpiAccent = {fontSize:"16px",fontWeight:700,color:"#DC2626"};
// Gráfico SVG do ciclo de vida
var cv = planej.cicloVida;
var maxY = Math.max.apply(null, cv.map(function(c){return c.riquezaTotal;}));
var minIdade = cv[0].idade;
var maxIdade = cv[cv.length-1].idade;
var gW = 560, gH = 180, pad = 30;
function x(idade) { return pad + (idade - minIdade) / Math.max(1, maxIdade - minIdade) * (g
function y(val) { return gH - pad - val / maxY * (gH - pad*2); }
function path(getVal) {
return cv.map(function(c, i){ return (i===0?"M ":"L ") + x(c.idade).toFixed(1) + " " + y(
}
// Gráfico área de evolução
var ev = planej.evolucaoBienal;
var maxYE = Math.max(planej.capitalNecessario, Math.max.apply(null, ev.map(function(s){retu
var eW = 560, eH = 180, epad = 30;
function xE(idade) { return epad + (idade - ev[0].idade) / Math.max(1, ev[ev.length-1].idad
function yE(val) { return eH - epad - val / maxYE * (eH - epad*2); }
var areaPath = "M " + xE(ev[0].idade).toFixed(1) + " " + (eH - epad).toFixed(1) + " " +
ev.map(function(s, i){ return "L " + xE(s.idade).toFixed(1) + " " + yE(s.patrimonio).toFi
" L " + xE(ev[ev.length-1].idade).toFixed(1) + " " + (eH - epad).toFixed(1) + " Z";
return (
<div>
{/* Resumo de inputs */}
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"8px",marginBottom:"8
<div style={kpiCard}><div style={kpiLabel}>Patrimônio</div><div style={kpiValue}>{fmt
<div style={kpiCard}><div style={kpiLabel}>Retorno real a.a.</div><div style={kpiValu
<div style={kpiCard}><div style={kpiLabel}>Idade aposentadoria</div><div style={kpiVa
</div>
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"8px",marginBottom:"8
<div style={kpiCard}><div style={kpiLabel}>Aporte mensal</div><div style={kpiValue}>{
<div style={kpiCard}><div style={kpiLabel}>Renda desejada</div><div style={kpiValue}>
<div style={kpiCard}><div style={kpiLabel}>Renda mensal atual</div><div style={kpiVal
</div>
stroke
{/* Ciclo de Vida */}
<div style={sectionTitle}>Objetivos — Ciclo de Vida</div>
<div style={{background:"rgba(255,255,255,0.02)",borderRadius:"10px",padding:"14px",mar
<svg width="100%" viewBox={"0 0 " + gW + " " + gH} style={{maxWidth:"100%"}} preserve
{/* Grid */}
<line x1={pad} y1={gH-pad} x2={gW-pad} y2={gH-pad} stroke="rgba(255,255,255,0.15)"
<line x1={pad} y1={pad} x2={pad} y2={gH-pad} stroke="rgba(255,255,255,0.15)" {/* Capital Humano (decreasing) */}
<path d={path(function(c){return c.capitalHumano;})} stroke="#94a3b8" strokeWidth="
{/* Capital Financeiro (growing) */}
<path d={path(function(c){return c.capitalFinanceiro;})} stroke="#60a5fa" strokeWid
{/* Riqueza Total */}
<path d={path(function(c){return c.riquezaTotal;})} stroke="#DC2626" strokeWidth="2
{/* Eixo X (idades) */}
{[{pos:minIdade,label:Math.round(minIdade)},
{pos:(minIdade+maxIdade)/2,label:Math.round((minIdade+maxIdade)/2)},
{pos:maxIdade,label:Math.round(maxIdade)}].map(function(it,idx){
return <text key={idx} x={x(it.pos)} y={gH-pad+12} fontSize="9" fill="rgba(255,25
})}
{/* Legenda */}
<g transform={"translate(" + pad + "," + 12 + ")"}>
<circle cx="0" cy="3" r="3" fill="#94a3b8"/><text x="8" y="6" fontSize="9" fill="
<circle cx="100" cy="3" r="3" fill="#60a5fa"/><text x="108" y="6" fontSize="9" fi
<circle cx="210" cy="3" r="3" fill="#DC2626"/><text x="218" y="6" fontSize="9" fi
</g>
</svg>
</div>
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",marginBottom:"8px"}
<div style={kpiCard}><div style={kpiLabel}>Capital ao aposentar</div><div style={kpiA
<div style={kpiCard}><div style={kpiLabel}>% Meta</div><div style={kpiValue}>{fmtPct(
</div>
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",marginBottom:"8px"}
<div style={kpiCard}><div style={kpiLabel}>Capital Humano</div><div style={kpiValue}>
<div style={kpiCard}><div style={kpiLabel}>Renda ao aposentar</div><div style={kpiAcc
</div>
{/* Evolução */}
<div style={sectionTitle}>Objetivos — Evolução</div>
<div style={{background:"rgba(255,255,255,0.02)",borderRadius:"10px",padding:"14px",mar
<svg width="100%" viewBox={"0 0 " + eW + " " + eH} style={{maxWidth:"100%"}} preserve
<line x1={epad} y1={eH-epad} x2={eW-epad} y2={eH-epad} stroke="rgba(255,255,255,0.1
<line x1={epad} y1={epad} x2={epad} y2={eH-epad} stroke="rgba(255,255,255,0.15)" st
{/* Linha da meta */}
<line x1={epad} y1={yE(planej.capitalNecessario)} x2={eW-epad} y2={yE(planej.capita
<text x={eW-epad-5} y={yE(planej.capitalNecessario)-4} fontSize="8" fill="#fbbf24"
{/* Área */}
<path d={areaPath} fill="rgba(96,165,250,0.15)" stroke="#60a5fa" strokeWidth="1.5"/
{/* Eixo X */}
{[ev[0].idade, Math.round((ev[0].idade+ev[ev.length-1].idade)/2), ev[ev.length-1].i
return <text key={i} x={xE(i)} y={eH-epad+12} fontSize="9" fill="rgba(255,255,255
})}
</svg>
</div>
<div style={{maxHeight:"200px",overflow:"auto",border:"1px solid rgba(255,255,255,0.06)
<table style={{width:"100%",fontSize:"10px",borderCollapse:"collapse"}}>
<thead><tr style={{background:"rgba(220,38,38,0.08)"}}>
<th style={{padding:"6px 10px",textAlign:"left",color:"#DC2626",fontWeight:700}}>
<th style={{padding:"6px 10px",textAlign:"right",color:"#DC2626",fontWeight:700}}
<th style={{padding:"6px 10px",textAlign:"right",color:"#DC2626",fontWeight:700}}
</tr></thead>
<tbody>{planej.evolucaoBienal.map(function(s){
var pct = planej.capitalNecessario>0 ? s.patrimonio/planej.capitalNecessario : 0;
return <tr key={s.ano} style={{borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
<td style={{padding:"5px 10px",color:"rgba(255,255,255,0.7)"}}>{s.idade}</td>
<td style={{padding:"5px 10px",textAlign:"right",color:"#f1f5f9"}}>{fmtBRL(s.pa
<td style={{padding:"5px 10px",textAlign:"right",color:pct>=1?"#4ade80":"rgba(2
</tr>;
})}</tbody>
</table>
</div>
{/* Sensibilidades */}
<div style={sectionTitle}>Tabelas de Sensibilidade</div>
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"8px",marginBottom:"8
<SensTable title="Aporte mensal" rows={planej.sensAporte} fmtKey={function(r){return
<SensTable title="Retorno a.a." rows={planej.sensRetorno} fmtKey={function(r){return
<SensTable title="Idade aposent." rows={planej.sensIdade} fmtKey={function(r){return
</div>
</div>
);
}
function SensTable(p) {
return (
<div style={{background:"rgba(255,255,255,0.02)",borderRadius:"8px",border:"1px solid rgb
<div style={{padding:"6px 10px",background:"rgba(220,38,38,0.08)",fontSize:"9px",fontWe
<table style={{width:"100%",fontSize:"9px",borderCollapse:"collapse"}}>
<thead><tr>
<th style={{padding:"4px 8px",textAlign:"left",color:"rgba(255,255,255,0.4)",fontWe
<th style={{padding:"4px 8px",textAlign:"right",color:"rgba(255,255,255,0.4)",fontW
</tr></thead>
<tbody>{p.rows.map(function(r,i){
var isH = Math.abs(r.valor - p.highlight) < 0.001 || (r.valor === p.highlight);
return <tr key={i} style={{background:isH?"rgba(220,38,38,0.06)":"transparent"}}>
<td style={{padding:"4px 8px",color:isH?"#DC2626":"rgba(255,255,255,0.6)",fontWei
<td style={{padding:"4px 8px",textAlign:"right",color:isH?"#f1f5f9":"rgba(255,255
</tr>;
})}</tbody>
</table>
</div>
);
}
/* ─── Planning PDF Export (Journey Book style) ─── */
function generatePlanningPDF(prof, planej) {
try {
var doc = new jsPDF({orientation:"landscape",unit:"mm",format:"a4"});
var W = doc.internal.pageSize.getWidth();
var H = doc.internal.pageSize.getHeight();
var ML = 20, MR = 20, MT = 18, MB = 18;
var CW = W - ML - MR;
var CLR = {
accent: [220, 38, 38],
dark: [30, 30, 30],
muted: [120, 120, 120],
body: [50, 50, 50],
cardBg: [250, 250, 250],
hairline: [220, 220, 220],
blue: [96, 165, 250],
grey: [148, 163, 184],
yellow: [251, 191, 36]
};
function setC(c){doc.setTextColor(c[0],c[1],c[2]);}
function setF(c){doc.setFillColor(c[0],c[1],c[2]);}
function setD(c){doc.setDrawColor(c[0],c[1],c[2]);}
var _origText = doc.text.bind(doc);
doc.text = function(text, x, y, options) {
if (typeof text === "string") text = sanitizePDFText(text);
else if (Array.isArray(text)) text = text.map(sanitizePDFText);
return _origText(text, x, y, options);
};
// ═══ CAPA ═══
setF(CLR.dark); doc.rect(0, 0, W, H, "F");
setF(CLR.accent); doc.rect(0, 0, 3, H, "F");
doc.setFontSize(11); doc.setFont("helvetica", "bold"); setC([255,255,255]);
doc.text("SUNO", ML, 20);
setC(CLR.accent); doc.text(" ( CONSULTORIA )", ML + 17, 20);
doc.setFontSize(48); doc.setFont("helvetica", "bold"); setC(CLR.accent);
doc.text("Journey", ML, 80);
setC([255,255,255]); doc.text("Book", ML + 72, 80);
doc.setFontSize(12); doc.setFont("helvetica", "normal"); setC([200,200,200]);
doc.text("Seus objetivos em pauta.", ML, 92);
doc.setFontSize(10); doc.setFont("helvetica", "normal"); setC([180,180,180]);
doc.text(new Date().toLocaleDateString("pt-BR"), ML, 140);
doc.setFontSize(28); doc.setFont("helvetica", "bold"); setC([255,255,255]);
doc.text(prof.name || "Cliente", ML, 158);
// ═══ PÁGINA 2: Ciclo de Vida ═══
doc.addPage();
drawHeader("Objetivos — Ciclo de Vida");
// KPIs à esquerda
var yL = 45;
drawKPI(ML, yL, "Patrimônio", fmtBRL(planej.patrimonio)); yL += 16;
drawKPI(ML, yL, "Retorno real a.a.", fmtPct(planej.retorno, 2)); yL += 16;
drawKPI(ML, yL, "Idade aposentadoria", planej.idadeApos + " anos"); yL += 16;
drawKPI(ML, yL, "Aporte mensal", fmtBRL(planej.aporteMensal)); yL += 16;
drawKPI(ML, yL, "Renda desejada", fmtBRL(planej.rendaDesejada)); yL += 16;
drawKPI(ML, yL, "Renda mensal atual", fmtBRL(planej.rendaMensal)); yL += 16;
// Gráfico no centro
var gX = ML + 75, gY = 50, gW2 = 140, gH2 = 85;
drawChartLifeCycle(gX, gY, gW2, gH2, planej);
// KPIs à direita
var yR = 50;
drawKPIBig(gX + gW2 + 20, yR, "Capital ao aposentar", fmtBRL(planej.capitalFinal), fmtPct
drawKPIBig(gX + gW2 + 20, yR, "Capital Humano", fmtBRL(planej.capitalHumano), planej.idad
drawKPIBig(gX + gW2 + 20, yR, "Renda hoje (estim.)", fmtBRL(planej.rendaHojeEstim), "Rend
// Rodapé explicativo
doc.setFontSize(7); doc.setFont("helvetica", "normal"); setC(CLR.muted);
var note1 = "Capital Financeiro: patrimônio atual + aportes capitalizados à taxa de " + f
var note2 = "Capital Humano: valor presente da renda futura descontada à mesma taxa.";
var note3 = "Riqueza Total: Capital Financeiro + Capital Humano.";
doc.text(note1, ML, H - MB - 8);
doc.text(note2, ML, H - MB - 4);
doc.text(note3, ML, H - MB);
// ═══ PÁGINA 3: Evolução ═══
doc.addPage();
drawHeader("Objetivos — Evolução");
// KPIs esquerda
var yL2 = 45;
drawKPI(ML, yL2, "Patrimônio", fmtBRL(planej.patrimonio)); yL2 += 16;
drawKPI(ML, yL2, "Retorno real a.a.", fmtPct(planej.retorno, 2)); yL2 += 16;
drawKPI(ML, yL2, "Idade aposentadoria", planej.idadeApos + " anos"); yL2 += 16;
drawKPI(ML, yL2, "Aporte mensal", fmtBRL(planej.aporteMensal)); yL2 += 16;
drawKPI(ML, yL2, "Renda desejada", fmtBRL(planej.rendaDesejada)); yL2 += 16;
drawKPI(ML, yL2, "Renda mensal atual", fmtBRL(planej.rendaMensal));
// Gráfico evolução
drawChartEvolution(ML + 75, 50, 90, 70, planej);
// KPIs sob o gráfico
drawKPIBig(ML + 75, 130, "Capital ao aposentar", fmtBRL(planej.capitalFinal), fmtPct(plan
drawKPIBig(ML + 130, 130, "Aporte necessário", fmtBRL(planej.aporteNecessario), "p/ ating
drawKPIBig(ML + 75, 155, "Renda hoje (estim.)", fmtBRL(planej.rendaHojeEstim), "");
drawKPIBig(ML + 130, 155, "Renda ao aposentar", fmtBRL(planej.rendaAoAposentar), "");
// Tabela à direita
drawEvolutionTable(ML + 180, 45, 75, planej);
// ═══ PÁGINA 4: Tabelas de Sensibilidade ═══
doc.addPage();
drawHeader("Objetivos — Tabelas de Sensibilidade");
// 4 KPIs no topo
var kpiY = 40;
var kpiW = (CW - 30) / 4;
drawKPITop(ML + 0*(kpiW+10), kpiY, kpiW, "Patrimônio atual", fmtBRL(planej.patrimonio));
drawKPITop(ML + 1*(kpiW+10), kpiY, kpiW, "Idade aposentadoria", planej.idadeApos + drawKPITop(ML + 2*(kpiW+10), kpiY, kpiW, "Retorno a.a.", fmtPct(planej.retorno, 2));
drawKPITop(ML + 3*(kpiW+10), kpiY, kpiW, "Aporte mensal", fmtBRL(planej.aporteMensal));
" anos
// 3 tabelas
var tY = 80;
var tW = (CW - 20) / 3;
drawSensTableToPDF(ML + 0*(tW+10), tY, tW, "Retorno a.a.", planej.sensRetorno, function(r
drawSensTableToPDF(ML + 1*(tW+10), tY, tW, "Idade aposent.", planej.sensIdade, function(r
drawSensTableToPDF(ML + 2*(tW+10), tY, tW, "Aporte mensal", planej.sensAporte, function(r
// Rodapé
doc.setFontSize(7); doc.setFont("helvetica", "italic"); setC(CLR.muted);
doc.text("Cenários e simulações baseados nas premissas do perfil. Não representam promess
// Footer em todas as páginas
var pc = doc.internal.getNumberOfPages();
for (var pg = 2; pg <= pc; pg++) {
doc.setPage(pg);
setF(CLR.accent); doc.rect(0, H-2, W, 2, "F");
doc.setFontSize(7); doc.setFont("helvetica", "normal"); setC(CLR.muted);
doc.text("Journey Book · " + (prof.name || ""), ML, H-6);
doc.text((pg-1) + " / " + (pc-1), W-MR, H-6, {align:"right"});
}
// Helpers locais
function drawHeader(title) {
setF([245,245,245]); doc.rect(0, 0, W, 30, "F");
doc.setFontSize(16); doc.setFont("helvetica", "bold"); setC(CLR.dark);
doc.text(title, ML, 18);
setF(CLR.accent); doc.rect(ML, 22, 15, 1, "F");
}
function drawKPI(x, y, label, value) {
setD(CLR.hairline); doc.setLineWidth(0.2);
doc.roundedRect(x, y, 60, 13, 2, 2, "S");
doc.setFontSize(7); doc.setFont("helvetica", "normal"); setC(CLR.muted);
doc.text(label, x+3, y+5);
doc.setFontSize(10); doc.setFont("helvetica", "bold"); setC(CLR.dark);
doc.text(value, x+3, y+10);
}
function drawKPIBig(x, y, label, value, sub) {
doc.setFontSize(7); doc.setFont("helvetica", "normal"); setC(CLR.muted);
doc.text(label, x, y);
doc.setFontSize(12); doc.setFont("helvetica", "bold"); setC(CLR.accent);
doc.text(value, x, y+6);
if (sub) {
doc.setFontSize(7); doc.setFont("helvetica", "normal"); setC(CLR.muted);
doc.text(sub, x, y+11);
}
}
function drawKPITop(x, y, w, label, value) {
setD(CLR.hairline); doc.setLineWidth(0.2);
doc.roundedRect(x, y, w, 16, 2, 2, "S");
doc.setFontSize(8); doc.setFont("helvetica", "normal"); setC(CLR.muted);
doc.text(label, x+w/2, y+6, {align:"center"});
doc.setFontSize(12); doc.setFont("helvetica", "bold"); setC(CLR.dark);
doc.text(value, x+w/2, y+13, {align:"center"});
}
function drawChartLifeCycle(cx, cy, cw, ch, pln) {
var cv2 = pln.cicloVida;
var maxV = Math.max.apply(null, cv2.map(function(c){return c.riquezaTotal;}));
var minI = cv2[0].idade, maxI = cv2[cv2.length-1].idade;
function xx(i){return cx + (i-minI)/Math.max(1,maxI-minI)*cw;}
function yy(v){return cy+ch - v/maxV*ch;}
// Axes
setD(CLR.hairline); doc.setLineWidth(0.3);
doc.line(cx, cy+ch, cx+cw, cy+ch);
doc.line(cx, cy, cx, cy+ch);
// Lines
function drawLine(color, getVal, thick) {
setD(color); doc.setLineWidth(thick||0.5);
for (var i=1;i<cv2.length;i++) {
doc.line(xx(cv2[i-1].idade), yy(getVal(cv2[i-1])), xx(cv2[i].idade), yy(getVal(cv2[
}
}
drawLine(CLR.grey, function(c){return c.capitalHumano;}, 0.6);
drawLine(CLR.blue, function(c){return c.capitalFinanceiro;}, 0.6);
drawLine(CLR.accent, function(c){return c.riquezaTotal;}, 0.8);
// Legend
doc.setFontSize(7); doc.setFont("helvetica", "normal"); setC(CLR.muted);
setF(CLR.grey); doc.circle(cx, cy-3, 1, "F"); doc.text("Capital Humano", cx+3, cy-2);
setF(CLR.blue); doc.circle(cx+38, cy-3, 1, "F"); doc.text("Capital Financeiro", cx+41,
setF(CLR.accent); doc.circle(cx+80, cy-3, 1, "F"); doc.text("Riqueza Total", cx+83, cy-
// X labels
doc.setFontSize(7); setC(CLR.muted);
doc.text(String(Math.round(minI)), xx(minI), cy+ch+4, {align:"center"});
doc.text(String(Math.round(maxI)), xx(maxI), cy+ch+4, {align:"center"});
doc.text(String(Math.round((minI+maxI)/2)), xx((minI+maxI)/2), cy+ch+4, {align:"center"
}
function drawChartEvolution(cx, cy, cw, ch, pln) {
var ev2 = pln.evolucaoBienal;
var maxV = Math.max(pln.capitalNecessario, Math.max.apply(null, ev2.map(function(s){ret
var minI = ev2[0].idade, maxI = ev2[ev2.length-1].idade;
function xx(i){return cx + (i-minI)/Math.max(1,maxI-minI)*cw;}
function yy(v){return cy+ch - v/maxV*ch;}
// Axes
setD(CLR.hairline); doc.setLineWidth(0.3);
doc.line(cx, cy+ch, cx+cw, cy+ch);
doc.line(cx, cy, cx, cy+ch);
// Meta line (dashed)
setD(CLR.yellow); doc.setLineWidth(0.4);
var metaY = yy(pln.capitalNecessario);
for (var dx = 0; dx < cw; dx += 4) { doc.line(cx+dx, metaY, cx+Math.min(dx+2, cw), meta
doc.setFontSize(6); setC(CLR.yellow);
doc.text("Meta " + fmtBRL(pln.capitalNecessario), cx+cw-1, metaY-1, {align:"right"});
// Area
setF([96, 165, 250]);
var poly = [];
ev2.forEach(function(s){ poly.push([xx(s.idade), yy(s.patrimonio)]); });
// Line
setD(CLR.blue); doc.setLineWidth(0.8);
for (var i=1;i<ev2.length;i++) {
doc.line(xx(ev2[i-1].idade), yy(ev2[i-1].patrimonio), xx(ev2[i].idade), yy(ev2[i].pat
}
// X labels
doc.setFontSize(7); setC(CLR.muted);
doc.text(String(minI), xx(minI), cy+ch+4, {align:"center"});
doc.text(String(maxI), xx(maxI), cy+ch+4, {align:"center"});
}
function drawEvolutionTable(x, y, w, pln) {
var rowH = 8;
setF(CLR.accent); doc.rect(x, y, w, rowH, "F");
doc.setFontSize(8); doc.setFont("helvetica", "bold"); setC([255,255,255]);
doc.text("Idade", x+3, y+5);
doc.text("Patrimônio", x+18, y+5);
doc.text("% Meta", x+w-3, y+5, {align:"right"});
var ry = y + rowH;
pln.evolucaoBienal.forEach(function(s, i){
var pct = pln.capitalNecessario>0 ? s.patrimonio/pln.capitalNecessario : 0;
if (i % 2 === 0) { setF([245,245,245]); doc.rect(x, ry, w, rowH, "F"); }
doc.setFontSize(7); doc.setFont("helvetica", "normal"); setC(CLR.dark);
doc.text(String(s.idade), x+3, ry+5);
doc.text(fmtBRL(s.patrimonio), x+18, ry+5);
setC(pct >= 1 ? [74, 163, 128] : CLR.muted);
doc.text(fmtPct(pct, 0), x+w-3, ry+5, {align:"right"});
ry += rowH;
});
}
function drawSensTableToPDF(x, y, w, title, rows, fmtKey, highlight) {
var rowH = 10;
// Header do título
setF([245,245,245]); doc.rect(x, y, w, 10, "F");
doc.setFontSize(9); doc.setFont("helvetica", "bold"); setC(CLR.dark);
doc.text(title, x+w/2, y+7, {align:"center"});
var hy = y + 10;
// Cabeçalho de colunas
setF(CLR.hairline); doc.rect(x, hy, w, 8, "F");
doc.setFontSize(7); doc.setFont("helvetica", "bold"); setC(CLR.muted);
doc.text("Valor", x+3, hy+5);
doc.text("Patrimônio", x+w/2-5, hy+5);
doc.text("Renda", x+w-3, hy+5, {align:"right"});
var ry = hy + 8;
rows.forEach(function(r, i){
var isH = Math.abs(r.valor - highlight) < 0.001 || (r.valor === highlight);
if (isH) { setF([253, 230, 230]); doc.rect(x, ry, w, rowH, "F"); }
else if (i % 2 === 0) { setF([250,250,250]); doc.rect(x, ry, w, rowH, "F"); }
doc.setFontSize(8); doc.setFont("helvetica", isH?"bold":"normal"); setC(isH?CLR.accen
doc.text(fmtKey(r), x+3, ry+6);
setC(CLR.dark);
doc.text(fmtBRL(r.patrimonio), x+w/2-5, ry+6);
doc.text(fmtBRL(r.renda), x+w-3, ry+6, {align:"right"});
ry += rowH;
});
}
var fname = "journey-book-" + (prof.name || "cliente").toLowerCase().replace(/\s+/g,"-")
doc.save(fname);
} catch (err) {
console.error("PDF planning err:", err);
alert("Erro ao gerar PDF: " + err.message);
}
}
function ClientProfilesModal(p) {
var [profiles, setProfiles] = useState(function(){return loadClientProfiles();});
var [editing, setEditing] = useState(null); // profile id or null
var [editData, setEditData] = useState(null);
// ── JB import state (novo cadastro ou edição) ──
var [jbImporting, setJbImporting] = useState(false);
var [jbImportError, setJbImportError] = useState("");
var [jbConflicts, setJbConflicts] = useState(null); // {conflicts, parsed, source: "jb" | "
var [saving, setSaving] = useState(false);
var [saveError, setSaveError] = useState("");
var jbFileInputRef = useRef(null);
var assetAllocFileInputRef = useRef(null);
// Cache do snapshot Atual extraído do Asset Alloc (pra salvar quando o perfil for criado)
var [pendingAssetAllocSnapshot, setPendingAssetAllocSnapshot] = useState(null);
function saveAll(list) { setProfiles(list); saveClientProfiles(list); }
function addNew() {
var np = makeEmptyProfile();
setEditing(np.id);
setEditData(np);
setJbImportError("");
setJbConflicts(null);
setPendingAssetAllocSnapshot(null);
}
function editProfile(id) {
var found = profiles.find(function(pr){return pr.id===id;});
if (found) {
setEditing(found.id);
setEditData(Object.assign({},found));
setJbImportError("");
setJbConflicts(null);
setPendingAssetAllocSnapshot(null);
}
}
// ─── Importa Asset Allocation (.xlsx) ───
// Lê planilha (local, sem IA), preenche profileData + prepara snapshot pra salvar.
async function handleAssetAllocImport(file) {
if (!file || !editData) return;
setJbImporting(true); setJbImportError(""); setJbConflicts(null);
try {
var arrayBuf = await file.arrayBuffer();
// Verifica se é Asset Alloc antes de tentar parsear
if (!isAssetAllocXlsx(arrayBuf)) {
throw new Error("Planilha não é Asset Allocation válida (abas 'Cadastro' e 'Carteira
}
var sunoCarteirasLookup = {};
try { sunoCarteirasLookup = buildSunoCarteirasLookup ? buildSunoCarteirasLookup() : {};
var result = parseAssetAllocXlsx(arrayBuf, {
sunoCarteirasLookup: sunoCarteirasLookup,
previousStatusLookup: {},
});
// Guarda snapshot pra salvar no final (quando clicar Salvar Perfil)
setPendingAssetAllocSnapshot(result.snapshotAtual);
// Verifica conflitos
var conflictResult = detectAssetAllocConflicts(editData, result.profileData);
if (conflictResult.hasConflicts) {
setJbConflicts({
conflicts: conflictResult.conflicts,
profileData: result.profileData,
allocMacroAlvo: result.allocMacroAlvo,
allocMacroAtual: result.allocMacroAtual,
snapshotAtual: result.snapshotAtual,
suggestedPortfolio: result.suggestedPortfolio,
source: "assetalloc"
});
} else {
var updated = applyAssetAllocToProfile(editData, result.profileData, result.allocMacr
setEditData(updated);
}
} catch (err) {
console.error(err);
setJbImportError("Erro ao ler Asset Allocation: " + err.message);
}
setJbImporting(false);
if (assetAllocFileInputRef.current) assetAllocFileInputRef.current.value = "";
}
// ─── Importa JB PDF (fallback / alternativa) ───
async function handleJBImport(file) {
if (!file || !editData) return;
setJbImporting(true); setJbImportError(""); setJbConflicts(null);
try {
var parsed = await parseJBPdfToJson(file);
var conflictResult = detectJBConflicts(editData, parsed);
if (conflictResult.hasConflicts) {
setJbConflicts({ conflicts: conflictResult.conflicts, parsed: parsed, source: "jb" })
} else {
var updated = applyJBToProfile(editData, parsed, { overwriteExisting: false });
setEditData(updated);
}
} catch (err) {
console.error(err);
setJbImportError("Erro ao processar JB: " + err.message);
}
setJbImporting(false);
if (jbFileInputRef.current) jbFileInputRef.current.value = "";
}
// Resolve conflitos após consultor escolher
function resolveConflicts(useExternal) {
if (!jbConflicts || !editData) return;
var updated;
if (jbConflicts.source === "assetalloc") {
updated = applyAssetAllocToProfile(editData, jbConflicts.profileData, jbConflicts.alloc
} else {
updated = applyJBToProfile(editData, jbConflicts.parsed, { overwriteExisting: useExtern
}
setEditData(updated);
setJbConflicts(null);
}
async function saveEdit() {
if (!editData || !editData.name.trim()) return;
setSaving(true); setSaveError("");
try {
var idx = profiles.findIndex(function(pr){return pr.id===editData.id;});
var list = profiles.slice();
if (idx >= 0) list[idx] = editData; else list.push(editData);
saveAll(list);
// Se tem jbData (veio do PDF), cria snapshots inicial e alvo via JB
if (editData.jbData) {
try { await saveInicialFromJB(editData.id, editData.jbData); } catch(e) { console.war
try { await saveAlvoFromJB(editData.id, editData.jbData); } catch(e) { console.warn("
}
// Se tem snapshot pendente do Asset Alloc, salva como 'atual'.
// (É a foto da carteira HOJE, não uma posição inicial histórica.
// O "inicial" só existe quando vier JB real — captura o marco zero no momento do plano
if (pendingAssetAllocSnapshot) {
try {
await saveClientSnapshot(editData.id, "atual", pendingAssetAllocSnapshot);
} catch(e) { console.warn("salvar snapshot asset alloc falhou:", e); }
}
setEditing(null); setEditData(null); setJbConflicts(null); setPendingAssetAllocSnapshot
} catch (err) {
console.error(err);
setSaveError("Erro ao salvar: " + err.message);
}
setSaving(false);
}
function deleteProfile(id) {
if (!confirm("Excluir este perfil de cliente?")) return;
saveAll(profiles.filter(function(pr){return pr.id!==id;}));
}
function cancelEdit() { setEditing(null); setEditData(null); setJbConflicts(null); setJbImp
var btnBase = {padding:"7px 14px",borderRadius:"7px",border:"none",cursor:"pointer",fontWei
return (
<div style={p.inline?{padding:"0"}:{position:"fixed",inset:0,zIndex:2000,background:"rgba
<div style={{background:"#0A0A0A",borderRadius:"16px",border:"1px solid rgba(220,38,38,
<div style={{padding:"20px 24px 14px",borderBottom:"1px solid rgba(255,255,255,0.06)"
<div>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>{editing?"Editar Perfi
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)",marginTop:"2px"}}>{edi
</div>
<button onClick={p.onClose} style={{background:"transparent",border:"none",color:"r
</div>
<div style={{padding:"16px 24px 24px"}}>
{!editing && (<div>
<button onClick={addNew} style={Object.assign({},btnBase,{background:"#DC2626",co
{profiles.length === 0 && <div style={{textAlign:"center",padding:"30px 0",color:
{profiles.map(function(pr){
var riskColors = {Conservador:"#60a5fa",Moderado:"#4ade80",Dinâmico:"#a78bfa",A
var hasJB = !!(pr.jbData);
var hasPos = !!(pr.posAssets && pr.posAssets.length > 0);
var posTotal = hasPos ? pr.posAssets.reduce(function(s,a){return s+(a.totalValu
var posCount = hasPos ? pr.posAssets.filter(function(a){return a.totalValue>0;}
return <div key={pr.id} style={{background:"#111",borderRadius:"10px",padding:"
<div>
<div style={{display:"flex",alignItems:"center",gap:"6px"}}>
<span style={{fontSize:"13px",fontWeight:700,color:"#f1f5f9"}}>{pr.name |
{hasJB && <span style={{fontSize:"7px",padding:"2px 5px",borderRadius:"6p
{hasPos && <span style={{fontSize:"7px",padding:"2px 5px",borderRadius:"6
</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.35)",marginTop:"2px"
{pr.age && pr.age + " anos"}{pr.profession && " · " + pr.profession}
{pr.riskProfile && <span style={{marginLeft:"6px",padding:"1px 6px",borde
{hasPos && posTotal > 0 && <span style={{marginLeft:"6px",color:"rgba(255
{!hasPos && pr.totalWealth && <span style={{marginLeft:"6px",color:"rgba(
</div>
</div>
<div style={{display:"flex",gap:"4px"}}>
<button onClick={function(){editProfile(pr.id);}} style={Object.assign({},b
<button onClick={function(){deleteProfile(pr.id);}} style={Object.assign({}
</div>
</div>;
})}
</div>)}
{editing && editData && (<div>
{/* ─── SEÇÃO DE IMPORT (Asset Allocation principal + JB PDF alternativo) ─── */}
<div style={{marginBottom:"16px",padding:"14px",background:(editData.jbData||pend
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
<div style={{fontSize:"11px",fontWeight:700,color:(editData.jbData||pendingAs
Importar dados do cliente {(editData.jbData||pendingAssetAllocSnapshot||
</div>
{editData.assetAllocImportDate && <div style={{fontSize:"9px",color:"rgba(255
{!editData.assetAllocImportDate && editData.jbData && editData.jbImportDate &
</div>
{!jbImporting && !(editData.jbData || editData.assetAllocImportDate) && (
<div>
</div>
<div style={{fontSize:"11px",color:"rgba(255,255,255,0.5)",lineHeight:1.5,m
Preenche <b>automaticamente</b> os dados do cliente e cria o snapshot da
{/* Botão principal: Asset Allocation (xlsx) */}
<div style={{marginBottom:"10px"}}>
<label style={{display:"inline-block",padding:"10px 16px",background:"#DC
Importar Planilha Asset Allocation
<input ref={assetAllocFileInputRef} type="file" accept=".xlsx" onChange
</label>
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.45)",marginTop:"4px
</div>
{/* Alternativa: JB PDF */}
<div style={{paddingTop:"10px",borderTop:"1px solid rgba(255,255,255,0.05)"
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginBottom:"
<label style={{display:"inline-block",padding:"6px 12px",background:"tran
Importar PDF do Journey Book
<input ref={jbFileInputRef} type="file" accept=".pdf" onChange={functio
</label>
<span style={{fontSize:"9px",color:"rgba(255,255,255,0.3)",marginLeft:"10
</div>
</div>
)}
{jbImporting && (
<div style={{fontSize:"11px",color:"#fbbf24",padding:"8px 0"}}>
Processando arquivo...
</div>
)}
{jbImportError && (
<div style={{fontSize:"11px",color:"#f87171",padding:"6px 10px",background:"r
{jbImportError}
</div>
)}
{/* Asset Alloc importado (com ou sem JB) */}
{!jbImporting && editData.assetAllocImportDate && (
<div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.55)",lineHeight:1.7}
✓ Cadastro do cliente preenchido
{pendingAssetAllocSnapshot && <span><br/>✓ Snapshot da carteira ({pending
</div>
<div style={{display:"flex",gap:"6px",marginTop:"10px",flexWrap:"wrap"}}>
<label style={{padding:"5px 10px",fontSize:"10px",color:"#DC2626",backgro
Reimportar Asset Alloc
<input ref={assetAllocFileInputRef} type="file" accept=".xlsx" onChange
</label>
{!editData.jbData && (
<label style={{padding:"5px 10px",fontSize:"10px",color:"#fbbf24",backg
+ Adicionar JB (PDF)
<input ref={jbFileInputRef} type="file" accept=".pdf" onChange={funct
</label>
)}
</div>
</div>
)}
{/* JB importado (sem Asset Alloc) */}
{!jbImporting && editData.jbData && !editData.assetAllocImportDate && (
<div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.55)",lineHeight:1.7}
{editData.jbData.suggestedPortfolio && <span>✓ {editData.jbData.suggested
{editData.jbData.currentPortfolio && <span> · ✓ {editData.jbData.currentP
<br/>
{editData.jbData.projections && editData.jbData.projections.capitalAtReti
{editData.jbData.projections && editData.jbData.projections.retirementAge
{editData.jbData.jbDate && <span><br/>✓ Data do JB: {editData.jbData.jbDa
</div>
<div style={{display:"flex",gap:"6px",marginTop:"10px",flexWrap:"wrap"}}>
<label style={{padding:"5px 10px",fontSize:"10px",color:"#fbbf24",backgro
Reimportar JB
<input ref={jbFileInputRef} type="file" accept=".pdf" onChange={functio
</label>
<label style={{padding:"5px 10px",fontSize:"10px",color:"#DC2626",backgro
+ Adicionar Asset Alloc
<input ref={assetAllocFileInputRef} type="file" accept=".xlsx" onChange
</label>
<button onClick={function(){
if (!confirm("Remover Journey Book?")) return;
var updated = Object.assign({}, editData, {jbData: null, jbImportDate:
setEditData(updated);
}} style={{padding:"5px 10px",fontSize:"10px",color:"rgba(220,38,38,0.5)"
</div>
</div>
)}
</div>
{/* Modal de conflitos ─── exibido se import tem dados divergentes */}
{jbConflicts && (
<div style={{marginBottom:"16px",padding:"14px",background:"rgba(251,146,60,0.0
<div style={{fontSize:"11px",fontWeight:700,color:"#fb923c",textTransform:"up
<div style={{fontSize:"11px",color:"rgba(255,255,255,0.65)",marginBottom:"10p
Você já digitou alguns dados que diferem do que {jbConflicts.source === "as
</div>
<div style={{background:"rgba(0,0,0,0.2)",borderRadius:"6px",padding:"8px 10p
{jbConflicts.conflicts.map(function(c, i){
return <div key={i} style={{fontSize:"10px",padding:"4px 0",borderBottom:
<b style={{color:"#fb923c"}}>{c.label}:</b> <span style={{color:"rgba(2
</div>;
})}
</div>
<div style={{display:"flex",gap:"6px"}}>
<button onClick={function(){resolveConflicts(false);}} style={{flex:1,paddi
<button onClick={function(){resolveConflicts(true);}} style={{flex:1,paddin
</div>
</div>
)}
<ClientEditorWithTabs profile={editData} onChange={setEditData}/>
{saveError && <div style={{marginTop:"10px",padding:"8px 12px",background:"rgba(2
<div style={{display:"flex",gap:"8px",marginTop:"14px"}}>
<button onClick={cancelEdit} disabled={saving} style={Object.assign({},btnBase,
<button onClick={saveEdit} disabled={!editData.name.trim() || saving} style={Ob
</div>
</div>)}
</div>
</div>
</div>
);
}
/* ─── Macro & Bias Module (Pilar 4) ─── */
var SUNO_PROFILES = ["Conservador","Moderado","Dinâmico","Arrojado","Sofisticado","Defensivo"
var SUNO_BENCHMARKS = {"Conservador":"110%","Moderado":"115%","Dinâmico":"120%","Arrojado":"1
var BIAS_CLASSES = [
{group:"Crédito",items:["Cash","Pós-fixado","Pré-fixado","IPCA+"]},
{group:"Equities",items:["FIIs","Alternativos","Ações Brasil"]},
{group:"Offshore",items:["Equities Offshore","Credit Offshore"]}
];
var ALL_BIAS_ITEMS = [];
BIAS_CLASSES.forEach(function(g){g.items.forEach(function(it){ALL_BIAS_ITEMS.push(it);});});
// Currency formatting helpers
function formatBRL(val) {
if (!val && val !== 0) return "";
var num = typeof val === "string" ? parseInt(val.replace(/\D/g, "")) || 0 : Math.round(val)
if (num === 0) return "";
return num.toLocaleString("pt-BR");
function parseBRL(str) {
return parseInt(String(str).replace(/\D/g, "")) || 0;
}
}
function cleanCitations(text) {
if (!text) return "";
return text.replace(/<cite[^>]*>/g, "").replace(/<\/cite>/g, "").replace(/<[^>]+>/g, "");
}
function loadMacroData() {
try { var s = localStorage.getItem("tt-macro"); if (s) return JSON.parse(s); } catch(e) {}
return { macroReports:[], biasViews:{}, allocationTable:{} };
}
function saveMacroData(d) {
try { localStorage.setItem("tt-macro", JSON.stringify(d)); } catch(e) {}
syncToCloud("macro_data", {data: d, updated_at: new Date().toISOString()});
}
function MacroModal(p) {
var [macroData, setMacroData] = useState(function(){
var d = loadMacroData();
// Migrate old single report to array
if (d.macroReport && (!d.macroReports || d.macroReports.length === 0)) {
d.macroReports = [{id: Date.now().toString(36), date: d.macroDate || new Date().toISOSt
delete d.macroReport; delete d.macroDate;
}
if (!d.macroReports) d.macroReports = [];
return d;
});
var [tab, setTab] = useState("report");
var [importing, setImporting] = useState(false);
var biasFileRef = useRef(null);
// Report editing state
var [addingReport, setAddingReport] = useState(false);
var [editReportId, setEditReportId] = useState(null);
var [rTitle, setRTitle] = useState("");
var [rDate, setRDate] = useState(new Date().toISOString().slice(0,10));
var [rText, setRText] = useState("");
var [rDestaque, setRDestaque] = useState(false);
function save(updated) { setMacroData(updated); saveMacroData(updated); }
function startAddReport() {
setAddingReport(true); setEditReportId(null);
setRTitle(""); setRDate(new Date().toISOString().slice(0,10)); setRText(""); setRDestaque
}
function startEditReport(id) {
var rep = (macroData.macroReports||[]).find(function(r){return r.id===id;});
if (!rep) return;
setEditReportId(id); setAddingReport(true);
setRTitle(rep.title||""); setRDate(rep.date||""); setRText(rep.text||""); setRDestaque(!!
}
function saveReport() {
if (!rText.trim()) return;
var u = Object.assign({}, macroData);
var reports = (u.macroReports||[]).slice();
if (editReportId) {
reports = reports.map(function(r){
if (r.id === editReportId) return {id:r.id, date:rDate, title:rTitle.trim()||"Relatór
return r;
});
} else {
reports.unshift({id: Date.now().toString(36) + Math.random().toString(36).slice(2,5), d
}
u.macroReports = reports;
save(u);
setAddingReport(false); setEditReportId(null); setRTitle(""); setRDate(""); setRText("");
}
function deleteReport(id) {
if (!confirm("Excluir este relatório?")) return;
var u = Object.assign({}, macroData);
u.macroReports = (u.macroReports||[]).filter(function(r){return r.id!==id;});
save(u);
}
function toggleDestaque(id) {
var u = Object.assign({}, macroData);
u.macroReports = (u.macroReports||[]).map(function(r){
if (r.id === id) return Object.assign({}, r, { destaque: !r.destaque });
return r;
});
save(u);
}
function cancelReport() { setAddingReport(false); setEditReportId(null); setRDestaque(false
function setBiasView(item, val) {
var u = Object.assign({}, macroData);
u.biasViews = Object.assign({}, u.biasViews || {});
u.biasViews[item] = parseInt(val) || 0;
save(u);
}
function setAllocCell(profile, item, field, val) {
var u = Object.assign({}, macroData);
u.allocationTable = Object.assign({}, u.allocationTable || {});
var key = profile + "||" + item;
u.allocationTable[key] = Object.assign({}, u.allocationTable[key] || {});
u.allocationTable[key][field] = parseFloat(val) || 0;
save(u);
}
function getAlloc(profile, item, field) {
var t = macroData.allocationTable || {};
var cell = t[profile + "||" + item];
return cell ? (cell[field] || 0) : 0;
}
async function handleBiasUpload(e) {
var f = e.target.files[0]; if (!f) return;
setImporting(true);
try {
var u = Object.assign({}, macroData);
u.biasViews = Object.assign({}, u.biasViews || {});
u.allocationTable = Object.assign({}, u.allocationTable || {});
var isImage = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(f.name) || f.type.startsWith("imag
var sysPrompt = 'Voce recebera uma tabela de alocacao por perfil de investidor. Extraia
var messages;
if (isImage) {
// Read as base64 for image upload
var b64 = await new Promise(function(res, rej) {
var r = new FileReader();
r.onload = function() { res(r.result.split(",")[1]); };
r.onerror = function() { rej(new Error("Erro leitura")); };
r.readAsDataURL(f);
});
var mimeType = f.type || "image/png";
messages = [{role:"user", content:[
{type:"image", source:{type:"base64", media_type:mimeType, data:b64}},
{type:"text", text:"Extraia todos os dados desta tabela de alocação no formato JSON
]}];
} else {
// Excel file
var arrayBuf = await new Promise(function(res, rej) {
var r = new FileReader(); r.onload = function(){res(r.result);}; r.onerror = });
var wb = XLSX.read(arrayBuf, {type:"array"});
var ws = wb.Sheets[wb.SheetNames[0]];
var raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:""});
var tableText = raw.map(function(row){return row.join("\t");}).join("\n");
messages = [{role:"user", content:"Tabela:\n"+tableText}];
functi
}
var resp = await fetch("/api/anthropic", {
method:"POST", headers:{"Content-Type":"application/json"},
body: JSON.stringify({
model:"claude-sonnet-4-6", max_tokens:4096,
system: sysPrompt,
messages: messages
})
});
if (!resp.ok) throw new Error("API " + resp.status);
var d = await resp.json();
var rawText = "";
for (var i=0;i<d.content.length;i++){if(d.content[i].text)rawText+=d.content[i].text;}
rawText = rawText.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"");
var si=rawText.indexOf("{");var ei=rawText.lastIndexOf("}");
if(si>=0&&ei>si)rawText=rawText.slice(si,ei+1);
rawText=rawText.replace(/,\s*}/g,"}").replace(/,\s*\]/g,"]");
var parsed = JSON.parse(rawText);
if (parsed.views) u.biasViews = parsed.views;
if (parsed.allocations) {
Object.keys(parsed.allocations).forEach(function(key){
u.allocationTable[key] = parsed.allocations[key];
});
}
save(u);
} catch(err) { console.error(err); alert("Erro ao importar: " + err.message); }
setImporting(false);
}
var iS={width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255
var lS={fontSize:"10px",fontWeight:600,color:"rgba(255,255,255,0.5)",marginBottom:"4px",dis
var biasColors = {"-2":"#ef4444","-1":"#f97316","0":"#94a3b8","1":"#22c55e","2":"#10b981"};
var biasLabels = {"-2":"Muito Pessimista","-1":"Pessimista","0":"Neutro","1":"Otimista","2"
return (
<div style={p.inline?{padding:"0"}:{position:"fixed",inset:0,zIndex:2000,background:"rgba
<div style={{background:"#0A0A0A",borderRadius:"16px",border:"1px solid rgba(251,191,36
<div style={{padding:"20px 24px 14px",borderBottom:"1px solid rgba(255,255,255,0.06)"
<div>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>Macro & Viés Tático</d
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)",marginTop:"2px"}}>Pila
</div>
<button onClick={p.onClose} style={{background:"transparent",border:"none",color:"r
</div>
<div style={{display:"flex",gap:"2px",padding:"10px 24px 0",borderBottom:"1px solid r
{[{k:"report",l:"Relatório Macro"},{k:"bias",l:"Viés & Alocação"}].map(function(t){
return <button key={t.k} onClick={function(){setTab(t.k);}} style={{padding:"8px
})}
</div>
<div style={{padding:"20px 24px 24px"}}>
{tab==="report"&&(<div>
{!addingReport && (<div>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
<div>
<div style={{fontSize:"12px",fontWeight:700,color:"#fff"}}>Relatórios Macro
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)"}}>{(macroData.ma
</div>
<button onClick={startAddReport} style={{padding:"7px 14px",borderRadius:"7px
</div>
{(macroData.macroReports||[]).length === 0 && <div style={{textAlign:"center",p
{(macroData.macroReports||[]).map(function(rep, idx){
var isDestaque = !!rep.destaque;
return <div key={rep.id} style={{background:isDestaque?"rgba(251,191,36,0.04)
<div style={{display:"flex",justifyContent:"space-between",alignItems:"cent
<div style={{display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"
{isDestaque && <span style={{fontSize:"8px",padding:"2px 7px",borderRad
{!isDestaque && idx<10 && <span style={{fontSize:"8px",padding:"2px 6px
{!isDestaque && idx>=10 && <span style={{fontSize:"8px",padding:"2px 6p
<span style={{fontSize:"12px",fontWeight:700,color:"#f1f5f9"}}>{rep.tit
<span style={{fontSize:"10px",color:"rgba(255,255,255,0.3)"}}>{rep.date
</div>
<div style={{display:"flex",gap:"4px"}}>
<button onClick={function(){toggleDestaque(rep.id);}} title={isDestaque
<button onClick={function(){startEditReport(rep.id);}} style={{fontSize
<button onClick={function(){deleteReport(rep.id);}} style={{fontSize:"9
</div>
</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.35)",lineHeight:1.5,
</div>;
})}
</div>)}
{addingReport && (<div>
<div style={{fontSize:"12px",fontWeight:700,color:"#fff",marginBottom:"10px"}}>
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px",marginBott
<div><label style={lS}>Título / Referência</label><input value={rTitle} onCha
<div><label style={lS}>Data do relatório</label><input value={rDate} onChange
</div>
<div style={{marginBottom:"10px"}}>
<label style={lS}>Texto do relatório (Ctrl+C / Ctrl+V do PDF)</label>
<textarea value={rText} onChange={function(e){setRText(e.target.value);}} row
</div>
<div style={{marginBottom:"12px",padding:"10px 14px",background:rDestaque?"rgba
<input type="checkbox" checked={rDestaque} onChange={function(e){setRDestaque
<div style={{flex:1}}>
<div style={{fontSize:"11px",fontWeight:700,color:rDestaque?"#fbbf24":"rgba
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",marginTop:"2px",l
</div>
</div>
<div style={{display:"flex",gap:"8px"}}>
<button onClick={cancelReport} style={{padding:"8px 16px",borderRadius:"7px",
<button onClick={saveReport} disabled={!rText.trim()} style={{flex:1,padding:
</div>
</div>)}
</div>)}
{tab==="bias"&&(<div>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",ma
<div>
<div style={{fontSize:"12px",fontWeight:700,color:"#fff"}}>Tabela de Viés & A
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)"}}>Escala: -2 (muit
</div>
<label style={{padding:"7px 14px",borderRadius:"7px",border:"1px solid rgba(251
{importing?"Importando...":"Importar Excel ou Imagem"}
<input ref={biasFileRef} type="file" accept=".xlsx,.xls,.csv,.png,.jpg,.jpeg,
</label>
</div>
{/* Bias views */}
<div style={{marginBottom:"16px"}}>
<div style={{fontSize:"9px",fontWeight:700,color:"#fbbf24",textTransform:"upper
{BIAS_CLASSES.map(function(group){
return <div key={group.group} style={{marginBottom:"8px"}}>
<div style={{fontSize:"10px",fontWeight:700,color:"rgba(255,255,255,0.5)",m
{group.items.map(function(item){
var v = (macroData.biasViews||{})[item] || 0;
return <div key={item} style={{display:"flex",alignItems:"center",gap:"8p
<span style={{fontSize:"11px",color:"rgba(255,255,255,0.6)",width:"120p
<div style={{display:"flex",gap:"3px"}}>
{[-2,-1,0,1,2].map(function(bv){
var active = v === bv;
return <button key={bv} onClick={function(){setBiasView(item,bv);}}
})}
</div>
<span style={{fontSize:"9px",color:biasColors[String(v)],fontWeight:600
</div>;
})}
</div>;
})}
</div>
{/* Allocation table */}
<div style={{fontSize:"9px",fontWeight:700,color:"#fbbf24",textTransform:"upperca
<div style={{overflow:"auto",marginBottom:"8px"}}>
<table style={{width:"100%",borderCollapse:"collapse",fontSize:"9px",minWidth:"
<thead>
<tr>
<th style={{textAlign:"left",padding:"4px 6px",color:"rgba(255,255,255,0.
<th style={{textAlign:"center",padding:"4px 3px",color:"rgba(255,255,255,
{SUNO_PROFILES.map(function(pr){
return <th key={pr} colSpan={2} style={{textAlign:"center",padding:"4px
})}
</tr>
<tr>
<th style={{borderBottom:"1px solid rgba(255,255,255,0.06)"}}></th>
<th style={{borderBottom:"1px solid rgba(255,255,255,0.06)"}}></th>
{SUNO_PROFILES.map(function(pr){
return [
<th key={pr+"e"} style={{textAlign:"center",padding:"2px",color:"rgba
<th key={pr+"t"} style={{textAlign:"center",padding:"2px",color:"rgba
style=
];
})}
</tr>
</thead>
<tbody>
{BIAS_CLASSES.map(function(group){
return [
<tr key={group.group+"h"}><td colSpan={2+SUNO_PROFILES.length*2} ].concat(group.items.map(function(item){
var v = (macroData.biasViews||{})[item] || 0;
return <tr key={item}>
<td style={{padding:"3px 6px",color:"rgba(255,255,255,0.5)",borderBot
<td style={{textAlign:"center",padding:"3px",color:biasColors[String(
{SUNO_PROFILES.map(function(pr){
var es = getAlloc(pr,item,"strategic");
var ta = getAlloc(pr,item,"tactical");
return [
<td key={pr+"e"} style={{textAlign:"center",padding:"2px",borderB
<td key={pr+"t"} style={{textAlign:"center",padding:"2px",borderB
];
})}
</tr>;
}));
})}
</tbody>
</table>
</div>
</div>)}
</div>
</div>
</div>
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.2)"}}>Dica: Importe o Excel
);
}
/* ─── Carteiras Suno Module ─── */
var DEFAULT_CARTEIRAS = [
{id:"div",name:"Dividendos",intl:false},
{id:"val",name:"Valor",intl:false},
{id:"sc",name:"Small Caps",intl:false},
{id:"di",name:"Dollar Income",intl:true},
{id:"hv",name:"Hidden Value",intl:true},
{id:"gc",name:"Great Companies",intl:true}
];
function loadCarteiras() {
try { var s = localStorage.getItem("tt-carteiras-suno"); if (s) return JSON.parse(s); } cat
return { carteiras: DEFAULT_CARTEIRAS, ativos: {} };
}
function saveCarteiras(d) {
try { localStorage.setItem("tt-carteiras-suno", JSON.stringify(d)); } catch(e) {}
syncToCloud("carteiras_data", {data: d, updated_at: new Date().toISOString()});
}
function CarteirasModal(p) {
var isAdmin = !!p.isAdmin;
var [cData, setCData] = useState(function(){ return loadCarteiras(); });
var [selCart, setSelCart] = useState(null);
var [addingCart, setAddingCart] = useState(false);
var [editCartId, setEditCartId] = useState(null);
var [cartName, setCartName] = useState("");
var [cartIntl, setCartIntl] = useState(false);
var [addingAtivo, setAddingAtivo] = useState(false);
var [editAtivoIdx, setEditAtivoIdx] = useState(null);
var [aForm, setAForm] = useState({ticker:"",name:"",rank:"",precoTeto:"",aloc:"",vies:"Comp
var [importing, setImporting] = useState(false);
var importRef = useRef(null);
function save(u) { setCData(u); saveCarteiras(u); }
function saveCarteira() {
if (!cartName.trim()) return;
var u = Object.assign({}, cData);
var carts = (u.carteiras||[]).slice();
if (editCartId) {
carts = carts.map(function(c){ return c.id===editCartId ? Object.assign({},c,{name:cart
} else {
var newId = Date.now().toString(36) + Math.random().toString(36).slice(2,5);
carts.push({id:newId, name:cartName.trim(), intl:cartIntl});
}
u.carteiras = carts;
save(u);
setAddingCart(false); setEditCartId(null); setCartName(""); setCartIntl(false);
}
function startEditCart(c) { setEditCartId(c.id); setCartName(c.name); setCartIntl(c.intl);
function deleteCarteira(id) {
if (!confirm("Excluir esta carteira e todos os seus ativos?")) return;
var u = Object.assign({}, cData);
u.carteiras = (u.carteiras||[]).filter(function(c){return c.id!==id;});
var ativos = Object.assign({}, u.ativos||{});
delete ativos[id];
u.ativos = ativos;
save(u);
if (selCart === id) setSelCart(null);
}
function cancelCart() { setAddingCart(false); setEditCartId(null); setCartName(""); setCart
function getCartAtivos(cartId) { return (cData.ativos||{})[cartId] || []; }
function startAddAtivo() { setAddingAtivo(true); setEditAtivoIdx(null); setAForm({ticker:""
function startEditAtivo(idx) {
var a = getCartAtivos(selCart)[idx];
if (!a) return;
setEditAtivoIdx(idx); setAddingAtivo(true);
setAForm({ticker:a.ticker||"",name:a.name||"",rank:a.rank!==undefined?String(a.rank):"",p
}
function saveAtivo() {
if (!aForm.ticker.trim()) return;
var u = Object.assign({}, cData);
var ativos = Object.assign({}, u.ativos||{});
var list = (ativos[selCart]||[]).slice();
var selCartObj = (u.carteiras||[]).find(function(c){return c.id===selCart;});
var isIntl = selCartObj ? selCartObj.intl : false;
var entry = {
ticker: aForm.ticker.trim().toUpperCase(),
name: aForm.name.trim(),
rank: aForm.rank ? parseInt(aForm.rank) : null,
precoTeto: aForm.precoTeto ? parseFloat(aForm.precoTeto) : null,
aloc: isIntl ? null : (aForm.aloc ? parseFloat(aForm.aloc) : null),
vies: aForm.vies || "Comprar"
};
if (editAtivoIdx !== null) { list[editAtivoIdx] = entry; }
else { list.push(entry); }
list.sort(function(a,b){ return (a.rank||999)-(b.rank||999); });
ativos[selCart] = list;
u.ativos = ativos;
save(u);
setAddingAtivo(false); setEditAtivoIdx(null); setAForm({ticker:"",name:"",rank:"",precoTe
}
function deleteAtivo(idx) {
var u = Object.assign({}, cData);
var ativos = Object.assign({}, u.ativos||{});
var list = (ativos[selCart]||[]).slice();
list.splice(idx, 1);
ativos[selCart] = list;
u.ativos = ativos;
save(u);
}
function cancelAtivo() { setAddingAtivo(false); setEditAtivoIdx(null); }
async function handleImport(e) {
var f = e.target.files[0]; if (!f) return;
if (!selCart) { alert("Selecione uma carteira primeiro."); return; }
setImporting(true);
try {
var carteira = (cData.carteiras||[]).find(function(c){return c.id===selCart;});
var isIntl = carteira ? carteira.intl : false;
var isImage = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(f.name) || f.type.startsWith("imag
var sysPrompt = 'Voce recebera uma tabela de carteira recomendada da Suno Research. Ext
var messages;
if (isImage) {
var b64 = await new Promise(function(res, rej) {
var r = new FileReader();
r.onload = function() { res(r.result.split(",")[1]); };
r.onerror = function() { rej(new Error("Erro leitura")); };
r.readAsDataURL(f);
});
messages = [{role:"user", content:[
{type:"image", source:{type:"base64", media_type:f.type||"image/png", data:b64}},
{type:"text", text:"Extraia todos os ativos desta tabela. Carteira: " + (carteira?c
]}];
} else {
var arrayBuf = await new Promise(function(res, rej) {
var r = new FileReader(); r.onload = function(){res(r.result);}; r.onerror = });
var wb = XLSX.read(arrayBuf, {type:"array"});
var ws = wb.Sheets[wb.SheetNames[0]];
var raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:""});
var tableText = raw.map(function(row){return row.join("\t");}).join("\n");
messages = [{role:"user", content:"Carteira: " + (carteira?carteira.name:"") + functi
"\nTab
}
var resp = await fetch("/api/anthropic", {
method:"POST", headers:{"Content-Type":"application/json"},
body: JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:4096, system:sysPrompt,
});
if (!resp.ok) throw new Error("API " + resp.status);
var d = await resp.json();
var rawText = "";
for (var i=0;i<d.content.length;i++){if(d.content[i].text)rawText+=d.content[i].text;}
rawText = rawText.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"");
var si=rawText.indexOf("[");var ei=rawText.lastIndexOf("]");
if(si>=0&&ei>si)rawText=rawText.slice(si,ei+1);
rawText=rawText.replace(/,\s*}/g,"}").replace(/,\s*\]/g,"]");
var parsed = JSON.parse(rawText);
if (Array.isArray(parsed) && parsed.length > 0) {
var u = Object.assign({}, cData);
var ativos = Object.assign({}, u.ativos||{});
var existing = (ativos[selCart]||[]).slice();
var existMap = {};
existing.forEach(function(a,i){ existMap[a.ticker] = i; });
parsed.forEach(function(newA){
var t = (newA.ticker||"").toUpperCase();
if (!t) return;
var entry = {ticker:t, name:newA.name||"", rank:newA.rank||null, precoTeto:newA.pre
if (existMap[t] !== undefined) { existing[existMap[t]] = entry; }
else { existing.push(entry); }
});
existing.sort(function(a,b){ return (a.rank||999)-(b.rank||999); });
ativos[selCart] = existing;
u.ativos = ativos;
save(u);
alert("Importados " + parsed.length + " ativos com sucesso!");
}
} catch(err) { console.error(err); alert("Erro ao importar: " + err.message); }
setImporting(false);
if (importRef.current) importRef.current.value = "";
}
var iS={width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255
var lS={fontSize:"10px",fontWeight:600,color:"rgba(255,255,255,0.5)",marginBottom:"4px",dis
var viesColors = {"Comprar":"#4ade80","Aguardar":"#fbbf24","Vender":"#f87171"};
var carteiras = cData.carteiras || [];
var selCartObj = selCart ? carteiras.find(function(c){return c.id===selCart;}) : null;
var selAtivos = selCart ? getCartAtivos(selCart) : [];
return (
<div style={p.inline?{padding:"0"}:{position:"fixed",inset:0,zIndex:2000,background:"rgba
<div style={{background:"#0A0A0A",borderRadius:"16px",border:"1px solid rgba(59,130,246
<div style={{padding:"20px 24px 14px",borderBottom:"1px solid rgba(255,255,255,0.06)"
<div>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>Carteiras Suno</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)",marginTop:"2px"}}>Reco
</div>
<button onClick={p.onClose} style={{background:"transparent",border:"none",color:"r
</div>
<div style={{display:"flex",minHeight:"500px"}}>
{/* Sidebar */}
<div style={{width:"220px",borderRight:"1px solid rgba(255,255,255,0.05)",padding:"
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",ma
<div style={{fontSize:"9px",fontWeight:700,color:"rgba(59,130,246,0.8)",textTra
{isAdmin&&<button onClick={function(){setAddingCart(true);setEditCartId(null);s
</div>
{carteiras.map(function(c){
var cnt = getCartAtivos(c.id).length;
var active = selCart === c.id;
return <div key={c.id} style={{display:"flex",alignItems:"center",justifyConten
<div>
<div style={{fontSize:"12px",fontWeight:active?700:500,color:active?"#60a5f
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.25)",display:"flex",g
{c.intl && <span style={{color:"rgba(139,92,246,0.6)",fontWeight:600}}>IN
<span>{cnt} ativo{cnt!==1?"s":""}</span>
</div>
</div>
{isAdmin&&<div style={{display:"flex",gap:"2px"}}>
<button onClick={function(ev){ev.stopPropagation();startEditCart(c);}} styl
<button onClick={function(ev){ev.stopPropagation();deleteCarteira(c.id);}}
</div>}
</div>;
})}
{addingCart && (<div style={{background:"rgba(59,130,246,0.05)",borderRadius:"8px
<div style={{fontSize:"10px",fontWeight:700,color:"#60a5fa",marginBottom:"6px"}
<input value={cartName} onChange={function(e){setCartName(e.target.value);}} pl
<label style={{display:"flex",alignItems:"center",gap:"6px",fontSize:"10px",col
<input type="checkbox" checked={cartIntl} onChange={function(e){setCartIntl(e
Internacional (sem Alocação %)
</label>
<div style={{display:"flex",gap:"4px"}}>
<button onClick={cancelCart} style={{flex:1,padding:"5px",borderRadius:"5px",
<button onClick={saveCarteira} disabled={!cartName.trim()} style={{flex:1,pad
</div>
</div>)}
</div>
{/* Main */}
<div style={{flex:1,padding:"16px 20px",overflow:"auto"}}>
{!selCart && <div style={{textAlign:"center",padding:"80px 0",color:"rgba(255,255
{selCart && selCartObj && (<div>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
<div>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>{selCartObj.name
<div style={{display:"flex",gap:"8px",marginTop:"2px"}}>
{selCartObj.intl && <span style={{fontSize:"9px",padding:"2px 8px",border
<span style={{fontSize:"10px",color:"rgba(255,255,255,0.3)"}}>{selAtivos.
</div>
</div>
{isAdmin&&<div style={{display:"flex",gap:"6px"}}>
<label style={{padding:"7px 12px",borderRadius:"7px",border:"1px solid rgba
{importing?"Importando...":"Importar Imagem/Excel"}
<input ref={importRef} type="file" accept=".xlsx,.xls,.csv,.png,.jpg,.jpe
</label>
<button onClick={startAddAtivo} style={{padding:"7px 12px",borderRadius:"7p
</div>}
</div>
{addingAtivo && (<div style={{background:"rgba(59,130,246,0.04)",border:"1px so
<div style={{fontSize:"11px",fontWeight:700,color:"#60a5fa",marginBottom:"10p
<div style={{display:"grid",gridTemplateColumns:selCartObj.intl?"1fr 1fr 1fr
<div><label style={lS}>Ticker *</label><input value={aForm.ticker} onChange
<div><label style={lS}>Empresa</label><input value={aForm.name} onChange={f
<div><label style={lS}>Ranking</label><input value={aForm.rank} onChange={f
<div><label style={lS}>Preço-teto</label><input value={aForm.precoTeto} onC
{!selCartObj.intl && <div><label style={lS}>Alocação %</label><input value=
<div><label style={lS}>Viés</label><select value={aForm.vies} onChange={fun
</div>
<div style={{display:"flex",gap:"6px"}}>
<button onClick={cancelAtivo} style={{padding:"7px 14px",borderRadius:"7px"
<button onClick={saveAtivo} disabled={!aForm.ticker.trim()} style={{padding
</div>
</div>)}
{selAtivos.length===0&&!addingAtivo&&<div style={{textAlign:"center",padding:"5
{selAtivos.length>0&&(<div style={{overflow:"auto"}}>
<table style={{width:"100%",borderCollapse:"collapse",fontSize:"11px"}}>
<thead><tr style={{borderBottom:"1px solid rgba(255,255,255,0.08)"}}>
<th style={{textAlign:"center",padding:"8px 6px",color:"rgba(255,255,255,
<th style={{textAlign:"left",padding:"8px 6px",color:"rgba(255,255,255,0.
<th style={{textAlign:"left",padding:"8px 6px",color:"rgba(255,255,255,0.
<th style={{textAlign:"right",padding:"8px 6px",color:"rgba(255,255,255,0
{!selCartObj.intl&&<th style={{textAlign:"right",padding:"8px 6px",color:
<th style={{textAlign:"center",padding:"8px 6px",color:"rgba(255,255,255,
{isAdmin&&<th style={{textAlign:"center",padding:"8px 6px",color:"rgba(25
</tr></thead>
<tbody>{selAtivos.map(function(a,idx){
return <tr key={a.ticker+idx} style={{borderBottom:"1px solid rgba(255,25
<td style={{textAlign:"center",padding:"8px 6px",color:"rgba(255,255,25
<td style={{padding:"8px 6px",fontWeight:700,color:"#f1f5f9"}}>{a.ticke
<td style={{padding:"8px 6px",color:"rgba(255,255,255,0.5)"}}>{a.name||
<td style={{textAlign:"right",padding:"8px 6px",color:"rgba(255,255,255
{!selCartObj.intl&&<td style={{textAlign:"right",padding:"8px 6px",colo
<td style={{textAlign:"center",padding:"8px 6px"}}><span style={{paddin
{isAdmin&&<td style={{textAlign:"center",padding:"8px 6px"}}>
<button onClick={function(){startEditAtivo(idx);}} title="Editar ativ
<button onClick={function(){deleteAtivo(idx);}} title="Excluir ativo"
</td>}
</tr>;
})}</tbody>
</table>
{!selCartObj.intl&&(function(){
var totalAloc=selAtivos.reduce(function(s,a){return s+(a.aloc||0);},0);
return <div style={{marginTop:"8px",padding:"8px 12px",background:"rgba(59,
<span style={{color:"rgba(255,255,255,0.4)"}}>Total alocação:</span>
<span style={{fontWeight:700,color:Math.abs(totalAloc-100)<0.5?"#4ade80":
</div>;
})()}
</div>)}
</div>)}
</div>
</div>
</div>
</div>
);
}
/* ─── Meeting Prep Module ─── */
function MeetingPrepModal(p) {
var [clientProfiles] = useState(function(){return loadClientProfiles();});
var [selectedProfileId, setSelectedProfileId] = useState("");
var [selectedProfile, setSelectedProfile] = useState(null);
var [meetingDate, setMeetingDate] = useState(new Date().toISOString().slice(0,10));
var [meetingFocus, setMeetingFocus] = useState("");
// NEW: modo genérico (sem cliente) vs modo cliente
var [genericMode, setGenericMode] = useState(false);
var [genericTitle, setGenericTitle] = useState("");
// Module selections
var [wantMacroShort, setWantMacroShort] = useState(true);
var [wantMacroDetail, setWantMacroDetail] = useState(false);
var [wantEmpresas, setWantEmpresas] = useState(true);
var [wantTalkPoints, setWantTalkPoints] = useState(true);
var [wantPDF, setWantPDF] = useState(false);
var [useClientSnapshot, setUseClientSnapshot] = useState(true); // M5-B: usar snapshot no
var [selectedEmpresas, setSelectedEmpresas] = useState({});
// Client's ativos from snapshot (separate from legacy posAssets). Loaded when client is se
var [clientSnapshotAtivos, setClientSnapshotAtivos] = useState([]);
// Results
var [generating, setGenerating] = useState(false);
var [genProgress, setGenProgress] = useState("");
var [error, setError] = useState("");
var [results, setResults] = useState(null); // {macroShort, macroDetail, empresas:{ticker:{
var [pdfGenerating, setPdfGenerating] = useState(false);
// All app stocks
var allAppStocks = [];
["Dividendos","Valor","Small Caps","Internacional"].forEach(function(port) {
(p.data[port] || []).forEach(function(s) { allAppStocks.push(Object.assign({_portfolio: p
});
var carteirasData = loadCarteiras();
function selectClient(id) {
var found = clientProfiles.find(function(pr){return pr.id===id;});
setSelectedProfileId(id);
setSelectedProfile(found ? Object.assign({}, found) : null);
setClientSnapshotAtivos([]);
if (!found) return;
// Carrega ativos do snapshot atual (assincrono — nao bloqueia a UI)
// O snapshot tem prioridade sobre posAssets para exibicao em "Empresas em foco".
(async function(){
var snapAtivos = [];
try {
var snapInfo = await fetchClientSnapshotsForMeeting(found.id);
if (snapInfo && snapInfo.latestAtual && snapInfo.latestAtual.data && Array.isArray(sn
snapAtivos = snapInfo.latestAtual.data.ativos
.filter(function(a){ return a && a.ticker && (a.valor > 0 || a.pct_total > .map(function(a){
return {
ticker: a.ticker,
name: a.nome_original || a.ticker,
totalValue: a.valor || 0,
pct: a.pct_total || 0,
classe: a.classe || "",
status: a.status_recomendacao || "manter"
0); })
};
});
}
} catch(e) { console.warn("[meeting] snapshot ativos fetch falhou:", e); }
// Fallback: se snapshot nao tem ativos, usa posAssets
if (snapAtivos.length === 0 && found.posAssets && found.posAssets.length > 0) {
snapAtivos = found.posAssets
.filter(function(a){ return a && a.ticker && a.totalValue > 0; })
.map(function(a){ return { ticker: a.ticker, name: a.name || a.ticker, totalValue:
}
setClientSnapshotAtivos(snapAtivos);
// Pre-seleciona ativos de RV (ações e FIIs) automaticamente
var sel = {};
snapAtivos.forEach(function(a){
if (/^[A-Z]{4}(3|4|5|6|11)$/.test(a.ticker)) sel[a.ticker] = true;
});
setSelectedEmpresas(sel);
})();
}
async function generateAll() {
if (!selectedProfile && !genericMode) return;
setGenerating(true); setError(""); setGenProgress("Preparando...");
var res = {macroShort:null, macroDetail:null, empresas:{}, talkPoints:null};
function extractText(content) {
var txt = "";
for (var i = 0; i < (content||[]).length; i++) {
if (content[i].type === "text" && content[i].text) txt += content[i].text;
}
return txt;
}
function safeParseJSON(raw) {
raw = raw.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"").replace(/```/g,"");
// Estrategia 1: parse direto (caso mais comum)
try { return JSON.parse(raw); } catch(e) { /* continua */ }
// Estrategia 2: objeto (de { ate })
var si = raw.indexOf("{"); var ei = raw.lastIndexOf("}");
if (si >= 0 && ei > si) {
var chunk = raw.slice(si, ei + 1).replace(/,\s*}/g,"}").replace(/,\s*\]/g,"]");
try { return JSON.parse(chunk); } catch(e) { /* continua */ }
}
// Estrategia 3: array (de [ ate ])
var asi = raw.indexOf("["); var aei = raw.lastIndexOf("]");
if (asi >= 0 && aei > asi) {
var chunk2 = raw.slice(asi, aei + 1).replace(/,\s*}/g,"}").replace(/,\s*\]/g,"]");
try { return JSON.parse(chunk2); } catch(e2) { /* continua */ }
}
// Estrategia 4: objeto envolvendo array (ex: {"empresas": [...]})
if (si >= 0 && ei > si) {
var chunkObj = raw.slice(si, ei + 1);
// Tenta remover newlines desnecessarios no meio de strings quebradas
var cleaned = chunkObj.replace(/([^\\])\n/g, "$1 ").replace(/\t/g, " ").replace(/,\s*
try { return JSON.parse(cleaned); } catch(e3) { /* continua */ }
}
// Estrategia 5: se for um array dentro de texto, tenta extrair o primeiro [...] if (asi >= 0 && aei > asi) {
var chunkArr = raw.slice(asi, aei + 1);
var cleanedArr = chunkArr.replace(/([^\\])\n/g, "$1 ").replace(/\t/g, " ").replace(/,
try { return JSON.parse(cleanedArr); } catch(e4) { /* continua */ }
valido
}
console.error("Failed to parse JSON from (primeiros 500 chars):", raw.slice(0, 500));
throw new Error("Sem JSON valido na resposta da IA");
}
// Normalize IA response into a string — handles arrays, objects, null
function toStr(x) {
if (x === null || x === undefined) return "";
if (typeof x === "string") return x;
if (Array.isArray(x)) {
return x.map(function(item){
if (typeof item === "string") return "• " + item;
if (item && typeof item === "object") return "• " + (item.text || item.content || J
return "• " + String(item);
}).join("\n");
}
if (typeof x === "object") {
// Prefer common fields, else stringify
if (x.text) return String(x.text);
if (x.content) return String(x.content);
return Object.keys(x).map(function(k){ return k + ": " + (typeof x[k] === "string" ?
}
return String(x);
}
async function callAPI(body) {
console.log("API call:", body.model, "system:", (body.system||"").slice(0,80), "msg:",
var resp = await fetch("/api/anthropic", {method:"POST",headers:{"Content-Type":"applic
var respText = await resp.text();
console.log("API response status:", resp.status, "body:", respText.slice(0, 300));
if (!resp.ok) throw new Error("API " + resp.status + ": " + respText.slice(0,200));
var d;
try { d = JSON.parse(respText); } catch(pe) { throw new Error("Resposta nao e JSON: " +
if (d.error) throw new Error("API error: " + (d.error.message || d.error.type || JSON.s
if (!d.content || !d.content.length) throw new Error("Resposta vazia da IA");
return d;
}
var warnings = [];
try {
var md = loadMacroData();
// Ordena: destaques primeiro (preserva ordem por data dentro de cada grupo)
var allReports = (md.macroReports || []).slice().sort(function(a,b){
// 1) Destaques primeiro
if (!!a.destaque !== !!b.destaque) return b.destaque ? 1 : -1;
// 2) Mais recentes depois
var da = new Date(a.date || 0).getTime();
var db = new Date(b.date || 0).getTime();
return db - da;
});
var macroReports = allReports.slice(0,3);
// 8000 chars por relatório (priorizando destaques) — mais contexto pra cenário macro
var macroText = macroReports.map(function(r){
var tag = r.destaque ? " [DESTAQUE]" : "";
return "=== " + (r.title||"Relatorio") + " (" + (r.date||"sem data") + ")" + tag + "
}).join("\n\n");
var hasMacroCtx = macroText.trim().length > 30;
console.log("[macro] contexto montado:", macroReports.length, "relatorios,", macroText.
var hojeBR = new Date().toLocaleDateString("pt-BR", {day:"2-digit", month:"long", year:
var profileCtx = "";
var posCtx = "";
if (genericMode) {
profileCtx = "Panorama geral (sem cliente especifico)" + (genericTitle ? ": " + gener
} else {
profileCtx = (selectedProfile.name||"") + ", " + (selectedProfile.age||"?") + " anos,
if (selectedProfile.posAssets) {
var topA = selectedProfile.posAssets.filter(function(a){return a.totalValue>0;}).so
if (topA.length > 0) posCtx = ". Top ativos: " + topA.map(function(a){return a.tick
}
}
// ── M5-B: Busca snapshot do cliente (se aplicavel) ──
var clientSnapshotBlock = "";
var clientSnapshotData = null;
if (!genericMode && useClientSnapshot && selectedProfile) {
setGenProgress("Buscando snapshot do cliente...");
try {
var snapInfo = await fetchClientSnapshotsForMeeting(selectedProfile.id);
if (snapInfo.latestAtual) {
clientSnapshotBlock = buildMeetingClientContextBlock(selectedProfile, snapInfo.la
clientSnapshotData = { latestAtual: snapInfo.latestAtual, savedAlvo: snapInfo.sav
console.log("[meeting] snapshot carregado:", snapInfo.latestAtual.snapshot_date);
} else {
console.log("[meeting] cliente nao tem snapshot atual — talk points sem contexto
}
} catch(sErr) {
console.warn("[meeting] snapshot fetch falhou (nao critico):", sErr);
}
}
res.clientContext = clientSnapshotData;
// ── MACRO ──
if (wantMacroShort || wantMacroDetail) {
setGenProgress("Gerando cenario macro...");
try {
var mPrompt = hasMacroCtx
? ("HOJE E " + hojeBR + ".\n\n"
GLOBAL
+ "RELATORIOS MACRO OFICIAIS DA SUNO (fonte unica de verdade — use TODO o conte
+ macroText.slice(0,25000) + "\n\n"
+ "INSTRUCOES:\n"
+ "1) Extraia os numeros DOS RELATORIOS ACIMA — eles contem Selic, IPCA, cambio
+ "2) Tanto o macroShort quanto o macroDetail devem usar EXATAMENTE os mesmos n
+ "3) A UNICA diferenca entre macroShort e macroDetail e o tamanho — short e re
+ "4) Nao mencione dados que nao estao nos relatorios. Nao use sua memoria de t
+ "5) Se um indicador especifico nao estiver claro nos relatorios, use outro qu
: ("HOJE E " + hojeBR + ". Sem relatorios macro salvos no sistema. Use apenas afi
if (wantMacroShort && wantMacroDetail) {
mPrompt += 'Gere JSON com EXATAMENTE dois campos: {"macroShort": "string aqui", "
+ 'IMPORTANTE: As chaves sao EXATAMENTE "macroShort" e "macroDetail" em camelCa
+ 'AMBOS macroShort e macroDetail devem usar A MESMA ESTRUTURA de 3 secoes sepa
+ 'A UNICA diferenca e a densidade de informacao:\n'
+ '- macroShort = 3 secoes CURTAS (1-2 frases cada, direto ao ponto, so os nume
+ '- macroDetail = 3 secoes MEDIAS (3-4 frases cada, densas mas enxutas — NAO e
+ 'FORMATO DO macroShort (usar \\n\\n entre secoes):\n\n'
+ 'BRASIL\\n[1-2 frases com Selic atual, IPCA 12m, direcao]\\n\\nCENARIO + 'Exemplo CORRETO do macroShort:\n'
+ '"macroShort": "BRASIL\\nSelic em 14,75% com tendencia de queda gradual. IPCA
+ 'FORMATO DO macroDetail (usar \\n\\n entre secoes, cada secao com 5-7 frases
+ 'BRASIL\\n[5-7 frases cobrindo: atividade economica (IBC-Br, PIB, mercado de
+ 'REGRA CRITICA DE TAMANHO: macroDetail inteiro deve ficar entre 1500 e 2500 c
+ 'REGRA CRITICA DE DADOS: macroShort e macroDetail devem usar OS MESMOS numero
} else if (wantMacroShort) {
mPrompt += 'Gere JSON: {"macroShort":"..."}\n\n'
+ 'FORMATO: 3 secoes CURTAS separadas por \\n\\n, cada uma com 1-2 frases:\n\n'
+ 'BRASIL\\n[1-2 frases com Selic, IPCA 12m, direcao]\\n\\nCENARIO GLOBAL\\n[1-
+ 'Use numeros concretos dos relatorios. NAO use emojis. Apenas letras, numeros
} else {
mPrompt += 'Gere JSON: {"macroDetail":"..."}\n\n'
+ 'FORMATO (string unica com 3 secoes DENSAS e RICAS em informacao separadas po
+ 'BRASIL\n[5-7 frases cobrindo: atividade (IBC-Br, PIB, mercado de trabalho, s
+ 'CENARIO GLOBAL\n[5-7 frases cobrindo: EUA (Fed, CPI, payroll, atividade), Eu
+ 'IMPLICACOES PARA PORTFOLIO\n[5-7 frases conectando o macro com recomendacoes
+ 'REGRA CRITICA DE TAMANHO: macroDetail entre 1500 e 2500 caracteres no total.
}
var mD = await callAPI({model:"claude-sonnet-4-6",max_tokens:4000,system:"Voce e um
var mRaw = extractText(mD.content);
console.log("[macro] IA raw (primeiros 500 chars):", mRaw ? mRaw.slice(0, 500) : "(
if (mRaw) {
var mP = safeParseJSON(mRaw);
console.log("[macro] parsed keys:", mP ? Object.keys(mP).join(",") : "(null)");
// Extrai chaves padrao
res.macroShort = cleanCitations(toStr(mP.macroShort)) || null;
res.macroDetail = cleanCitations(toStr(mP.macroDetail)) || null;
// Fallback: IA pode ter usado nomes ligeiramente diferentes
if (!res.macroShort && mP) {
res.macroShort = cleanCitations(toStr(mP.macro_short || mP.resumo || mP.short |
}
}
}
}
} else {
if (!res.macroDetail && mP) {
res.macroDetail = cleanCitations(toStr(mP.macro_detail || mP.detalhado || mP.de
// Warnings se ainda vazio
if (wantMacroShort && !res.macroShort) {
warnings.push("macro resumido vazio (chaves recebidas: " + (mP ? Object.keys(mP
if (wantMacroDetail && !res.macroDetail) {
warnings.push("macro detalhado vazio (chaves recebidas: " + (mP ? Object.keys(m
warnings.push("macro: IA retornou resposta vazia");
}
} catch(me) {
console.error("Macro err full:", me);
console.error("Macro err stack:", me.stack);
var errMsg = me.message || String(me);
if (errMsg.indexOf("timeout") >= 0 || errMsg.indexOf("504") >= 0 || errMsg.indexOf(
warnings.push("macro timeout — tente com menos relatorios");
} else if (errMsg.indexOf("JSON") >= 0 || errMsg.indexOf("parse") >= 0) {
warnings.push("macro JSON malformado: " + errMsg.slice(0,80));
} else {
warnings.push("macro: " + errMsg.slice(0,100));
}
}
}
// ── EMPRESAS ──
if (wantEmpresas) {
var eTickers = Object.keys(selectedEmpresas);
if (eTickers.length > 0) {
for (var eb = 0; eb < eTickers.length; eb += 3) {
var eBatch = eTickers.slice(eb, eb + 3);
setGenProgress("Analisando " + eBatch.join(", ") + "...");
var eCtx = eBatch.map(function(tk) {
var app = allAppStocks.find(function(s){return s.ticker===tk;});
if (!app) return {ticker:tk, naoEncontrada:true};
return {
ticker: tk,
nome: app.name || "",
carteira: app._portfolio || "",
sentiment: app.sentiment || "neutral",
rankScore: app.rankScore || null,
thesis: (app.thesis || "").slice(0,400),
resultado: (app.result || "").slice(0,400),
resultadoPros: (app.resultPros || []).slice(0,4),
resultadoCons: (app.resultCons || []).slice(0,4),
sunoView: (app.sunoView || "").slice(0,400)
};
e o qu
});
try {
var eSysPrompt = "Voce e um consultor CNPI senior preparando briefing para um c
+ "Para CADA empresa recebida, gere um resumo ESTRUTURADO em 4 blocos curtos
+ "TESE EM UMA LINHA\n[Uma frase de ate 20 palavras explicando a tese central
+ "DESTAQUES DO ULTIMO RESULTADO\n- [ponto 1 com numero]\n- [ponto 2 com nume
+ "PONTOS DE ATENCAO\n- [risco/fraqueza 1]\n- [risco/fraqueza 2]\n\n"
+ "VISAO SUNO E ACAO\n[Uma frase sobre preco-teto, margem de seguranca + "Use numeros concretos (percentuais, R$, multiplos). "
+ "FORMATO DA RESPOSTA — retorne UM OBJETO JSON simples onde cada CHAVE e o t
+ '{"VALE3": "TESE EM UMA LINHA\\nMineradora global...\\n\\nDESTAQUES...", "P
+ "Sem markdown, sem ```, sem preambulo, sem texto fora do JSON. Cada valor e
+ "CRITICO: NAO use emojis. Apenas letras, numeros, pontuacao basica e acento
var eD = await callAPI({model:"claude-sonnet-4-6",max_tokens:3000,system:eSysPr
var eRaw = extractText(eD.content);
console.log("[empresas] batch " + (eb/3+1) + " IA raw (400 chars):", eRaw ? eRa
if (eRaw) {
var eP = null;
try { eP = safeParseJSON(eRaw); } catch(parseErr) {
console.error("[empresas] parse falhou, tentando regex extract:", parseErr.
// Fallback manual: regex pra extrair "TICKER": "texto" pares
var regex = /"([A-Z0-9]{3,6})"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
var match;
var extracted = {};
var anyFound = false;
while ((match = regex.exec(eRaw)) !== null) {
extracted[match[1]] = match[2].replace(/\\n/g, "\n").replace(/\\"/g, '"')
anyFound = true;
}
if (anyFound) {
eP = extracted;
console.log("[empresas] fallback regex extraiu:", Object.keys(eP).length,
}
}
console.log("[empresas] parsed tipo:", Array.isArray(eP) ? "array(" + eP.leng
// Normalizar — aceita varios formatos
if (eP) {
if (Array.isArray(eP)) {
// Array de {ticker, summary}
eP.forEach(function(e){
if (e && e.ticker) {
res.empresas[e.ticker] = {ticker: e.ticker, summary: cleanCitations(t
}
});
} else if (typeof eP === "object") {
// Objeto — pode ser wrapper ou direto
var possibleArrays = [eP.empresas, eP.companies, eP.items, eP.results, eP
var foundArray = null;
for (var pai = 0; pai < possibleArrays.length; pai++) {
if (Array.isArray(possibleArrays[pai])) { foundArray = possibleArrays[p
}
if (foundArray) {
foundArray.forEach(function(e){
if (e && e.ticker) {
res.empresas[e.ticker] = {ticker: e.ticker, summary: cleanCitations
}
});
} else {
// Objeto-mapa: {TICKER: "texto" | {summary: "..."}}
Object.keys(eP).forEach(function(tk) {
var valor = eP[tk];
if (typeof valor === "string") {
res.empresas[tk] = {ticker: tk, summary: cleanCitations(valor)};
} else if (valor && typeof valor === "object") {
var txt = valor.summary || valor.text || valor.content || toStr(val
res.empresas[tk] = {ticker: tk, summary: cleanCitations(toStr(txt))
}
});
}
}
var countThisBatch = eBatch.filter(function(t){return res.empresas[t];}).le
console.log("[empresas] batch " + (eb/3+1) + " extraiu:", countThisBatch, "
if (countThisBatch === 0) {
warnings.push("empresas batch " + (eb/3+1) + " sem dados extraidos }
} else {
(keys:
warnings.push("empresas batch " + (eb/3+1) + " JSON invalido");
}
} else {
warnings.push("empresas batch " + (eb/3+1) + " resposta vazia");
}
} catch(ee) {
console.error("Empresas err batch " + (eb/3+1) + ":", ee);
console.error("Empresas err stack:", ee.stack);
var eErrMsg = ee.message || String(ee);
if (eErrMsg.indexOf("timeout") >= 0 || eErrMsg.indexOf("504") >= 0) {
warnings.push("empresas timeout no batch " + (eb/3+1));
} else {
warnings.push("empresas: " + eErrMsg.slice(0, 80));
}
}
}
}
}
// ── TALKING POINTS ──
if (wantTalkPoints) {
setGenProgress("Gerando " + (genericMode ? "pontos-chave" : "talking points") + "..."
try {
var tMsg;
if (genericMode) {
tMsg = "CONTEXTO: " + profileCtx + "\nTEMA/OBJETIVO: " + (meetingFocus || "panora
if (res.macroShort) tMsg += "\n\nCONTEXTO MACRO ATUAL:\n" + res.macroShort.slice(
tMsg += '\n\nGere PONTOS-CHAVE PARA APRESENTACAO enxutos estruturados em 3 blocos
+ 'MENSAGEM CENTRAL\n[1 frase resumindo a tese principal do panorama atual]\n\n
+ 'PONTOS PRINCIPAIS\n- [tema 1 com numero/dado concreto — 1-2 frases]\n- [tema
+ 'CONCLUSOES E DIRECIONAMENTOS\n- [conclusao acionavel 1 — 1 frase]\n- [conclu
+ 'REGRA CRITICA DE TAMANHO: talkPoints inteiro em ate 1200 caracteres. Linguag
+ 'Retorne APENAS JSON puro: {"talkPoints":"texto estruturado como UMA STRING c
} else {
tMsg = "CLIENTE: " + profileCtx + posCtx + "\nFOCO DA REUNIAO: " + (meetingFocus
// ── MACRO (prioriza detalhado quando existir; senão short; senão cru dos var macroForTP = "";
if (res.macroDetail) macroForTP = res.macroDetail;
else if (res.macroShort) macroForTP = res.macroShort;
else if (hasMacroCtx) macroForTP = macroText.slice(0, 6000);
if (macroForTP) tMsg += "\n\n=== CONTEXTO MACRO (use numeros especificos: Selic,
relató
if (clientSnapshotBlock) tMsg += "\n" + clientSnapshotBlock;
// ── M5-B v2: TESES dos ativos mais relevantes do cliente ──
var tesesBlock = "";
if (clientSnapshotData && clientSnapshotData.latestAtual) {
var ativosDoCliente = (clientSnapshotData.latestAtual.data && clientSnapshotDat
// Scoring: prioriza RV + status especial + tamanho da posição
function scoreAtivo(a) {
var s = 0;
// Prioridade máxima: status de ação (redução / em avaliação)
if (a.status_recomendacao === "reducao") s += 1000;
if (a.status_recomendacao === "em_avaliacao") s += 700;
// Prioriza RV (Ações BR, FIIs, Internacional, Alternativos) — RF/caixa têm s
if (a.classe === "acoes_br" || a.classe === "fiis" || a.classe === "internaci
// Tamanho da posição contribui (até ~10pp pra cima no score)
s += Math.min((a.pct_total || 0) * 10, 100);
// Se está fora de carteira Suno, ganha pontos (candidato a discussão)
if ((!a.carteiras_suno || a.carteiras_suno.length === 0) && a.classe !== "ren
return s;
}
var priorizados = ativosDoCliente.slice().sort(function(a,b){return scoreAtivo(
// Busca teses no data (p.data[portfolio] array)
var allStocksByTicker = {};
["Dividendos","Valor","Small Caps","Internacional"].forEach(function(port){
(p.data[port] || []).forEach(function(s){ if (s.ticker) allStocksByTicker[s.t
});
var tesesLinhas = [];
priorizados.forEach(function(a){
if (!a.ticker) return;
// Só faz sentido pra RV
if (a.classe === "renda_fixa" || a.classe === "caixa") return;
var tese = allStocksByTicker[a.ticker];
if (!tese) {
// Ativo sem tese Suno — é fora-de-carteira
tesesLinhas.push("\n[" + a.ticker + " — SEM TESE SUNO] Classe: " + (a.class
return;
Status
+ tese
}
// Monta tese resumida (respeitando espaço)
var parts = [];
parts.push("\n[" + a.ticker + " — " + tese._portfolio + "]");
parts.push("Posição do cliente: " + (a.pct_total||0).toFixed(1) + "% · if (typeof tese.rankScore === "number") parts.push("Rank Score Suno: " if (tese.sentiment) parts.push("Sentimento: " + tese.sentiment);
if (tese.quarter) parts.push("Último trimestre analisado: " + tese.quarter);
if (tese.thesis) parts.push("TESE: " + tese.thesis.slice(0, 600));
if (tese.thesisPros && tese.thesisPros.length) parts.push("PONTOS FORTES: " +
if (tese.thesisCons && tese.thesisCons.length) parts.push("RISCOS: " + tese.t
if (tese.result) parts.push("ÚLTIMO RESULTADO: " + tese.result.slice(0, 500))
if (tese.resultPros && tese.resultPros.length) parts.push("DESTAQUES RESULTAD
if (tese.resultCons && tese.resultCons.length) parts.push("ATENÇÃO RESULTADO:
if (tese.sunoView) parts.push("VISÃO SUNO: " + tese.sunoView.slice(0, 400));
tesesLinhas.push(parts.join("\n"));
});
if (tesesLinhas.length > 0) {
tesesBlock = "\n\n=== TESES SUNO — ATIVOS RELEVANTES DO CLIENTE (" + tesesLin
}
}
if (tesesBlock) tMsg += tesesBlock;
tMsg += '\n\nGere um roteiro de conversa ENXUTO e DIRETO estruturado em 4 blocos,
+ 'ABERTURA (1-2 frases)\n[Como iniciar a conversa conectando cenario atual com
+ 'PONTOS PRINCIPAIS A APRESENTAR\n- [ponto 1 — 2-3 frases MAX, bem direto]\n-
+ 'PERGUNTAS PARA FAZER AO CLIENTE\n- [pergunta aberta 1 — 1 frase curta]\n- [p
+ 'PROXIMOS PASSOS SUGERIDOS\n- [acao concreta 1 — 1-2 frases]\n- [acao concret
+ 'REGRA CRITICA DE TAMANHO: o talkPoints inteiro deve ter no MAXIMO 1800 carac
+ 'Personalize TUDO com base nos dados do cliente (idade, perfil de risco, hori
+ (clientSnapshotBlock
? 'CONEXOES OBRIGATORIAS (use as 3 fontes em conjunto — gaps, macro e teses),
+ '1) Para cada GAP CRITICO (>3pp), JUSTIFIQUE a direcao com 1 numero espec
+ '2) Para ATIVOS EM REDUCAO ou EM AVALIACAO, cite o rank Suno + 1 risco pr
+ '3) Para ATIVOS FORA DA CARTEIRA SUNO, mencione como candidato a discussa
+ '4) Escolha os 2-3 pontos MAIS RELEVANTES. Nao tente cobrir todos os ativ
+ '5) Use numeros ESPECIFICOS, mas poucos — 1-2 numeros por ponto basta. '
: '')
+ 'Retorne APENAS JSON puro: {"talkPoints":"texto estruturado como UMA STRING c
}
var tSystem = genericMode
? "Voce e um economista-chefe de research escrevendo pontos-chave institucionais
: "Voce e um consultor CNPI senior com 20 anos de experiencia. Esta ajudando um c
var tD = await callAPI({model:"claude-sonnet-4-6",max_tokens:1800,system:tSystem,me
var tRaw = extractText(tD.content);
if (tRaw) { var tP = safeParseJSON(tRaw); res.talkPoints = cleanCitations(toStr(tP.
} catch(te) { console.error("TP err:", te); warnings.push("talking points (" + te.mes
}
setResults(res);
if (warnings.length > 0) setError("Aviso: " + warnings.join("; "));
} catch(err) { console.error(err); setError("Erro: " + err.message); }
setGenerating(false); setGenProgress("");
}
// ── PDF Export (Premium Layout) ──
function generateMeetingPDF() {
setPdfGenerating(true);
try {
var doc = new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
var W=210, H=297;
var ML=22, MR=22, MT=24, MB=22;
var CW=W-ML-MR;
// Color palette
var CLR = {
accent: [180,40,40], // Suno red
accentLight: [240,222,222],
dark: [24,24,27], // near-black for titles
body: [55,55,63], // body text
muted: [130,130,140], // labels/meta
hairline: [230,230,232], // separators
cardBg: [250,250,252], // card fill
bullet: [180,40,40]
};
function setC(c){doc.setTextColor(c[0],c[1],c[2]);}
function setF(c){doc.setFillColor(c[0],c[1],c[2]);}
function setD(c){doc.setDrawColor(c[0],c[1],c[2]);}
function wrap(t,mw,sz){doc.setFontSize(sz);return doc.splitTextToSize(t||"",mw);}
// Header/footer decorators (called on each content page)
function drawPageFrame(pageNum, totalPages) {
// Top accent bar
setF(CLR.accent); doc.rect(0,0,W,1.2,"F");
// Header meta
doc.setFontSize(7); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text("SUNO ADVISORY HUB", ML, 10);
doc.setFont("helvetica","normal"); setC(CLR.muted);
var headerRight = (genericMode ? (genericTitle || "Panorama Macro") : (selectedProfil
doc.text(headerRight, W-MR, 10, {align:"right"});
// Hairline below header
setD(CLR.hairline); doc.setLineWidth(0.2);
doc.line(ML, 13, W-MR, 13);
// Footer
setD(CLR.hairline); doc.line(ML, H-14, W-MR, H-14);
doc.setFontSize(7); doc.setFont("helvetica","normal"); setC(CLR.muted);
doc.text("Briefing de Reunião", ML, H-9);
if (pageNum && totalPages) doc.text(pageNum + " / " + totalPages, W-MR, H-9, {align:"
// Bottom accent
setF(CLR.accent); doc.rect(0,H-1.2,W,1.2,"F");
}
var y=0;
function chk(n){
if(y+n > H-MB-4){
doc.addPage();
drawPageFrame(); // will be renumbered at the end
y=MT;
return true;
}
return false;
}
// Detecta títulos de seção: linhas em CAIXA ALTA ou rótulos terminados em ":"
// Exemplos que devem retornar true: "BRASIL", "CENARIO GLOBAL", "TESE EM UMA LINHA", "
function isSectionHeader(line) {
var trimmed = line.trim();
if (trimmed.length < 3 || trimmed.length > 70) return false;
// Se tem ":" seguido de conteúdo, é uma linha de dado (tipo "SELIC: 10.5%"), NÃO é h
var colonIdx = trimmed.indexOf(":");
if (colonIdx > 0 && colonIdx < trimmed.length - 2) return false;
// Rótulo puro terminando em ":" (ex: "BRASIL:")
var labelMatch = trimmed.match(/^([A-ZÀ-ÝÇ][A-ZÀ-ÝÇ\s]{2,40}):$/);
if (labelMatch) return true;
// Linha inteira em caixa alta (ex: "BRASIL", "CENARIO GLOBAL")
var letters = trimmed.replace(/[^A-Za-zÀ-ÿÇç]/g, "");
if (letters.length < 3) return false;
var uppers = letters.replace(/[^A-ZÀ-ÝÇ]/g, "");
var ratio = uppers.length / letters.length;
return ratio > 0.85;
}
// Detecta linhas de dado/indicador (ex: "SELIC: 10,50% subindo para 11,25%")
function isDataLine(line) {
var trimmed = line.trim();
var m = trimmed.match(/^([A-ZÀ-ÝÇ][A-ZÀ-ÝÇ]{1,20}):\s+(.+)/);
return m ? { label: m[1], value: m[2] } : null;
}
function isBullet(line) {
var t = line.trim();
return t.startsWith("•") || t.startsWith("- ") || t.startsWith("* ");
}
// Render a block of text with smart formatting: detects section headers and bullets
function renderStructuredText(text, opts) {
opts = opts || {};
var bodySize = opts.bodySize || 9.5;
var leading = opts.leading || 5.8;
var indent = opts.indent || 0;
var blocks = (text || "").split(/\n\n+/);
blocks.forEach(function(block, bi) {
var lines = block.split("\n");
lines.forEach(function(rawLine, lineIdx) {
var line = rawLine.replace(/\s+$/,"");
if (!line.trim()) { y += leading*0.6; return; }
// Section header inside a block (emoji + caps)
if (isSectionHeader(line)) {
chk(10);
// Extra top space before a sub-header (unless it's the first line of the first
if (!(bi===0 && lineIdx===0)) y += 2;
doc.setFontSize(8.8); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text(line, ML+indent, y);
y += 7;
doc.setFont("helvetica","normal");
return;
}
// Linha de dado "LABEL: valor" (ex: "SELIC: 10,5% subindo")
var dataLine = isDataLine(line);
if (dataLine) {
chk(leading+2);
// Red dot
setF(CLR.bullet);
doc.circle(ML+indent+1.8, y-1.4, 0.85, "F");
// Bold red label (mesma cor dos section headers do detalhado)
doc.setFontSize(bodySize); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text(dataLine.label + ":", ML+indent+6, y);
var labelW = doc.getTextWidth(dataLine.label + ": ");
// Value in normal weight, black body
doc.setFont("helvetica","normal"); setC(CLR.body);
var availW = CW - indent - 6 - labelW;
var valueLines = wrap(dataLine.value, availW, bodySize);
doc.text(valueLines[0] || "", ML+indent+6+labelW, y);
y += leading;
for (var vi = 1; vi < valueLines.length; vi++) {
chk(leading);
doc.setFontSize(bodySize); doc.setFont("helvetica","normal"); setC(CLR.body);
doc.text(valueLines[vi], ML+indent+6, y);
y += leading;
}
y += 1.5;
return;
}
// Bullet
if (isBullet(line)) {
var bText = line.trim().replace(/^[•\-\*]\s*/,"");
var wrappedB = wrap(bText, CW-indent-6, bodySize);
wrappedB.forEach(function(bl, bIdx) {
chk(leading+1);
if (bIdx===0) {
setF(CLR.bullet);
doc.circle(ML+indent+1.8, y-1.4, 0.85, "F");
}
doc.setFontSize(bodySize); doc.setFont("helvetica","normal"); setC(CLR.body);
doc.text(bl, ML+indent+6, y);
y += leading;
});
y += 1.2;
return;
}
// Regular body line
var wrapped = wrap(line, CW-indent, bodySize);
wrapped.forEach(function(wl) {
chk(leading+1);
doc.setFontSize(bodySize); doc.setFont("helvetica","normal"); setC(CLR.body);
doc.text(wl, ML+indent, y);
y += leading;
});
});
if (bi < blocks.length - 1) y += 4.5; // spacing between blocks (was 2.5)
});
}
// Section title (big, with accent underline)
function drawSectionTitle(title, subtitle) {
chk(32);
doc.setFontSize(7); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text("— SEÇÃO", ML, y);
y += 8;
doc.setFontSize(18); doc.setFont("helvetica","bold"); setC(CLR.dark);
doc.text(title, ML, y);
y += 3.5;
// Accent underline
setF(CLR.accent); doc.rect(ML, y, 20, 0.9, "F");
y += 6;
if (subtitle) {
doc.setFontSize(9); doc.setFont("helvetica","italic"); setC(CLR.muted);
doc.text(subtitle, ML, y);
y += 10;
} else {
y += 6;
}
}
// ═══════════════════════════════════════════════════════
// COVER PAGE
// ═══════════════════════════════════════════════════════
// Full red top band
setF(CLR.accent); doc.rect(0,0,W,42,"F");
doc.setFontSize(9); doc.setFont("helvetica","bold"); setC([255,255,255]);
doc.text("SUNO ADVISORY HUB", ML, 18);
doc.setFontSize(7); doc.setFont("helvetica","normal");
doc.text("Relatório Confidencial · Uso Interno do Consultor", ML, 24);
// Subtle rule at bottom of band
setF([220,180,180]); doc.rect(ML, 35, 26, 0.5, "F");
// Large title
doc.setFontSize(36); doc.setFont("helvetica","bold"); setC(CLR.dark);
if (genericMode) {
doc.text("Panorama", ML, 78);
doc.text("Macro", ML, 94);
} else {
doc.text("Preparo de", ML, 78);
doc.text("Reunião", ML, 94);
}
// Decorative element
setF(CLR.accent); doc.rect(ML, 102, 60, 1.2, "F");
// Client/Generic card
var cardY = 120;
setF(CLR.cardBg); doc.roundedRect(ML, cardY, CW, 52, 3, 3, "F");
setD(CLR.hairline); doc.roundedRect(ML, cardY, CW, 52, 3, 3, "S");
// Left accent inside card
setF(CLR.accent); doc.rect(ML, cardY, 1.5, 52, "F");
doc.setFontSize(7); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text(genericMode ? "PANORAMA" : "CLIENTE", ML+8, cardY+10);
doc.setFontSize(16); doc.setFont("helvetica","bold"); setC(CLR.dark);
if (genericMode) {
doc.text(genericTitle || "Panorama Macro Geral", ML+8, cardY+20);
} else {
doc.text(selectedProfile ? selectedProfile.name : "—", ML+8, cardY+20);
}
// Meta
doc.setFontSize(8); doc.setFont("helvetica","normal"); setC(CLR.muted);
var metaLines = [];
if (genericMode) {
if (meetingFocus) metaLines.push(meetingFocus);
} else if (selectedProfile) {
if (selectedProfile.age) metaLines.push(selectedProfile.age + " anos");
if (selectedProfile.riskProfile) metaLines.push("Perfil: " + selectedProfile.riskProf
if (selectedProfile.horizon) metaLines.push("Horizonte: " + selectedProfile.horizon +
}
if (metaLines.length) doc.text(metaLines.join(" · "), ML+8, cardY+28);
doc.setFontSize(7); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text(genericMode ? "DATA" : "DATA DA REUNIÃO", ML+8, cardY+38);
doc.setFontSize(10); doc.setFont("helvetica","normal"); setC(CLR.dark);
doc.text(meetingDate, ML+8, cardY+44);
if (meetingFocus) {
doc.setFontSize(7); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text("FOCO", ML+80, cardY+38);
doc.setFontSize(10); doc.setFont("helvetica","normal"); setC(CLR.dark);
var focusLines = wrap(meetingFocus, CW-90, 10);
focusLines.slice(0,2).forEach(function(l, i){ doc.text(l, ML+80, cardY+44+(i*4)); });
}
// Table of contents
var tocY = cardY + 72;
doc.setFontSize(7); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text("CONTEÚDO DESTE BRIEFING", ML, tocY);
tocY += 7;
doc.setFontSize(10); doc.setFont("helvetica","normal"); setC(CLR.dark);
var tocItems = [];
if (!genericMode && useClientSnapshot && results.clientContext && results.clientContext
if (results.macroShort) tocItems.push("Cenário Macro · Resumo Executivo");
if (results.macroDetail) tocItems.push("Cenário Macro · Análise Detalhada");
if (Object.keys(results.empresas).length > 0) tocItems.push("Empresas em Foco (" if (results.talkPoints) tocItems.push(genericMode ? "Pontos-Chave para Apresentação" :
tocItems.forEach(function(item, i) {
setF(CLR.accent); doc.circle(ML+1.5, tocY-1.3, 0.9, "F");
doc.setFontSize(10); setC(CLR.body); doc.setFont("helvetica","normal");
doc.text(item, ML+6, tocY);
tocY += 6;
});
+ Obje
// Bottom cover band
setF(CLR.accent); doc.rect(0,H-1.5,W,1.5,"F");
doc.setFontSize(6.5); doc.setFont("helvetica","normal"); setC(CLR.muted);
doc.text("Gerado em " + new Date().toLocaleString("pt-BR"), ML, H-7);
doc.text("CONFIDENCIAL", W-MR, H-7, {align:"right"});
// ═══════════════════════════════════════════════════════
// CONTENT PAGES
// ═══════════════════════════════════════════════════════
doc.addPage();
drawPageFrame();
y = MT;
// M5-B: ESTADO DO CLIENTE (se aplicável)
if (!genericMode && useClientSnapshot && results.clientContext && results.clientContext
var ctx = results.clientContext;
var snap = ctx.latestAtual.data || {};
var allocCli = snap.alocacao || {};
var ativosCli = snap.ativos || [];
var patrCli = snap.patrimonio_total || 0;
var tgtCli = resolveTarget(ctx.savedAlvo, selectedProfile.jbData);
var metasCli = (tgtCli && tgtCli.metas) || {};
drawSectionTitle("Estado do Cliente", "Snapshot de " + ctx.latestAtual.snapshot_date)
// Bloco de metas
var metasLinhas = [];
if (metasCli.capitalAlvo) metasLinhas.push(["Patrimônio atual", "R$ " + patrCli.toLoc
if (metasCli.capitalAlvo) metasLinhas.push(["Patrimônio-alvo", "R$ " + metasCli.capit
if (metasCli.capitalAlvo && patrCli > 0) metasLinhas.push(["Progresso ao alvo", ((pat
if (metasCli.rendaPassivaMeta) metasLinhas.push(["Renda projetada", "R$ " + metasCli.
if (metasCli.aporteMensalNecessario) metasLinhas.push(["Aporte mensal", "R$ " + metas
if (metasCli.idadeAposentadoria) metasLinhas.push(["Idade aposentadoria", metasCli.id
if (metasLinhas.length > 0) {
chk(10 + (metasLinhas.length * 5.5));
// Card com metas em 2 colunas — com espacamento flexivel entre label e valor
var colW = (CW - 4) / 2;
// Label ocupa ~42% da coluna, valor alinhado logo depois sem espaco fixo rigido
var labelW = colW * 0.48;
metasLinhas.forEach(function(row, idx){
var col = idx % 2;
var rowY = y + Math.floor(idx / 2) * 5.5;
var x = ML + col * (colW + 4);
doc.setFontSize(7.5); doc.setFont("helvetica","normal"); setC(CLR.muted);
doc.text(sanitizePDFText(row[0]).toUpperCase(), x, rowY);
doc.setFontSize(10); doc.setFont("helvetica","bold"); setC(CLR.dark);
doc.text(sanitizePDFText(row[1]), x + labelW, rowY);
});
y += Math.ceil(metasLinhas.length / 2) * 5.5 + 6;
}
// Alocação por classe (tabela visual: classe | atual | alvo | gap)
var CLASS_ORDER_PDF = ["renda_fixa","acoes_br","fiis","internacional","alternativos",
var CLASS_LABELS_PDF = {renda_fixa:"Renda Fixa", acoes_br:"Ações BR", fiis:"FIIs", in
var allocRows = [];
CLASS_ORDER_PDF.forEach(function(cls){
var atPct = (allocCli[cls] && allocCli[cls].pct) || 0;
var tgPct = (tgtCli && tgtCli.allocMacro && tgtCli.allocMacro[cls]) || 0;
if (atPct > 0 || tgPct > 0) {
var gap = +(atPct - tgPct).toFixed(2);
allocRows.push({cls:cls, label: CLASS_LABELS_PDF[cls], atPct:atPct, tgPct:tgPct,
}
});
if (allocRows.length > 0) {
chk(14 + allocRows.length * 7);
y += 4;
// Header
doc.setFontSize(8); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text("ALOCAÇÃO POR CLASSE", ML, y);
y += 5;
// Column headers — posicionamento baseado em CW para evitar apertar colunas // Layout: CLASSE (esquerda) | ATUAL | ALVO | GAP (margem direita).
// Colunas numericas ocupam a metade direita da tabela.
var colAtualX = ML + CW * 0.56;
var colAlvoX = ML + CW * 0.74;
var colGapX = ML + CW;
doc.setFontSize(7); doc.setFont("helvetica","normal"); setC(CLR.muted);
doc.text("CLASSE", ML, y);
doc.text("ATUAL", colAtualX, y, {align:"right"});
doc.text("ALVO", colAlvoX, y, {align:"right"});
doc.text("GAP", colGapX, y, {align:"right"});
y += 2.5;
setD(CLR.hairline); doc.setLineWidth(0.25); doc.line(ML, y, ML + CW, y);
y += 4;
em CW
allocRows.forEach(function(r){
// Row — texto da classe e numeros
doc.setFontSize(9); doc.setFont("helvetica","normal"); setC(CLR.body);
doc.text(sanitizePDFText(r.label), ML, y);
setC(CLR.dark);
doc.text(r.atPct.toFixed(1) + "%", colAtualX, y, {align:"right"});
setC(CLR.muted);
doc.text(r.tgPct > 0 ? r.tgPct.toFixed(1) + "%" : "-", colAlvoX, y, {align:"right
// Gap com cor
var absGap = Math.abs(r.gap);
var gapColor;
if (absGap < 3) gapColor = [74, 180, 100]; else if (absGap < 8) gapColor = [220, 160, 40]; // amarelo
else gapColor = [200, 60, 60]; // verde
// vermelho
if (r.tgPct > 0) {
var arrow = r.gap > 0 ? "+" : "-";
doc.setFont("helvetica","bold"); setC(gapColor);
doc.text(arrow + absGap.toFixed(1) + "pp", colGapX, y, {align:"right"});
} else {
setC(CLR.muted);
doc.text("-", colGapX, y, {align:"right"});
}
// Mini-barra de progresso abaixo — largura restrita a 50% do CW para nao invadir
// as colunas numericas a direita. Evita conflito visual com os textos das coluna
y += 1.8;
var barMax = Math.max(r.atPct, r.tgPct, 30);
var barTotalW = CW * 0.48; // ~80mm em CW=166, bem antes da coluna ATUAL
var atBarW = (r.atPct / barMax) * barTotalW;
var tgBarW = (r.tgPct / barMax) * barTotalW;
setF([240, 240, 244]); doc.rect(ML, y, barTotalW, 1.8, "F");
// cor da classe aproximada
var classClr = r.cls==="renda_fixa" ? [59,130,246] : r.cls==="acoes_br" ? [220,38
setF(classClr); doc.rect(ML, y, atBarW, 1.8, "F");
if (r.tgPct > 0) {
// marca do alvo como linha vertical
setD([80,80,90]); doc.setLineWidth(0.5); doc.line(ML + tgBarW, y - 0.3, ML + tg
}
y += 4.8;
});
y += 4;
}
// Reserva (se houver)
if (snap.reserva && (snap.reserva.meses_cobertos !== null || snap.reserva.meses_alvo
chk(8);
doc.setFontSize(8); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text("RESERVA DE EMERGÊNCIA", ML, y);
y += 5;
var resTxt = [];
if (snap.reserva.meses_cobertos !== null) resTxt.push(snap.reserva.meses_cobertos +
if (snap.reserva.meses_alvo !== null) resTxt.push("alvo " + snap.reserva.meses_alvo
resTxt.push(snap.reserva.dentro_da_rf ? "dentro da RF" : "separada da RF");
doc.setFontSize(9); doc.setFont("helvetica","normal"); setC(CLR.body);
doc.text(sanitizePDFText(resTxt.join(" · ")), ML, y);
y += 8;
}
// Top 3 gaps críticos como bullets
var topGaps = allocRows.slice().filter(function(r){return r.tgPct > 0 && Math.abs(r.g
if (topGaps.length > 0) {
chk(12 + topGaps.length * 5);
doc.setFontSize(8); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text("GAPS CRÍTICOS (>3pp)", ML, y);
y += 5;
topGaps.forEach(function(g){
doc.setFontSize(9); doc.setFont("helvetica","normal"); setC(CLR.body);
var direction = g.gap > 0 ? "acima" : "abaixo";
var txt = "• " + g.label + " está " + direction + " do alvo em " + Math.abs(g.gap
var lines = wrap(txt, CW - 4, 9);
lines.forEach(function(l){ doc.text(sanitizePDFText(l), ML, y); y += 4.5; });
});
y += 4;
}
// Ativos em Redução/Em avaliação (sinais de ação)
var emReducao = ativosCli.filter(function(a){return a.status_recomendacao==="reducao"
var emAv = ativosCli.filter(function(a){return a.status_recomendacao==="em_avaliacao"
if (emReducao.length > 0 || emAv.length > 0) {
chk(12 + (emReducao.length + emAv.length) * 4);
doc.setFontSize(8); doc.setFont("helvetica","bold"); setC(CLR.accent);
doc.text("ATIVOS MARCADOS PARA AÇÃO", ML, y);
y += 5;
if (emReducao.length > 0) {
doc.setFontSize(9); doc.setFont("helvetica","bold"); setC([200,60,60]);
doc.text("Em redução (" + emReducao.length + "):", ML, y); y += 4.2;
doc.setFont("helvetica","normal"); setC(CLR.body);
emReducao.forEach(function(a){
doc.text(sanitizePDFText(" • " + (a.ticker || a.nome_original) + " — " + (a.pc
});
y += 1;
}
if (emAv.length > 0) {
doc.setFontSize(9); doc.setFont("helvetica","bold"); setC([220,160,40]);
doc.text("Em avaliação (" + emAv.length + "):", ML, y); y += 4.2;
doc.setFont("helvetica","normal"); setC(CLR.body);
emAv.forEach(function(a){
doc.text(sanitizePDFText(" • " + (a.ticker || a.nome_original) + " — " + (a.pc
});
}
y += 6;
}
y += 6;
}
// MACRO RESUMO
if (results.macroShort) {
drawSectionTitle("Cenário Macro", "Resumo executivo dos principais indicadores");
renderStructuredText(results.macroShort, {bodySize:9.5, leading:5.8});
y += 10;
}
// MACRO DETALHADO
if (results.macroDetail) {
if (results.macroShort) y += 6;
drawSectionTitle("Cenário Macro · Detalhado", "Análise aprofundada por dimensão");
renderStructuredText(results.macroDetail, {bodySize:9.5, leading:5.8});
y += 10;
}
// EMPRESAS
if (Object.keys(results.empresas).length > 0) {
y += 6;
drawSectionTitle("Empresas em Foco", Object.keys(results.empresas).length + " ativos
Object.keys(results.empresas).forEach(function(tk, idx) {
var e = results.empresas[tk];
var summary = e.summary || "";
if (!summary.trim()) return;
// Strategy: render content first to measure, then draw card behind it
// Step 1: Pre-flight measure the content
var innerPad = 7;
var innerLeading = 5.5;
var innerBodySize = 9.2;
var blocks = summary.split(/\n\n+/);
var estHeight = 0;
blocks.forEach(function(block, bi) {
var lns = block.split("\n");
lns.forEach(function(rawLine, lineIdx) {
var line = rawLine.replace(/\s+$/,"");
if (!line.trim()) { estHeight += innerLeading*0.6; return; }
if (isSectionHeader(line)) {
if (!(bi===0 && lineIdx===0)) estHeight += 2;
estHeight += 7;
return;
}
if (isBullet(line)) {
var bText = line.trim().replace(/^[•\-\*]\s*/,"");
var wrappedB = wrap(bText, CW-innerPad*2-6, innerBodySize);
estHeight += wrappedB.length * innerLeading + 1.2;
return;
}
});
var wrapped = wrap(line, CW-innerPad*2, innerBodySize);
estHeight += wrapped.length * innerLeading;
if (bi < blocks.length - 1) estHeight += 4.5;
});
var headerHeight = 11; // ticker + company name row
var bottomPad = 8;
var cardHeight = headerHeight + estHeight + bottomPad;
chk(cardHeight + 4);
var cardTop = y;
// Card background
setF(CLR.cardBg); doc.roundedRect(ML, cardTop, CW, cardHeight, 2.5, 2.5, "F");
setD(CLR.hairline); doc.roundedRect(ML, cardTop, CW, cardHeight, 2.5, 2.5, "S");
// Left accent bar
setF(CLR.accent); doc.rect(ML, cardTop, 1.5, cardHeight, "F");
// Ticker header
doc.setFontSize(13); doc.setFont("helvetica","bold"); setC(CLR.dark);
doc.text(tk, ML+innerPad, cardTop+9);
var tickerWidth = doc.getTextWidth(tk);
// Lookup company name from app data
var appStock = allAppStocks.find(function(s){return s.ticker===tk;});
if (appStock && appStock.name) {
// Bullet separator (small gray dot) + nome
setF(CLR.muted);
doc.circle(ML+innerPad+tickerWidth+4, cardTop+7.5, 0.5, "F");
doc.setFontSize(9); doc.setFont("helvetica","normal"); setC(CLR.muted);
doc.text(appStock.name, ML+innerPad+tickerWidth+8, cardTop+9);
}
// Thin separator below ticker header
setD(CLR.hairline); doc.setLineWidth(0.15);
doc.line(ML+innerPad, cardTop+11.5, ML+CW-innerPad, cardTop+11.5);
// Render summary inside card
y = cardTop + headerHeight + 4;
renderStructuredText(summary, {bodySize:innerBodySize, leading:innerLeading, y = cardTop + cardHeight + 7; // bigger gap between cards
indent
});
}
// TALKING POINTS
if (results.talkPoints) {
y += 6;
drawSectionTitle(genericMode ? "Pontos-Chave para Apresentação" : "Roteiro de Convers
renderStructuredText(results.talkPoints, {bodySize:10, leading:6.2});
}
// ═══════════════════════════════════════════════════════
// PAGE NUMBERING (final pass)
// ═══════════════════════════════════════════════════════
var pc = doc.internal.getNumberOfPages();
// Skip cover (page 1); number content pages 1..N
var contentPages = pc - 1;
for (var pg = 2; pg <= pc; pg++) {
doc.setPage(pg);
// Clear existing footer area and redraw cleanly with correct number
setF([255,255,255]); doc.rect(0, H-13.5, W, 13.5, "F");
setD(CLR.hairline); doc.setLineWidth(0.2); doc.line(ML, H-14, W-MR, H-14);
doc.setFontSize(7); doc.setFont("helvetica","normal"); setC(CLR.muted);
doc.text((genericMode ? "Panorama Macro · " + (genericTitle || "Geral") : "Briefing d
doc.text((pg-1) + " / " + contentPages, W-MR, H-9, {align:"right"});
setF(CLR.accent); doc.rect(0,H-1.2,W,1.2,"F");
}
var fname = (genericMode ? "panorama-" + ((genericTitle || "macro").replace(/\s+/g,"-")
doc.save(fname);
} catch(err){ console.error(err); alert("Erro PDF: " + err.message); }
setPdfGenerating(false);
}
var iS={width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255
var lS={fontSize:"10px",fontWeight:600,color:"rgba(255,255,255,0.5)",marginBottom:"4px",dis
var btnBase={padding:"8px 16px",borderRadius:"8px",border:"none",cursor:"pointer",fontWeigh
// Client position assets — merge de snapshot ativos (prioridade) + posAssets (fallback).
// Dedupe por ticker. Filtro basico: apenas ativos com ticker valido.
var clientAssets = [];
if (selectedProfile) {
var seenTk = {};
// 1) Primeiro: ativos do snapshot (mais atualizado, inclui classe + status)
(clientSnapshotAtivos || []).forEach(function(a){
if (a && a.ticker && !seenTk[a.ticker]) {
seenTk[a.ticker] = true;
clientAssets.push(a);
}
});
// 2) Fallback adicional: posAssets que nao esteja no snapshot (garante retrocompat)
if (selectedProfile.posAssets) {
selectedProfile.posAssets.forEach(function(a){
if (a && a.ticker && !seenTk[a.ticker] && a.totalValue > 0) {
seenTk[a.ticker] = true;
clientAssets.push({ ticker: a.ticker, name: a.name || a.ticker, totalValue: a.total
}
});
}
}
// Generic mode: use all stocks from carteirasData (Suno portfolios)
var genericAssets = [];
if (genericMode) {
var seenTickers = {};
Object.keys(carteirasData || {}).forEach(function(portKey) {
var port = carteirasData[portKey];
if (port && Array.isArray(port.stocks)) {
port.stocks.forEach(function(s){
if (s && s.ticker && !seenTickers[s.ticker]) {
seenTickers[s.ticker] = true;
genericAssets.push({ticker: s.ticker, name: s.name || "", _portfolio: port.name |
}
});
}
});
// Fallback: use allAppStocks if carteirasData is empty
if (genericAssets.length === 0) {
allAppStocks.forEach(function(s){
if (s && s.ticker && !seenTickers[s.ticker]) {
seenTickers[s.ticker] = true;
genericAssets.push({ticker: s.ticker, name: s.name || "", _portfolio: s._portfolio
}
});
}
}
var availableAssets = genericMode ? genericAssets : clientAssets;
var canGenerate = genericMode || !!selectedProfile;
return (
<div style={p.inline?{padding:"0"}:{position:"fixed",inset:0,zIndex:2000,background:"rgba
<div style={{background:"#0A0A0A",borderRadius:"16px",border:"1px solid rgba(139,92,246
{/* Header */}
<div style={{padding:"20px 24px 14px",borderBottom:"1px solid rgba(255,255,255,0.06)"
<div><div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>{genericMode <button onClick={p.onClose} style={{background:"transparent",border:"none",color:"r
</div>
? "Pan
<div style={{padding:"16px 24px 24px"}}>
{error&&<div style={{color:"#f87171",fontSize:"11px",padding:"8px 10px",background:
{/* Mode Toggle */}
<div style={{display:"flex",gap:"6px",marginBottom:"16px",padding:"4px",background:
<button onClick={function(){setGenericMode(false);setResults(null);}} style={{fle
<button onClick={function(){setGenericMode(true);setResults(null);setSelectedProf
</div>
{/* Client/Generic + Date + Focus */}
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"8px",marginBotto
{genericMode ? (
<div><label style={lS}>Título do Panorama</label><input value={genericTitle} on
) : (
<div><label style={lS}>Cliente</label><select value={selectedProfileId} onChang
)}
</div>
<div><label style={lS}>Data</label><input type="date" value={meetingDate} onChang
<div><label style={lS}>{genericMode ? "Tema / Objetivo" : "Foco / Pauta"}</label>
{canGenerate&&(<div>
{/* Module selection */}
<div style={{fontSize:"10px",fontWeight:700,color:"#a78bfa",textTransform:"upperc
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px",marginBottom:
<label style={{display:"flex",alignItems:"center",gap:"8px",padding:"10px 12px"
<input type="checkbox" checked={wantMacroShort} onChange={function(e){setWant
<div><div style={{fontSize:"11px",fontWeight:600,color:wantMacroShort?"#a78bf
</label>
<label style={{display:"flex",alignItems:"center",gap:"8px",padding:"10px 12px"
<input type="checkbox" checked={wantMacroDetail} onChange={function(e){setWan
<div><div style={{fontSize:"11px",fontWeight:600,color:wantMacroDetail?"#a78b
</label>
<label style={{display:"flex",alignItems:"center",gap:"8px",padding:"10px 12px"
<input type="checkbox" checked={wantEmpresas} onChange={function(e){setWantEm
<div><div style={{fontSize:"11px",fontWeight:600,color:wantEmpresas?"#a78bfa"
</label>
<label style={{display:"flex",alignItems:"center",gap:"8px",padding:"10px 12px"
<input type="checkbox" checked={wantTalkPoints} onChange={function(e){setWant
<div><div style={{fontSize:"11px",fontWeight:600,color:wantTalkPoints?"#a78bf
</label>
</div>
{/* M5-B: toggle pra usar snapshot do cliente no talk points e PDF */}
{!genericMode && selectedProfile && (
<label style={{display:"flex",alignItems:"center",gap:"10px",padding:"10px 12px
<input type="checkbox" checked={useClientSnapshot} onChange={function(e){setU
<div style={{flex:1}}>
<div style={{fontSize:"11px",fontWeight:600,color:useClientSnapshot?"#60a5f
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.3)",marginTop:"2px",l
</div>
</label>
)}
{/* Empresa selection (if checked) */}
{wantEmpresas && (
(availableAssets.length > 0) ? (
<div style={{marginBottom:"14px"}}>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"cent
<span style={{fontSize:"9px",fontWeight:600,color:"rgba(255,255,255,0.4)"
<div style={{display:"flex",gap:"4px"}}>
<button onClick={function(){var sel={};availableAssets.forEach(function
<button onClick={function(){var sel={};availableAssets.forEach(function
<button onClick={function(){setSelectedEmpresas({});}} style={{fontSize
</div>
</div>
<div style={{display:"flex",flexWrap:"wrap",gap:"4px",maxHeight:"120px",ove
{availableAssets.filter(function(a){return /^[A-Z]{3,6}\d{0,2}$/.test(a.t
var isSel=!!selectedEmpresas[a.ticker];
return <button key={a.ticker} onClick={function(){setSelectedEmpresas(f
})}
</div>
</div>
) : (
!genericMode && selectedProfile ? (
<div style={{marginBottom:"14px",padding:"10px 12px",borderRadius:"8px",bac
<div style={{fontSize:"10px",color:"rgba(251,191,36,0.8)",fontWeight:600,
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",lineHeight:1.4}
</div>
) : (!selectedProfile && !genericMode ? (
<div style={{marginBottom:"14px",padding:"10px 12px",borderRadius:"8px",bac
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.45)",lineHeight:1.4
</div>
) : null)
)
)}
{/* Generate button */}
{!results&&(<div>
<button onClick={generateAll} disabled={generating} style={Object.assign({},btn
{generating?genProgress:"Gerar Briefing"}
</button></div>)}
{/* Results */}
{results&&(<div>
<div style={{fontSize:"10px",fontWeight:700,color:"#4ade80",textTransform:"uppe
{/* M5-B: Estado do Cliente (read-only, derivado do snapshot) */}
{results.clientContext && results.clientContext.latestAtual && (function(){
var ctx = results.clientContext;
var snap = ctx.latestAtual.data || {};
var allocPrev = snap.alocacao || {};
var patrPrev = snap.patrimonio_total || 0;
var tgtPrev = resolveTarget(ctx.savedAlvo, selectedProfile.jbData);
var metasPrev = (tgtPrev && tgtPrev.metas) || {};
var ATIVOS_STATUS = (snap.ativos || []);
var ativosRed = ATIVOS_STATUS.filter(function(a){return a.status_recomendacao
var ativosAv = ATIVOS_STATUS.filter(function(a){return a.status_recomendacao=
var rows = ["renda_fixa","acoes_br","fiis","internacional","alternativos","ca
var atPct = (allocPrev[cls] && allocPrev[cls].pct) || 0;
var tgPct = (tgtPrev && tgtPrev.allocMacro && tgtPrev.allocMacro[cls]) || 0
if (atPct <= 0 && tgPct <= 0) return null;
var gap = +(atPct - tgPct).toFixed(2);
var absGap = Math.abs(gap);
var gapColor = tgPct <= 0 ? "rgba(255,255,255,0.3)" : (absGap < 3 ? "#4ade8
return {cls:cls, atPct:atPct, tgPct:tgPct, gap:gap, gapColor:gapColor};
}).filter(Boolean);
var CLS_L = {renda_fixa:"Renda Fixa", acoes_br:"Ações BR", fiis:"FIIs", inter
return <div style={{background:"linear-gradient(135deg, rgba(59,130,246,0.06)
<div style={{display:"flex",justifyContent:"space-between",alignItems:"cent
<div style={{fontSize:"9px",fontWeight:700,color:"#60a5fa",textTransform:
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)"}}>Snapshot de {
</div>
{/* Metas mini-cards */}
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(12
<div><div style={{fontSize:"8px",color:"rgba(255,255,255,0.4)",textTransf
{metasPrev.capitalAlvo && <div><div style={{fontSize:"8px",color:"rgba(25
{metasPrev.capitalAlvo && patrPrev > 0 && <div><div style={{fontSize:"8px
{metasPrev.rendaPassivaMeta && <div><div style={{fontSize:"8px",color:"rg
</div>
{/* Gaps por classe */}
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.5)",marginBottom:"5px
<div style={{display:"flex",flexDirection:"column",gap:"3px"}}>
{rows.map(function(r){
return <div key={r.cls} style={{display:"flex",justifyContent:"space-be
<span style={{color:"#f1f5f9",fontWeight:600}}>{CLS_L[r.cls]}</span>
<span style={{display:"flex",gap:"10px",alignItems:"center",fontVaria
<span style={{color:"rgba(255,255,255,0.85)",fontWeight:700}}>{r.at
<span style={{color:"rgba(255,255,255,0.35)"}}>alvo {r.tgPct.toFixe
{r.tgPct > 0 && <span style={{color:r.gapColor,fontWeight:700,minWi
{r.tgPct === 0 && <span style={{color:"rgba(255,255,255,0.3)",minWi
</span>
</div>;
})}
</div>
{/* Ativos marcados */}
{(ativosRed.length > 0 || ativosAv.length > 0) && (
<div style={{marginTop:"10px",paddingTop:"8px",borderTop:"1px dashed rgba
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.5)",marginBottom:
{ativosRed.length > 0 && <div style={{fontSize:"10px",color:"rgba(255,2
{ativosAv.length > 0 && <div style={{fontSize:"10px",color:"rgba(255,25
</div>
)}
</div>;
})()}
{results.macroShort&&(<div style={{background:"#111",borderRadius:"10px",paddin
<div style={{fontSize:"9px",fontWeight:700,color:"#a78bfa",textTransform:"upp
<textarea value={results.macroShort} onChange={function(e){setResults(Object.
</div>)}
{results.macroDetail&&(<div style={{background:"#111",borderRadius:"10px",paddi
<div style={{fontSize:"9px",fontWeight:700,color:"#a78bfa",textTransform:"upp
<textarea value={results.macroDetail} onChange={function(e){setResults(Object
</div>)}
{Object.keys(results.empresas).length>0&&(<div style={{marginBottom:"8px"}}>
<div style={{fontSize:"9px",fontWeight:700,color:"#a78bfa",textTransform:"upp
{Object.keys(results.empresas).map(function(tk){
var e=results.empresas[tk];
return <div key={tk} style={{background:"#111",borderRadius:"8px",padding:"
<div style={{fontWeight:800,fontSize:"12px",color:"#f1f5f9",marginBottom:
<textarea value={e.summary||""} onChange={function(e2){setResults(functio
</div>;
})}
</div>)}
{results.talkPoints&&(<div style={{background:"#111",borderRadius:"10px",paddin
<div style={{fontSize:"9px",fontWeight:700,color:"#a78bfa",textTransform:"upp
<textarea value={results.talkPoints} onChange={function(e){setResults(Object.
</div>)}
<div style={{display:"flex",gap:"8px"}}>
<button onClick={function(){setResults(null);}} style={Object.assign({},btnBa
<button onClick={generateMeetingPDF} disabled={pdfGenerating} style={Object.a
</div>
</div>)}
</div>)}
{!canGenerate&&<div style={{textAlign:"center",padding:"40px 0",color:"rgba(255,255
</div>
</div>
</div>
);
}
/* ─── Consultive Report Module v3 — 2 Sub-abas (Estratégia + Recomendação) ─── */
var CONSULT_TAB_STRATEGY = "strategy";
var CONSULT_TAB_RECOMMEND = "recommend";
// ─────────────────────────────────────────────────────────────
// FEATURE FLAG — Recomendação Mensal V2 (big bang redesign)
// Ativa com ?novoFluxo=1 na URL. Coexiste com o fluxo velho.
// Quando validado 100%, remover o velho.
// ─────────────────────────────────────────────────────────────
function isRecFlowV2Active() {
// Fluxo V2 agora é o padrão — sempre ativo
return true;
}
var REC_V2_STEPS = ["estado","ordens","pdfs"];
var REC_V2_STEP_LABELS = {estado:"1. Estado",ordens:"2. Ordens",pdfs:"3. PDFs"};
// ─────────────────────────────────────────────────────────────
// HELPERS GLOBAIS PRA IA (usados em MeetingPrepModal e RecommendFlowV2)
// ─────────────────────────────────────────────────────────────
function aiExtractText(content) {
var txt = "";
for (var i = 0; i < (content||[]).length; i++) {
if (content[i].type === "text" && content[i].text) txt += content[i].text;
}
return txt;
}
function aiSafeParseJSON(raw) {
raw = String(raw||"").trim().replace(/```json\s*/g,"").replace(/```\s*/g,"").replace(/```/g
try { return JSON.parse(raw); } catch(e) {}
var si = raw.indexOf("{"); var ei = raw.lastIndexOf("}");
if (si >= 0 && ei > si) {
var chunk = raw.slice(si, ei + 1).replace(/,\s*}/g,"}").replace(/,\s*\]/g,"]");
try { return JSON.parse(chunk); } catch(e) {}
}
var asi = raw.indexOf("["); var aei = raw.lastIndexOf("]");
if (asi >= 0 && aei > asi) {
var chunk2 = raw.slice(asi, aei + 1).replace(/,\s*}/g,"}").replace(/,\s*\]/g,"]");
try { return JSON.parse(chunk2); } catch(e2) {}
}
if (si >= 0 && ei > si) {
var chunkObj = raw.slice(si, ei + 1);
var cleaned = chunkObj.replace(/([^\\])\n/g, "$1 ").replace(/\t/g, " ").replace(/,\s*}/g,
try { return JSON.parse(cleaned); } catch(e3) {}
}
throw new Error("Sem JSON valido na resposta da IA");
}
function aiToStr(x) {
if (x === null || x === undefined) return "";
if (typeof x === "string") return x;
if (Array.isArray(x)) {
return x.map(function(item){
if (typeof item === "string") return "• " + item;
if (item && typeof item === "object") return "• " + (item.text || item.content || JSON.
return "• " + String(item);
}).join("\n");
}
if (typeof x === "object") {
if (x.text) return String(x.text);
if (x.content) return String(x.content);
return Object.keys(x).map(function(k){ return k + ": " + (typeof x[k] === "string" ? x[k]
}
return String(x);
}
async function aiCallAPI(body) {
var resp = await fetch("/api/anthropic", {method:"POST",headers:{"Content-Type":"applicatio
var respText = await resp.text();
if (!resp.ok) throw new Error("API " + resp.status + ": " + respText.slice(0,200));
var d;
try { d = JSON.parse(respText); } catch(pe) { throw new Error("Resposta nao e JSON: " + res
if (d.error) throw new Error("API error: " + (d.error.message || d.error.type || JSON.strin
if (!d.content || !d.content.length) throw new Error("Resposta vazia da IA");
return d;
}
// ─────────────────────────────────────────────────────────────
// DETECÇÃO DE MOEDA POR TICKER
// ─────────────────────────────────────────────────────────────
// BR: termina em 3, 4, 5, 6, 11, 12 (padrão B3). FIIs também B3.
// Europeu/UK: termina em .L (LSE), .PA (Paris), .DE (Xetra), .MI (Milão), .AS (Amsterdam)
// Canadense: termina em .TO
// Resto: assume USD (NYSE/NASDAQ) — cobre 99% dos casos Suno
function detectCurrencyFromTicker(ticker, portfolio, classe) {
if (!ticker) return "BRL";
// Caixa é sempre em BRL
if (classe === "caixa") return "BRL";
if (/caixa/i.test(String(ticker))) return "BRL";
if (/reserva/i.test(String(ticker))) return "BRL";
// RF sem ticker real
if (String(ticker).indexOf("RF_") === 0) return "BRL";
// Pseudo-tickers com espaços ou parênteses: provavelmente nomes, BRL
if (/[\s()]/.test(String(ticker))) return "BRL";
var t = String(ticker).toUpperCase().trim();
// Sufixos explícitos
if (t.endsWith(".L")) return "GBP"; // London
if (t.endsWith(".PA") || t.endsWith(".AS") || t.endsWith(".DE") || t.endsWith(".MI") if (t.endsWith(".TO") || t.endsWith(".V")) return "CAD";
if (t.endsWith(".HK")) return "HKD";
|| t.e
if (t.endsWith(".T") || t.endsWith(".TYO")) return "JPY";
if (t.endsWith(".SW")) return "CHF";
if (t.endsWith(".AX")) return "AUD";
if (t.endsWith(".SA")) return "BRL"; // B3 explícito
// Portfolio internacional sem sufixo → USD (ADRs, NYSE, NASDAQ)
if (portfolio === "Internacional") return "USD";
// Padrão B3: 3-6 alfanuméricos + 1-2 dígitos (aceita LBRDA34, B3SA3, HPQB34 etc).
// Antes era /^[A-Z]{4}\d{1,2}$/ — só 4 letras. Isso excluía BDRs de 5 letras (LBRDA34)
// e tickers com número no meio (B3SA3), fazendo eles caírem no fallback IA lento.
if (/^[A-Z0-9]{3,6}\d{1,2}$/.test(t)) return "BRL";
// Padrão US: 1-5 letras maiúsculas, SEM dígitos, SEM sufixo (VOO, VEA, AMZN, META, BTI, HP
// Cobre o caso de ordens avulsas adicionadas na recomendação (sem portfolio associado).
// Nenhum ticker B3 bate aqui — B3 sempre tem dígito no final.
if (/^[A-Z]{1,5}$/.test(t)) return "USD";
// Sem padrão reconhecido: assume BRL (mais seguro que USD como default)
return "BRL";
}
// Lista de moedas únicas usadas nas ordens (excluindo BRL)
function getForeignCurrenciesFromOrders(allocations, allAppStocks) {
var currencies = {};
var stockByTicker = {};
allAppStocks.forEach(function(s){ if (s.ticker) stockByTicker[s.ticker] = s; });
Object.keys(allocations).forEach(function(tk){
var al = allocations[tk]; if (!al) return;
if (al._classe === "renda_fixa" || al._classe === "caixa") return;
if (tk.indexOf("RF_") === 0) return;
var stock = stockByTicker[tk];
var portfolio = stock ? stock._portfolio : null;
var cur = detectCurrencyFromTicker(tk, portfolio, al._classe);
if (cur !== "BRL") currencies[cur] = true;
});
return Object.keys(currencies);
}
// ─────────────────────────────────────────────────────────────
// RECOMMEND FLOW V2 — novo componente (big bang)
// Entrega 1: Etapa Estado completa. Etapas Ordens e PDFs com placeholder.
// ─────────────────────────────────────────────────────────────
function RecommendFlowV2(props) {
var editingProfile = props.editingProfile;
var consultorName = props.consultorName;
var setConsultorName = props.setConsultorName;
var consultorProfile = props.consultorProfile; // perfil do consultor logado (pra PDF Suno
var setShowConsultorEditor = props.setShowConsultorEditor; // abre modal pra editar perfil
var period = props.period;
var setPeriod = props.setPeriod;
var allocations = props.allocations;
var setAllocations = props.setAllocations;
var carteirasData = props.carteirasData;
var allAppStocks = props.allAppStocks;
var macroReports = props.macroReports;
var fiiReports = props.fiiReports;
var [step, setStep] = useState("estado");
var [loadingSnap, setLoadingSnap] = useState(false);
var [latestAtualSnap, setLatestAtualSnap] = useState(null);
var [savedAlvoSnap, setSavedAlvoSnap] = useState(null);
var [snapError, setSnapError] = useState("");
var [availableCashV2, setAvailableCashV2] = useState("");
var [cashOverridden, setCashOverridden] = useState(false);
// ── Estado da Etapa Ordens ──
var [ignoredSuggestions, setIgnoredSuggestions] = useState({}); // {ticker: true}
var [showAddBuyModal, setShowAddBuyModal] = useState(false);
var [addBuyStep, setAddBuyStep] = useState("class"); // class | carteira | ticker | rf
var [addBuyClass, setAddBuyClass] = useState("");
var [addBuyCarteira, setAddBuyCarteira] = useState("");
var [addBuyTicker, setAddBuyTicker] = useState("");
var [addBuyTickerSearch, setAddBuyTickerSearch] = useState("");
var [addBuyValue, setAddBuyValue] = useState("");
// RF livre
var [addBuyRFIndex, setAddBuyRFIndex] = useState("");
var [addBuyRFName, setAddBuyRFName] = useState("");
// Edição de valor em linhas existentes
var [editingOrderTicker, setEditingOrderTicker] = useState(null);
// Modal de adicionar venda (novo)
var [showAddSellModal, setShowAddSellModal] = useState(false);
var [addSellTicker, setAddSellTicker] = useState("");
var [addSellSearch, setAddSellSearch] = useState("");
var [addSellValue, setAddSellValue] = useState("");
var [addSellValueMode, setAddSellValueMode] = useState("rs"); // rs | pct
// Visualizar/editar snapshot
var [showSnapshotViewer, setShowSnapshotViewer] = useState(false);
// Modal de gap detalhado por ativo (ao clicar numa classe)
var [gapDetailClasse, setGapDetailClasse] = useState(null); // "acoes_br" | "fiis" | var [gapDetailMode, setGapDetailMode] = useState("carteira"); // "carteira" | "classe"
var [gapDetailSnapshot, setGapDetailSnapshot] = useState(null); // snapshot completo var [gapDetailTarget, setGapDetailTarget] = useState(null); // target resolvido (pra // Câmbio USD/BRL pra calcular L/P de ativos internacionais (Gorila exporta preço atual em
etc
(pra a
aba Es
// Cache de 1h via AwesomeAPI (gratuito). Se falhar, L/P de internacionais fica oculto.
var [fxUsdBrl, setFxUsdBrl] = useState(null);
useEffect(function(){
var aborted = false;
fetchUsdBrl().then(function(r){ if (!aborted && r) setFxUsdBrl(r); });
return function(){ aborted = true; };
}, []);
// ── Estado da Etapa 3 (PDFs) ──
var [pdfConsultivoGerando, setPdfConsultivoGerando] = useState(false);
// Modal de revisão das ordens antes de baixar o PDF
var [showIaReview, setShowIaReview] = useState(false);
// Edição de valores das ordens no modal de revisão (cópia editável de allocations)
var [iaReviewAllocations, setIaReviewAllocations] = useState({});
// Cotações ao vivo carregadas ao abrir o modal (preço atual, câmbio)
var [iaReviewQuotes, setIaReviewQuotes] = useState({});
var [iaReviewQuotesLoading, setIaReviewQuotesLoading] = useState(false);
// Edições manuais por ticker: {TICKER: {priceOrig?, fx?, qty?, value?}} — rastreia o que f
var [iaReviewEdits, setIaReviewEdits] = useState({});
// Comentários gerais que vão pra coluna "Observações" das páginas de compras/vendas
var [iaReviewComprasObs, setIaReviewComprasObs] = useState("");
var [iaReviewVendasObs, setIaReviewVendasObs] = useState("");
// Carrega snapshots do cliente ao montar ou quando cliente muda
useEffect(function(){
if (!editingProfile || !editingProfile.id) {
setLatestAtualSnap(null); setSavedAlvoSnap(null); return;
}
var cancel = false;
setLoadingSnap(true); setSnapError("");
(async function(){
try {
var res = await supabase.from("client_snapshots").select("*").eq("client_profile_id",
if (cancel) return;
if (res.error) { setSnapError("Erro ao buscar snapshots: " + res.error.message); setL
var all = res.data || [];
var atuais = all.filter(function(s){return s.tipo==="atual";}).sort(function(a,b){ret
var alvo = all.find(function(s){return s.tipo==="alvo";});
setLatestAtualSnap(atuais[0] || null);
setSavedAlvoSnap(alvo || null);
setLoadingSnap(false);
} catch(e) {
if (cancel) return;
setSnapError("Erro: " + e.message);
setLoadingSnap(false);
}
})();
return function(){ cancel = true; };
}, [editingProfile && editingProfile.id]);
// Pré-preenche período com mês corrente
useEffect(function(){
if (period) return;
var now = new Date();
var ym = now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,"0");
setPeriod(ym);
}, []);
// Resolve alvo (M4 editado tem prioridade sobre JB)
var resolvedTarget = null;
try {
resolvedTarget = resolveTarget(savedAlvoSnap, editingProfile && editingProfile.jbData);
} catch(e) { resolvedTarget = null; }
// Calcula alocação atual a partir do snapshot
var atualByClass = {};
var patrimonioAtual = 0;
if (latestAtualSnap && latestAtualSnap.data && latestAtualSnap.data.alocacao) {
Object.keys(latestAtualSnap.data.alocacao).forEach(function(cls){
var c = latestAtualSnap.data.alocacao[cls];
if (c && typeof c.pct === "number") atualByClass[cls] = c.pct;
});
patrimonioAtual = latestAtualSnap.data.patrimonio_total || 0;
}
// Gaps por classe, ordenados por magnitude
var CLASS_ORDER_V2 = ["renda_fixa","acoes_br","fiis","internacional","alternativos","caixa"
var CLASS_LABELS_V2 = {renda_fixa:"Renda Fixa", acoes_br:"Ações BR", fiis:"FIIs", internaci
var gapsByClass = CLASS_ORDER_V2.map(function(cls){
var atPct = atualByClass[cls] || 0;
var tgPct = (resolvedTarget && resolvedTarget.allocMacro && resolvedTarget.allocMacro[cls
if (atPct === 0 && tgPct === 0) return null;
var gap = +(atPct - tgPct).toFixed(2);
return {cls: cls, atPct: atPct, tgPct: tgPct, gap: gap, absGap: Math.abs(gap)};
}).filter(Boolean);
// Gaps por indexador RF (se houver ativos RF)
var rfIndexadorAt = {};
if (latestAtualSnap && latestAtualSnap.data && Array.isArray(latestAtualSnap.data.ativos))
latestAtualSnap.data.ativos.forEach(function(a){
if (a.classe === "renda_fixa" && a.subclasse) {
rfIndexadorAt[a.subclasse] = (rfIndexadorAt[a.subclasse] || 0) + (a.pct_total || 0);
}
});
}
var INDEXADOR_LABELS_V2 = {pos_fixado:"Pós-fixado", ipca:"IPCA+", prefixado:"Prefixado", fu
var rfGaps = Object.keys(INDEXADOR_LABELS_V2).map(function(ix){
var atPct = +(rfIndexadorAt[ix] || 0).toFixed(2);
var tgPct = (resolvedTarget && resolvedTarget.allocIndexadoresRF && resolvedTarget.allocI
if (atPct === 0 && tgPct === 0) return null;
var gap = +(atPct - tgPct).toFixed(2);
return {ix: ix, atPct: atPct, tgPct: tgPct, gap: gap, absGap: Math.abs(gap)};
}).filter(Boolean);
// Sugestões de ativos marcados (Redução, Em Avaliação, Fora de Carteira Suno)
var sugestoes = {reducao:[], em_avaliacao:[], fora_carteira:[]};
if (latestAtualSnap && latestAtualSnap.data && Array.isArray(latestAtualSnap.data.ativos))
latestAtualSnap.data.ativos.forEach(function(a){
if (a.status_recomendacao === "reducao") sugestoes.reducao.push(a);
else if (a.status_recomendacao === "em_avaliacao") sugestoes.em_avaliacao.push(a);
else if ((!a.carteiras_suno || a.carteiras_suno.length === 0) && a.classe !== "renda_fi
sugestoes.fora_carteira.push(a);
}
});
}
function gapColor(absGap, hasTarget) {
if (!hasTarget) return "rgba(255,255,255,0.3)";
if (absGap < 3) return "#4ade80";
if (absGap < 8) return "#fbbf24";
return "#f87171";
}
// ─── Helpers de allocation (vendas / compras) ───
function addVendaOrdem(ticker, ativo, defaultValue) {
var newAlloc = Object.assign({}, allocations);
newAlloc[ticker] = {
value: defaultValue || 0,
text: "",
verdict: "VENDER",
type: "sell",
_source: "snapshot",
_classe: ativo.classe,
_subclasse: ativo.subclasse,
_nome: ativo.nome_original || ativo.ticker,
_posAtual: ativo.valor || 0,
_pctAtual: ativo.pct_total || 0,
};
setAllocations(newAlloc);
}
function addCompraOrdem(ticker, meta) {
var newAlloc = Object.assign({}, allocations);
newAlloc[ticker] = {
value: meta.value || 0,
text: "",
verdict: "APORTAR",
type: "buy",
_source: meta.source || "manual",
_classe: meta.classe,
_subclasse: meta.subclasse || "",
_nome: meta.nome || ticker,
_carteira: meta.carteira || "",
_rfProduct: meta.rfProduct || "",
_bdrUnderlying: meta.bdrUnderlying || null, // stock subjacente quando ticker é BDR co
};
setAllocations(newAlloc);
}
function removeOrdem(ticker) {
var newAlloc = Object.assign({}, allocations);
delete newAlloc[ticker];
setAllocations(newAlloc);
}
function updateOrdemValue(ticker, newVal) {
if (!allocations[ticker]) return;
var newAlloc = Object.assign({}, allocations);
newAlloc[ticker] = Object.assign({}, newAlloc[ticker], {value: Number(newVal) || 0});
setAllocations(newAlloc);
}
// Totais vivos
var totalVendas = 0; var totalCompras = 0;
Object.keys(allocations).forEach(function(tk){
var a = allocations[tk];
if (!a) return;
if (a.type === "sell") totalVendas += Math.abs(a.value || 0);
else totalCompras += Math.abs(a.value || 0);
});
var saldoInicial = Number(availableCashV2) || 0;
var saldoTotalDisponivel = saldoInicial + totalVendas; // caixa + aporte + vendas
var saldoRestante = saldoTotalDisponivel - totalCompras;
// Projeção pós-execução da alocação por classe
function calcProjecaoByClass() {
if (!latestAtualSnap || !latestAtualSnap.data) return {};
var ats = latestAtualSnap.data.ativos || [];
var patrTotal = latestAtualSnap.data.patrimonio_total || 0;
// 1. Calcula valor em R$ atual por classe
var valByClass = {};
CLASS_ORDER_V2.forEach(function(cls){ valByClass[cls] = 0; });
ats.forEach(function(a){
var cls = a.classe || "caixa";
if (!valByClass.hasOwnProperty(cls)) valByClass[cls] = 0;
valByClass[cls] += (a.valor || 0);
});
// 2. Aplica impacto das ordens
Object.keys(allocations).forEach(function(tk){
var al = allocations[tk];
if (!al) return;
var cls = al._classe || "acoes_br";
if (!valByClass.hasOwnProperty(cls)) valByClass[cls] = 0;
if (al.type === "sell") {
// Venda reduz da classe original; o R$ vai pra caixa
valByClass[cls] = Math.max(0, valByClass[cls] - Math.abs(al.value || 0));
valByClass.caixa = (valByClass.caixa || 0) + Math.abs(al.value || 0);
} else {
// Compra: aumenta a classe, reduz caixa
valByClass[cls] = (valByClass[cls] || 0) + Math.abs(al.value || 0);
valByClass.caixa = Math.max(0, (valByClass.caixa || 0) - Math.abs(al.value || 0));
}
});
// 3. Converte de volta em %
var newPatr = Object.keys(valByClass).reduce(function(s,k){return s+valByClass[k];},0);
var pctByClass = {};
CLASS_ORDER_V2.forEach(function(cls){
if (newPatr > 0) pctByClass[cls] = (valByClass[cls] / newPatr) * 100;
else pctByClass[cls] = 0;
});
return pctByClass;
}
var projecaoByClass = (step === "ordens") ? calcProjecaoByClass() : {};
// Candidatos de ticker para adicionar compra (por classe + carteira)
function getCandidatesByClassAndCarteira(classe, carteira) {
if (classe === "acoes_br") {
if (carteira === "outro") return allAppStocks;
if (!carteira) return [];
return allAppStocks.filter(function(s){ return s._portfolio === carteira; });
}
if (classe === "internacional") {
if (carteira === "outro") return allAppStocks.filter(function(s){ return s._portfolio =
if (!carteira) return [];
// carteira aqui é o nome da sub-carteira internacional ("Hidden Value", "Great Compani
return allAppStocks.filter(function(s){ return s._portfolio === "Internacional" && s.in
}
if (classe === "fiis") {
if (carteira === "outro") return []; // usuário digita livre
// Carteira FIIs Suno via carteirasData
if (!carteirasData || !carteirasData.carteiras) return [];
// Match amplo: "fii", "imobiliário", "imobiliarios" (mesma lógica do FIIsTab)
var fiiCarteira = carteirasData.carteiras.find(function(c){
return /fii|imobili/i.test(c.name || "");
});
// Fallback: qualquer carteira com tickers terminando em 11
if (!fiiCarteira) {
fiiCarteira = carteirasData.carteiras.find(function(c){
var ats = (carteirasData.ativos && carteirasData.ativos[c.id]) || [];
return ats.length > 0 && ats.every(function(a){ return /11$/.test(a.ticker || "");
});
}
if (!fiiCarteira) return [];
var ativos = (carteirasData.ativos && carteirasData.ativos[fiiCarteira.id]) || [];
return ativos.map(function(a){
return {
ticker: a.ticker,
name: a.name || a.ticker,
_portfolio: "FIIs",
rankScore: a.rankScore,
currentPrice: a.currentPrice,
ceilingPrice: a.ceilingPrice,
};
});
}
if (classe === "alternativos") {
return [];
}
return [];
}
// Descobre as sub-carteiras internacionais disponíveis (Hidden Value, Great Companies, etc
function getSubCarteirasInternacional() {
var subs = {};
allAppStocks.forEach(function(s){
if (s._portfolio === "Internacional" && s.intlSub) subs[s.intlSub] = true;
});
return Object.keys(subs);
}
// ═══════════════════════════════════════════════════════════════════
// ── PDF CONSULTIVO V2 (para o cliente) ──
// ═══════════════════════════════════════════════════════════════════
async function generatePDFConsultivoV2(opts) {
opts = opts || {};
setPdfConsultivoGerando(true);
try {
// Cotações ao vivo: reusa as do modal se já buscadas, senão busca agora
var liveQuotes = {};
if (opts.quotesOverride && Object.keys(opts.quotesOverride).length > 0) {
liveQuotes = opts.quotesOverride;
} else {
try { liveQuotes = await fetchLiveQuotes(); }
catch(qErr) { console.warn("[consultivo pdf] Falha ao buscar cotações:", qErr); }
}
// Edições manuais do modal de revisão (preço/câmbio/qty/valor por ticker)
var manualEdits = opts.editsOverride || {};
// ═══════════════════════════════════════════════════════════════
// PDF SUNO OFICIAL — Landscape A4 (297×210mm), páginas variáveis:
// 1) Capa 2) Fale Conosco 3..N) Compras (paginadas, máx 10/slide)
// N+1..M) Vendas (paginadas, máx 10/slide) M+1) Me contate! M+2) Disclaimer
// Usa imagens originais do template Suno (extraídas do PPTX) + links clicáveis
// do perfil do consultor logado (carregado de Supabase consultores).
// FORMATO: widescreen 16:9 (338.67 × 190.5 mm) — mesma proporção do PPTX original
// ═══════════════════════════════════════════════════════════════
var doc = new jsPDF({orientation:"landscape",unit:"mm",format:[338.67, 190.5],compress:
var W = 338.67, H = 190.5;
// ── Registra fonte Montserrat (subset PT-BR, ~67KB total) ──
var hasMontserrat = registerMontserrat(doc);
var fontFamily = hasMontserrat ? "Montserrat" : "helvetica";
// ── Paleta Suno ──
var C = {
bgDark: [15, 15, 16],
red: [220, 38, 38],
white: [255, 255, 255],
textDim: [225, 225, 230],
textMuted: [150, 150, 155],
line: [60, 60, 65],
black: [25, 25, 28],
body: [60, 60, 65],
secondary: [120, 120, 125],
rule: [220, 220, 222],
green: [22, 163, 74],
greenLight:[220, 244, 226],
redLight: [254, 226, 226],
tlPastBg: [232, 250, 232],
tlActiveBg:[34, 197, 94],
tlGray: [240, 240, 242],
tlText: [110, 110, 115]
};
function setC(c){ doc.setTextColor(c[0],c[1],c[2]); }
function setF(c){ doc.setFillColor(c[0],c[1],c[2]); }
var _origText = doc.text.bind(doc);
doc.text = function(text, x, y, options) {
if (typeof text === "string") text = sanitizePDFText(text);
else if (Array.isArray(text)) text = text.map(sanitizePDFText);
return _origText(text, x, y, options);
};
function wrap(t,mw,sz){ doc.setFontSize(sz); return doc.splitTextToSize(sanitizePDFText
// ── Helper pra adicionar imagem com fallback (skip se data-URL inválido) ──
// Passa compression="MEDIUM" pra fazer o jsPDF aplicar deflate; junto com
// compress:true no construtor, mantém o PDF em ~600KB (vs 12MB sem).
function safeAddImage(dataUrl, fmt, x, y, w, h) {
if (!dataUrl) return false;
try { doc.addImage(dataUrl, fmt, x, y, w, h, undefined, "MEDIUM"); return true; }
catch(e) { console.warn("[pdf] addImage falhou:", e.message); return false; }
}
// ── Detect format from data-URL ──
function fmtOf(dataUrl) {
if (!dataUrl) return "JPEG";
if (dataUrl.indexOf("data:image/png") === 0) return "PNG";
return "JPEG";
}
// Footer claro padrão das páginas brancas
function drawLightFooter() {
doc.setFontSize(7); doc.setFont(fontFamily,"normal"); setC(C.secondary);
doc.text("suno.com.br", 12, H - 6);
doc.text("2021 © Suno Research", W - 12, H - 6, {align:"right"});
}
// Logo SUNO em fundo escuro (texto branco)
function drawLogoLight(cx, cy, scaleW) {
// image11 é o logo "SUNO" branco em fundo transparente (proporção ~7.5:1)
var w = scaleW || 24;
var h = w / 7.5;
safeAddImage(SunoImg.LOGO_LIGHT, "JPEG", cx - w/2, cy - h/2, w, h);
}
// Logo SUNO em fundo claro (texto preto + parênteses vermelhos)
function drawLogoDark(cx, cy, scaleW) {
var w = scaleW || 22;
var h = w / 3.6; // image10 tem proporção ~3.6:1
safeAddImage(SunoImg.LOGO_DARK, "JPEG", cx - w/2, cy - h/2, w, h);
}
// Data formatada DD/MM/AAAA
var today = new Date();
var dd = String(today.getDate()).padStart(2,"0");
var mm = String(today.getMonth()+1).padStart(2,"0");
var yyyy = today.getFullYear();
var dataFmt = dd + "/" + mm + "/" + yyyy;
// Mês ativo da timeline = meses completos desde o início do contrato + 1, clamp 1..12.
// Prioriza contractStartDate (campo manual editável no perfil). Cai em createdAt
// como fallback pra clientes antigos que não preencheram o campo.
// Importante: respeita o DIA do mês — se hoje for 11/05 e contrato começou em 28/07,
// ainda estamos no mês 10 (vira mês 11 só no dia 28/05).
var clientName = editingProfile ? (editingProfile.name || "") : "";
var mesAtivo = 1;
try {
var refDate = editingProfile && (editingProfile.contractStartDate || editingProfile.c
if (refDate) {
// Parse ISO "YYYY-MM-DD" explicitamente pra evitar off-by-one por timezone
var parts = String(refDate).slice(0, 10).split("-");
var cy = parseInt(parts[0], 10), cm = parseInt(parts[1], 10) - 1, cdd = parseInt(pa
if (isFinite(cy) && isFinite(cm) && isFinite(cdd)) {
// Meses cheios decorridos entre as duas datas
var fullMonths = (today.getFullYear() - cy) * 12 + (today.getMonth() - cm);
// Se o dia atual ainda não atingiu o dia de início, ainda não completou esse mês
if (today.getDate() < cdd) fullMonths -= 1;
// Mês 1 = momento inicial (0 meses completos); mês 2 começa após 1 mês completo,
var diffM = fullMonths + 1;
mesAtivo = Math.max(1, Math.min(12, diffM));
}
}
} catch(e) {}
// Profile do consultor logado (vem do parent via prop)
var profile = (typeof consultorProfile !== "undefined" && consultorProfile) ? consultor
var consNome = (profile.display_name || consultorName || "").trim();
var consBio = profile.bio || "Formado em Engenharia Civil pela Universidade Tecnológica
var consFoto = profile.foto_url || SunoImg.CONSULTANT_PHOTO;
var consWaUrl = profile.whatsapp_url || "";
var consWaGestorUrl = profile.whatsapp_gestor_url || "";
var consFormUrl = profile.nps_form_url || "";
var consAgendaUrl = profile.calendly_url || "";
var consLinkedinUrl = profile.linkedin_url || "";
var consEmail = profile.email_publico || "";
var consTelefone = profile.telefone_publico || "";
// ── Pré-computa ordens (mantém compatibilidade com função antiga) ──
// allocOverride permite que o modal de revisão substitua valores antes de gerar
var allocSource = opts.allocationsOverride || allocations;
var allKeys = Object.keys(allocSource);
// Ordem operacional pro cliente: dentro de cada tipo (compras/vendas), agrupa por
// classe na ordem RF → Ações BR → FIIs → Alternativos → Internacional. Dentro
// da classe, mantém maior valor primeiro. Vendas sempre depois de compras.
var CLASS_ORDER = {
renda_fixa: 1,
caixa: 1, // junto com RF por afinidade operacional
acoes_br: 2,
fiis: 3,
alternativos: 4,
internacional: 5
};
function classRank(al) {
var c = (al && al._classe) || "";
return CLASS_ORDER[c] || 99; // classe desconhecida vai pro final
}
allKeys.sort(function(a,b){
var aa = allocSource[a], bb = allocSource[b];
var aType = aa.type || "buy", bType = bb.type || "buy";
if (aType !== bType) return aType === "sell" ? 1 : -1;
var ar = classRank(aa), br = classRank(bb);
if (ar !== br) return ar - br;
return (bb.value || 0) - (aa.value || 0);
});
// Spread cambial aplicado em compras internacionais (não-BRL).
// Cobre spread da corretora (~1%) + custo de dolarização (~1,1%) com margem
// conservadora. Total ~3,5%. Tornar a recomendação mais realista pro cliente
// executar — a quantidade calculada já considera que cada R$ rende menos USD.
// Não aplica em vendas (cliente só paga spread ao comprar).
// Não aplica se o consultor editou o câmbio manualmente no modal de revisão
// (presume que o câmbio manual já é o efetivo da corretora).
var FX_SPREAD_INTERNACIONAL = 0.035;
var allStocksByTicker = {};
allAppStocks.forEach(function(s){ if (s.ticker) allStocksByTicker[s.ticker] = s; var ordensDetalhadas = allKeys.map(function(tk){
});
var al = allocSource[tk]; if (!al) return null;
var stock = allStocksByTicker[tk];
var portfolio = stock ? stock._portfolio : null;
var currency = detectCurrencyFromTicker(tk, portfolio, al._classe);
var q = liveQuotes[tk.toUpperCase()];
var edit = manualEdits[tk.toUpperCase()] || {};
var isSell = al.type === "sell";
// Preço original: edição manual > cotação ao vivo > preço default do stock
var priceOrig = edit.priceOrig != null
? edit.priceOrig
: (q && q.priceOrig > 0 ? q.priceOrig : (stock && stock.currentPrice ? stock.curren
// FX: edição manual > cotação > 1 (BRL)
var fxRaw = edit.fx != null
? edit.fx
: (q && q.fx > 0 ? q.fx : (currency === "BRL" ? 1 : 0));
// Aplica spread cambial apenas em compras internacionais com fx vindo da cotação
// (edição manual passa intacta — consultor já põe o câmbio efetivo).
var fx = fxRaw;
if (!isSell && currency !== "BRL" && edit.fx == null && fxRaw > 0) {
fx = fxRaw * (1 + FX_SPREAD_INTERNACIONAL);
}
// Preço em BRL = preço original × câmbio (já com spread se aplicável)
var priceBRL = currency === "BRL" ? priceOrig : (priceOrig * fx);
var isRF = (al._classe || "").indexOf("renda_fixa") >= 0 || tk.indexOf("RF_") === 0;
var absVal = Math.abs(al.value || 0); // sempre em BRL (ja aplicou allocationsOverri
// Quantidade:
// // // // - Edição manual sempre prevalece (consultor já decidiu).
- Internacional (não-BRL, não-RF): permite fracionário com 2 casas decimais
(corretoras como Avenue, Nomad, XP International aceitam frações).
- B3 / RF: inteiro arredondado pra baixo (ações e títulos vão por lote inteiro).
var isIntl = currency !== "BRL" && !isRF;
var qty;
if (edit.qty != null) {
qty = edit.qty;
} else if (priceBRL > 0) {
var rawQty = absVal / priceBRL;
qty = isIntl ? Math.floor(rawQty * 100) / 100 : Math.floor(rawQty);
} else {
qty = 0;
}
// // Total na moeda original:
- BRL: usa o absVal direto.
// // // // - Internacional: recalcula a partir de priceOrig × qty pra bater com a quantidad
efetivamente exibida (com fracionário, bate exato; com inteiro, mostra o valor
gasto pela qty arredondada — pode sobrar caixa, mas evita o erro do PDF anteri
onde a tabela mostrava qty incompatível com o total).
var totalOrig;
if (currency === "BRL") {
totalOrig = absVal;
} else if (priceOrig > 0 && qty > 0) {
totalOrig = priceOrig * qty;
} else if (fx > 0) {
totalOrig = absVal / fx;
} else {
totalOrig = 0;
}
var isGeneratedId = /^(RF_|rf:|alt:)/i.test(tk) || tk.length > 12;
var displayName = isGeneratedId && al._nome ? al._nome : tk;
return {
tk: tk, displayName: displayName, isRF: isRF, qty: qty,
totalBRL: absVal, totalOrig: totalOrig,
currency: currency, priceOrig: priceOrig, fx: fx,
isSell: isSell
};
}).filter(function(o){ return o !== null; });
var compras = ordensDetalhadas.filter(function(o){ return !o.isSell; });
var vendas = ordensDetalhadas.filter(function(o){ return o.isSell; });
// Formatador de número em pt-BR (separador milhar=. decimal=,)
function fmtNum(v) {
var sign = v < 0 ? "-" : "";
var abs = Math.abs(v);
var s = abs.toFixed(2);
var parts = s.split(".");
parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
return sign + parts[0] + "," + parts[1];
}
// Símbolo da moeda
function curSymbol(cur) {
if (cur === "BRL") return "R$";
if (cur === "USD") return "US$";
if (cur === "EUR") return "€";
if (cur === "GBP") return "£";
return cur || "R$";
}
// Formata valor com símbolo de moeda na frente
function fmtMoney(v, cur) {
return curSymbol(cur) + " " + fmtNum(v);
}
// Mantém fmtBRL pra retrocompatibilidade
function fmtBRL(v) { return "R$ " + fmtNum(v); }
// Quantidade: inteiro pra B3/RF (sem casas decimais), 2 casas pra fracionário internac
function fmtQty(q) {
if (!q || q === 0) return "—";
var isFractional = q !== Math.floor(q);
return q.toLocaleString("pt-BR", isFractional
? {minimumFractionDigits: 2, maximumFractionDigits: 2}
: {minimumFractionDigits: 0, maximumFractionDigits: 0});
}
// ════════════════════════════════════════════════════════
// PDF SUNO OFICIAL v3 — usa slides PPTX como imagens de fundo
// Carrega de /public/suno-slides/slide-NN.png e sobrepõe
// apenas os campos editáveis (data, cliente, tabelas, dados consultor)
// ════════════════════════════════════════════════════════
// ── Helper: carrega slide PNG do /public como dataURL ──
async function loadSlideImg(num) {
var n = String(num).padStart(2, "0");
var url = "/suno-slides/slide-" + n + ".png";
try {
var res = await fetch(url);
if (!res.ok) throw new Error("HTTP " + res.status);
var blob = await res.blob();
return await new Promise(function(resolve, reject) {
var r = new FileReader();
r.onload = function() { resolve(r.result); };
r.onerror = reject;
r.readAsDataURL(blob);
});
} catch(e) {
console.warn("[pdf] Falha ao carregar slide " + n + ":", e.message);
return null;
}
}
// ── Helper genérico: carrega qualquer imagem do /public como dataURL ──
async function loadAsset(url) {
try {
var res = await fetch(url);
if (!res.ok) throw new Error("HTTP " + res.status);
var blob = await res.blob();
return await new Promise(function(resolve, reject) {
var r = new FileReader();
r.onload = function() { resolve(r.result); };
r.onerror = reject;
r.readAsDataURL(blob);
});
} catch(e) {
console.warn("[pdf] Falha ao carregar " + url + ":", e.message);
return null;
}
}
// ── Mapeamento mês ativo → slides PPTX (lógica decrescente do template) ──
// mês 1 → compras=slide 25, vendas=slide 26
// mês 12 → compras=slide 3, vendas=slide 4
var slideCompras = 3 + 2 * (12 - mesAtivo);
var slideVendas = 4 + 2 * (12 - mesAtivo);
// ── Pré-carrega TODOS os assets necessários em paralelo ──
var slidesNeeded = [1, 2, slideCompras, slideVendas, 27, 28];
var slidesData = {};
var loadPromises = slidesNeeded.map(function(n){
var nn = String(n).padStart(2, "0");
return loadAsset("/suno-slides/slide-" + nn + ".png");
});
var allLoaded = await Promise.all(loadPromises);
slidesNeeded.forEach(function(n, i){ slidesData[n] = allLoaded[i]; });
function bgSlide(num) { return slidesData[num] || null; }
do tip
totais
// ── Helper: desenha as linhas de dados da tabela sobre a imagem ──
// (cabeçalho verde/vermelho e header "Ativo/Quantidade/Total" já vêm pintados na image
// tipo: "compras" | "vendas"
// showResumoCompletoNoFinal: se true (último slide de vendas), mostra resumo geral com
// observacoes: texto opcional pra renderizar na coluna "Observações" do template
// isLastChunk: se true, desenha os totais por moeda do tipo atual (último slide // allRowsOfType: array completo do tipo (compras ou vendas), usado pra calcular // no último chunk (já que `rows` só tem os 10 ativos do chunk atual)
function drawTabelaSobreSlide(rows, tipo, showResumoCompletoNoFinal, observacoes, isLas
var isVenda = tipo === "vendas";
// Default: se isLastChunk não foi passado, comporta como antes (último = único slide
if (typeof isLastChunk === "undefined") isLastChunk = true;
// Default: se allRowsOfType não foi passado, usa as próprias rows
if (!allRowsOfType) allRowsOfType = rows;
// Coordenadas calibradas em mm sobre 16:9 widescreen (338.67×190.5):
// Tabela ocupa: x=13.3mm a x=223.7mm (largura ~210mm) — coluna esquerda da imagem
var leftX = 13.3, leftW = 210;
var colAtivo = leftX + 10;
var colQtde = leftX + leftW * 0.50;
var colTotal = leftX + leftW - 10;
// Sub-cabeçalho "Ativo / Quantidade / Total"
var hdrY = 62;
doc.setFontSize(10); doc.setFont(fontFamily,"bold"); setC(C.black);
doc.text("Ativo", colAtivo, hdrY);
doc.text("Quantidade", colQtde, hdrY, {align:"center"});
doc.text("Total", colTotal, hdrY, {align:"right"});
// ── Observações na coluna direita ──
// Coluna "Observações" no template: x=228.9-328.9mm (largura ~100mm), conteúdo a par
// Só renderiza no último chunk pra não repetir em todas as páginas
if (isLastChunk && observacoes && observacoes.trim()) {
var obsX = 232;
var obsY = 70;
var obsW = 92; // largura útil
doc.setFontSize(10); doc.setFont(fontFamily,"normal"); setC(C.black);
var obsLines = wrap(observacoes.trim(), obsW, 10);
var oY = obsY;
obsLines.forEach(function(L){ doc.text(L, obsX, oY); oY += 5; });
}
var rowY = hdrY + 6;
if (!rows || rows.length === 0) {
rowY += 4;
doc.setFontSize(10); doc.setFont(fontFamily,"italic"); setC(C.secondary);
doc.text("Nenhuma ordem deste tipo neste ciclo.", leftX + leftW/2, rowY + 4, // Mesmo sem ordens deste tipo, pode haver resumo geral (no slide de vendas)
if (showResumoCompletoNoFinal) {
drawResumoTotaisGeral(rowY + 14, leftX, leftW);
{align
}
return;
}
// Linhas alternadas (zebra)
var zebraColor = isVenda ? C.redLight : C.greenLight;
rows.forEach(function(o, idx) {
var rh = 9;
if (idx % 2 === 0) {
setF(zebraColor);
doc.rect(leftX, rowY, leftW, rh, "F");
}
doc.setFontSize(10); doc.setFont(fontFamily,"normal"); setC(C.black);
var nm = o.displayName;
var maxNmW = colQtde - colAtivo - 18;
if (doc.getTextWidth(nm) > maxNmW) {
while (nm.length > 4 && doc.getTextWidth(nm + "…") > maxNmW) nm = nm.slice(0, -1)
nm += "…";
}
doc.text(nm, colAtivo, rowY + 6);
doc.text(o.isRF ? "" : fmtQty(o.qty), colQtde, rowY + 6, {align:"center"});
// Valor exibido na MOEDA ORIGINAL do ativo (R$, US$, € etc)
var totVal = o.isSell ? -o.totalOrig : o.totalOrig;
doc.text(fmtMoney(totVal, o.currency), colTotal, rowY + 6, {align:"right"});
rowY += rh;
});
// ── Totais por moeda do TIPO atual (compras OU vendas) ──
// Só renderiza no ÚLTIMO chunk do tipo, somando TODOS os ativos (não só os do if (isLastChunk) {
var totaisPorMoeda = {};
allRowsOfType.forEach(function(o){
if (!totaisPorMoeda[o.currency]) totaisPorMoeda[o.currency] = 0;
totaisPorMoeda[o.currency] += o.totalOrig;
chunk)
});
var moedasOrdenadas = Object.keys(totaisPorMoeda).sort();
if (moedasOrdenadas.length > 0) {
rowY += 5; // gap
doc.setFontSize(10); doc.setFont(fontFamily,"bold"); setC(C.black);
var labelTotal = isVenda ? "Total de vendas:" : "Total de compras:";
moedasOrdenadas.forEach(function(cur){
var v = totaisPorMoeda[cur];
doc.text(labelTotal, colAtivo, rowY + 6);
doc.text(fmtMoney(v, cur), colTotal, rowY + 6, {align:"right"});
rowY += 6;
});
}
}
// ── Se for o slide de vendas (último slide de operações), adiciona resumo geral ──
if (showResumoCompletoNoFinal) {
drawResumoTotaisGeral(rowY + 8, leftX, leftW);
}
}
// ── Helper: desenha bloco de resumo geral por moeda ──
// Cálculo: vendas entram como NEGATIVAS (reduzem o consolidado).
// Label adapta-se ao que existe na moeda:
// só compras → "Total de compras (CUR):" valor = +compras
// só vendas → "Total de vendas (CUR):" valor = vendas (mostra como positiv
// ambos → "Total de compras e vendas (CUR):" valor = compras − vendas
function drawResumoTotaisGeral(yStart, leftX, leftW) {
var colAtivo = leftX + 10;
var colTotal = leftX + leftW - 10;
// Agrupa todas as ordens por moeda
var por = {}; // currency → { compras: 0, vendas: 0 }
ordensDetalhadas.forEach(function(o){
if (!por[o.currency]) por[o.currency] = { compras: 0, vendas: 0 };
if (o.isSell) por[o.currency].vendas += o.totalOrig;
else por[o.currency].compras += o.totalOrig;
});
var moedas = Object.keys(por).sort();
if (moedas.length === 0) return;
// Linha separadora sutil acima
setF([220, 220, 222]); doc.rect(leftX, yStart - 3, leftW, 0.3, "F");
doc.setFontSize(10); doc.setFont(fontFamily,"bold"); setC(C.black);
var y = yStart + 3;
moedas.forEach(function(cur){
var c = por[cur].compras;
var v = por[cur].vendas;
if (c === 0 && v === 0) return;
var label, valor;
if (c > 0 && v > 0) {
label = "Total de compras e vendas (" + cur + "):";
valor = c - v; // vendas reduzem o consolidado
} else if (c > 0) {
label = "Total de compras (" + cur + "):";
valor = c;
} else {
label = "Total de vendas (" + cur + "):";
valor = v;
}
doc.text(label, colAtivo, y);
doc.text(fmtMoney(valor, cur), colTotal, y, {align:"right"});
y += 6;
});
}
// ════════════════════════════════════════════════════════
// PÁGINA 1 — CAPA (slide-01.png)
// Imagem inteira ocupa o full-bleed; sobrepõe data e nome do cliente.
// Coordenadas calibradas pro título "Recomendações" que está na imagem
// em ~x=18mm, y=68-81mm. Data fica logo abaixo, alinhada à esquerda.
// ════════════════════════════════════════════════════════
var pageBg = bgSlide(1);
if (pageBg) {
safeAddImage(pageBg, "PNG", 0, 0, W, H);
} else {
setF(C.bgDark); doc.rect(0, 0, W, H, "F");
doc.setFont(fontFamily,"bold"); doc.setFontSize(46); setC(C.white);
doc.text("Recomendações", 18, 78);
}
// Data abaixo do título (alinhada com sua borda esquerda)
doc.setFont(fontFamily,"normal"); doc.setFontSize(13); setC(C.textDim);
doc.text(dataFmt, 18, 95);
// ELABORADO PARA + nome cliente
if (clientName) {
doc.setFontSize(8.5); setC(C.textMuted); doc.setFont(fontFamily,"bold");
doc.text("ELABORADO PARA", 18, 115);
doc.setFont(fontFamily,"bold"); doc.setFontSize(13); setC(C.white);
doc.text(clientName, 18, 122);
}
// ════════════════════════════════════════════════════════
// PÁGINA 2 — FALE CONOSCO (slide-02.png)
// Adiciona apenas links clicáveis amplos sobre os botões (ícones e textos vêm da image
// ════════════════════════════════════════════════════════
doc.addPage();
pageBg = bgSlide(2);
if (pageBg) {
safeAddImage(pageBg, "PNG", 0, 0, W, H);
} else {
setF(C.bgDark); doc.rect(0, 0, W, H, "F");
}
// ── Links clicáveis: área ampla cobrindo ícone + texto "Clique aqui!" ──
// "Clique aqui!" está em x=93-126mm, y=140-147mm. Junto com ícone vira x=70-127, y=134
if (consWaGestorUrl) {
doc.link(70, 134, 60, 16, { url: consWaGestorUrl });
}
// "Link Formulário" em x=194-228mm, y=136-148mm. Junto com ícone share (à esquerda do
if (consFormUrl) {
doc.link(180, 134, 55, 16, { url: consFormUrl });
}
// ════════════════════════════════════════════════════════
// PÁGINAS DE COMPRAS — paginadas em chunks de 10 ativos
// Quando há mais de 10 ativos, gera múltiplos slides com o mesmo fundo
// (slide-{slideCompras}.png). Os totais ("Total de compras: R$ X") aparecem
// apenas no ÚLTIMO slide do tipo. Se não houver nenhuma compra, gera 1 slide
// vazio (comportamento anterior).
// ════════════════════════════════════════════════════════
var MAX_ROWS_PER_SLIDE = 10;
var comprasChunks = [];
if (compras.length === 0) {
comprasChunks = [[]]; // 1 slide vazio
} else {
for (var ic = 0; ic < compras.length; ic += MAX_ROWS_PER_SLIDE) {
comprasChunks.push(compras.slice(ic, ic + MAX_ROWS_PER_SLIDE));
}
}
comprasChunks.forEach(function(chunk, chunkIdx){
doc.addPage();
var pageBgC = bgSlide(slideCompras);
if (pageBgC) {
safeAddImage(pageBgC, "PNG", 0, 0, W, H);
} else {
setF(C.white); doc.rect(0, 0, W, H, "F");
}
});
doc.setFont(fontFamily,"bold"); doc.setFontSize(16); setC(C.black);
doc.text(dataFmt, 13.5, 18);
var isLastCompras = chunkIdx === comprasChunks.length - 1;
drawTabelaSobreSlide(chunk, "compras", false, opts.comprasObsOverride || "", isLastCo
// ════════════════════════════════════════════════════════
// PÁGINAS DE VENDAS — paginadas em chunks de 10 ativos
// Mesma lógica das compras. O resumo geral consolidado (compras+vendas)
// aparece apenas no ÚLTIMO slide de vendas.
// ════════════════════════════════════════════════════════
var vendasChunks = [];
if (vendas.length === 0) {
vendasChunks = [[]]; // 1 slide vazio (mostra "Nenhuma ordem..." + resumo geral)
} else {
for (var iv = 0; iv < vendas.length; iv += MAX_ROWS_PER_SLIDE) {
vendasChunks.push(vendas.slice(iv, iv + MAX_ROWS_PER_SLIDE));
}
}
vendasChunks.forEach(function(chunk, chunkIdx){
doc.addPage();
var pageBgV = bgSlide(slideVendas);
if (pageBgV) {
safeAddImage(pageBgV, "PNG", 0, 0, W, H);
} else {
setF(C.white); doc.rect(0, 0, W, H, "F");
}
});
doc.setFont(fontFamily,"bold"); doc.setFontSize(16); setC(C.black);
doc.text(dataFmt, 13.5, 18);
var isLastVendas = chunkIdx === vendasChunks.length - 1;
// Resumo geral só no último slide de vendas
drawTabelaSobreSlide(chunk, "vendas", isLastVendas, opts.vendasObsOverride || "", isL
// (Função drawTablePage e chamadas removidas — tabelas agora são
// desenhadas diretamente sobre as imagens dos slides via drawTabelaSobreSlide)
// ════════════════════════════════════════════════════════
// PÁGINA 5 — ME CONTATE (slide-27.png template em branco)
// Sobrepõe: foto, nome, bio, telefone, email, LinkedIn label,
// e adiciona links clicáveis sobre os botões "Clique aqui!".
// ════════════════════════════════════════════════════════
doc.addPage();
pageBg = bgSlide(27);
if (pageBg) {
safeAddImage(pageBg, "PNG", 0, 0, W, H);
} else {
setF(C.bgDark); doc.rect(0, 0, W, H, "F");
}
// ── Coordenadas REAIS calibradas em HD do slide-27 (4000x2250 px → 338.67x190.5 mm):
// // // Retângulo vermelho do nome: x_inicio=27.52mm, x_fim=104.06mm
→ largura REAL = 76.54mm (medido do PNG)
y=126.4mm a 140.2mm (altura ~13.8mm)
// ── Foto do consultor: largura idêntica ao retângulo (76.54mm), altura ampliada ──
// Topo da foto sobe pra 47mm (~4mm acima do início do parágrafo "Lembrou de alguém..."
// Base mantida em 126.4mm (encostada no topo do retângulo do nome)
var photoX = 27.52, photoW = 76.54;
var photoY = 47;
var photoH = 126.4 - photoY; // = 79.4mm
var fotoFmt = consFoto && consFoto.indexOf("data:image/png") === 0 ? "PNG" : "JPEG";
var okFoto = safeAddImage(consFoto, fotoFmt, photoX, photoY, photoW, photoH);
if (!okFoto) {
setF([55, 60, 70]);
doc.rect(photoX, photoY, photoW, photoH, "F");
}
// ── Nome do consultor centralizado dentro do retângulo vermelho ──
// Centro retângulo: x = (27.52 + 104.06)/2 = 65.79mm
// Para fonte 16, baseline ≈ y_centro+2 → y=135.2 (ajuste fino)
var nomeFontSize = 16;
doc.setFont(fontFamily,"bold"); doc.setFontSize(nomeFontSize); setC(C.white);
var nomeStr = consNome || "Consultor";
// Auto-shrink se exceder a largura útil (76 - 6 de margem = 70mm)
while (doc.getTextWidth(nomeStr) > 70 && nomeFontSize > 9) {
nomeFontSize -= 0.5;
doc.setFontSize(nomeFontSize);
}
doc.text(nomeStr, 65.79, 135.5, {align:"center"});
// ── Bio (descrição) abaixo do retângulo, mesmo recorte de largura ──
doc.setFont(fontFamily,"normal"); doc.setFontSize(11); setC(C.white);
var bioLines = wrap(consBio, photoW, 11);
var by = 148;
bioLines.forEach(function(L){ doc.text(L, photoX, by); by += 5; });
// ── Telefone (ao lado do ícone telefone, y≈131mm) ──
doc.setFont(fontFamily,"normal"); doc.setFontSize(11); setC(C.white);
if (consTelefone) doc.text(consTelefone, 200, 131);
// ── Email (ao lado do ícone email, y≈146mm) ──
if (consEmail) doc.text(consEmail, 200, 146);
// ── LinkedIn label (ao lado do ícone LinkedIn, y≈160mm) ──
doc.text(consNome ? (consNome + ", CEA, CNPI") : "LinkedIn", 200, 160);
// ── Links clicáveis sobrepostos aos botões da imagem ──
// Coordenadas calibradas em HD do slide-27:
// Botão WhatsApp pessoal "Clique aqui!" → x=125.0-163.3mm, y=153.4-164.5mm
// Botão Agenda "Clique aqui!" → x=280.9-319.0mm, y=153.4-164.5mm
// Ampliar área pra cobrir o ícone (acima do botão) também
if (consWaUrl) {
doc.link(115, 130, 55, 35, { url: consWaUrl }); // cobre ícone WhatsApp + botão
}
if (consAgendaUrl) {
doc.link(275, 130, 50, 35, { url: consAgendaUrl }); // cobre ícone calendário + botã
}
// Links nos textos de contato
if (consTelefone) doc.link(195, 127, 80, 7, { url: "tel:" + consTelefone.replace(/\D
if (consEmail) doc.link(195, 142, 80, 7, { url: "mailto:" + consEmail });
if (consLinkedinUrl) doc.link(195, 156, 80, 7, { url: consLinkedinUrl });
// ════════════════════════════════════════════════════════
// PÁGINA 6 — DISCLAIMER (slide-28.png)
// Sem campos editáveis — slide já contém o disclaimer completo
// ════════════════════════════════════════════════════════
doc.addPage();
pageBg = bgSlide(28);
if (pageBg) {
safeAddImage(pageBg, "PNG", 0, 0, W, H);
} else {
setF(C.bgDark); doc.rect(0, 0, W, H, "F");
}
// ════════════════════════════════════════════════════════
// SAVE
// ════════════════════════════════════════════════════════
var fnDate = new Date().toISOString().slice(0,10).replace(/-/g, ".");
var fnClient = (clientName || "Cliente").trim();
var fn = fnDate + " - " + fnClient + " - Recomendações.pdf";
doc.save(fn);
} catch(err) {
console.error(err);
alert("Erro PDF Consultivo: " + err.message);
}
setPdfConsultivoGerando(false);
}
// ═══════════════════════════════════════════════════════════════════
// ── Busca cotações ao vivo pros tickers do ciclo (RV BR + Internacional)
// // // Retorna: { BBSE3: {priceOrig, currency, priceBRL, fx, timestamp, source},
AMZN: {priceOrig, currency, priceBRL, fx, timestamp, source} }
source: "yahoo" | "ia" | "cache"
// ═══════════════════════════════════════════════════════════════════
async function fetchLiveQuotes() {
var stockByTicker = {};
allAppStocks.forEach(function(s){ if (s.ticker) stockByTicker[s.ticker] = s; });
// Coleta tickers RV que precisam cotação
var tickersNeedingQuote = [];
var tickerMeta = {}; // ticker → {currency detectada, classe}
Object.keys(allocations).forEach(function(tk){
var al = allocations[tk]; if (!al) return;
if (al._classe === "renda_fixa" || al._classe === "caixa") return;
if (tk.indexOf("RF_") === 0) return;
var stock = stockByTicker[tk];
var portfolio = stock ? stock._portfolio : null;
var cur = detectCurrencyFromTicker(tk, portfolio, al._classe);
tickersNeedingQuote.push(tk);
tickerMeta[tk] = {currency: cur, classe: al._classe, portfolio: portfolio};
});
if (tickersNeedingQuote.length === 0) {
console.log("[fetchLiveQuotes] Nenhum ticker pra buscar");
return {};
}
console.log("[fetchLiveQuotes] Tickers:", tickersNeedingQuote, "meta:", tickerMeta);
var result = {};
// ── Helper: converte ticker pra formato Yahoo ──
// B3 (BRL): adiciona .SA se não tiver
// US (USD): sem sufixo
// Europa/UK/etc: sufixo já deve estar no ticker
function toYahooSymbol(tk, cur) {
var t = String(tk).toUpperCase().trim();
if (cur === "BRL") {
// Se já termina em .SA, mantém; senão adiciona
if (t.endsWith(".SA")) return t;
// Ticker B3 padrão: 3-6 alfanuméricos + 1-2 dígitos → adiciona .SA
// (aceita LBRDA34, HPQB34, B3SA3, PETR4, BOVA11 etc)
if (/^[A-Z0-9]{3,6}\d{1,2}$/.test(t)) return t + ".SA";
return t; // senão deixa como está (pode não funcionar, mas tentamos)
}
return t; // US e outros: já tem sufixo ou não precisa
}
// ── Descobre quais câmbios precisamos ──
var foreignCurrencies = {};
Object.keys(tickerMeta).forEach(function(tk){
var cur = tickerMeta[tk].currency;
if (cur !== "BRL") foreignCurrencies[cur] = true;
});
var fxTickers = Object.keys(foreignCurrencies).map(function(c){ return c + "BRL=X"; });
// ── Cache de câmbio sessionStorage (TTL 15 min) ──
var FX_CACHE_TTL_MS = 15 * 60 * 1000;
function getCachedFX(cur) {
try {
var raw = sessionStorage.getItem("fx_cache_" + cur);
if (!raw) return null;
var obj = JSON.parse(raw);
if (!obj || typeof obj.rate !== "number" || !obj.ts) return null;
if (Date.now() - obj.ts > FX_CACHE_TTL_MS) return null;
return obj.rate;
} catch(e) { return null; }
function setCachedFX(cur, rate) {
try { sessionStorage.setItem("fx_cache_"+cur, JSON.stringify({rate: rate, ts: Date.now(
}
}
var fxRates = {BRL: 1};
var fxTickersToFetch = [];
fxTickers.forEach(function(fxt){
var cur = fxt.replace("BRL=X", "");
var cached = getCachedFX(cur);
if (cached && cached > 0) {
fxRates[cur] = cached;
console.log("[fetchLiveQuotes] câmbio em cache "+cur+"/BRL:", cached);
} else {
fxTickersToFetch.push(fxt);
}
});
// ── Monta lista Yahoo: tickers de ativos + câmbios não-cacheados ──
var yahooSymbols = [];
var yahooToOriginal = {}; // yahooSymbol → originalTicker
tickersNeedingQuote.forEach(function(tk){
var sym = toYahooSymbol(tk, tickerMeta[tk].currency);
yahooSymbols.push(sym);
yahooToOriginal[sym] = tk;
});
fxTickersToFetch.forEach(function(fxt){ yahooSymbols.push(fxt); });
// ── Chama Yahoo em 1 request ──
var yahooResults = {};
var yahooErrors = [];
try {
var url = "/api/yahoo?tickers=" + encodeURIComponent(yahooSymbols.join(","));
console.log("[fetchLiveQuotes] Yahoo URL:", url);
var resp = await fetch(url);
if (resp.ok) {
var data = await resp.json();
yahooResults = data.results || {};
yahooErrors = data.errors || [];
console.log("[fetchLiveQuotes] Yahoo results:", Object.keys(yahooResults).length, "er
if (yahooErrors.length > 0) console.log("[fetchLiveQuotes] Yahoo errors detail:", yah
} else {
console.warn("[fetchLiveQuotes] Yahoo endpoint retornou", resp.status);
}
} catch(e) {
console.warn("[fetchLiveQuotes] Yahoo fetch falhou:", e);
}
// ── Extrai câmbios do Yahoo ──
fxTickersToFetch.forEach(function(fxt){
var cur = fxt.replace("BRL=X", "");
var r = yahooResults[fxt];
if (r && r.price > 0) {
fxRates[cur] = r.price;
setCachedFX(cur, r.price);
console.log("[fetchLiveQuotes] câmbio Yahoo "+cur+"/BRL =", r.price);
}
});
// ── Processa cada ticker: Yahoo primeiro, IA como fallback ──
var tickersForIAFallback = [];
tickersNeedingQuote.forEach(function(tk){
var meta = tickerMeta[tk];
var yahooSym = toYahooSymbol(tk, meta.currency);
var yr = yahooResults[yahooSym];
if (yr && yr.price > 0) {
// Yahoo retornou — usa
var cur = yr.currency || meta.currency;
var fx = fxRates[cur] || (cur === "BRL" ? 1 : 0);
result[tk.toUpperCase()] = {
priceOrig: yr.price,
currency: cur,
priceBRL: fx > 0 ? yr.price * fx : 0,
fx: fx,
timestamp: yr.timestamp || 0,
source: "yahoo",
};
} else {
// Yahoo falhou — manda pra IA
tickersForIAFallback.push(tk);
}
});
// ── Fallback IA pros tickers que Yahoo não achou ──
if (tickersForIAFallback.length > 0) {
console.log("[fetchLiveQuotes] Fallback IA pra:", tickersForIAFallback);
// Agrupa por moeda
var iaByCurrency = {};
tickersForIAFallback.forEach(function(tk){
var cur = tickerMeta[tk].currency;
if (!iaByCurrency[cur]) iaByCurrency[cur] = [];
iaByCurrency[cur].push(tk);
});
// Descobre se precisamos de algum câmbio ainda não temos
var fxNeededIA = [];
Object.keys(iaByCurrency).forEach(function(cur){
if (cur !== "BRL" && !fxRates[cur]) fxNeededIA.push(cur);
});
// Monta prompt único
var promptParts = ["Busque cotacoes atuais (preco de fechamento mais recente)."];
Object.keys(iaByCurrency).forEach(function(cur){
var label = cur === "USD" ? "dolares" : cur === "EUR" ? "euros" : cur;
promptParts.push("Ativos em "+cur+" ("+label+"): " + iaByCurrency[cur].join(", ") + "
});
if (fxNeededIA.length > 0) {
promptParts.push("Taxas de cambio para BRL destas moedas: " + fxNeededIA.join(", ") +
}
promptParts.push("Responda SOMENTE JSON: {\"TICKER\": preco_na_moeda_do_ativo, ...}. Ca
var prompt = promptParts.join(" ");
try {
// Timeout defensivo: fallback IA com web_search pode demorar 30-60s.
// Se não responder em 15s, aborta e segue sem esses preços (tabela mostra "—").
var iaCtrl = new AbortController();
var iaTimeout = setTimeout(function(){ iaCtrl.abort(); }, 15000);
var iaResp = await fetch("/api/anthropic", {
method: "POST", headers: {"Content-Type": "application/json"},
signal: iaCtrl.signal,
body: JSON.stringify({
model: "claude-sonnet-4-6", max_tokens: 2048,
tools: [{"type": "web_search_20250305", "name": "web_search"}],
messages: [{role: "user", content: prompt}]
})
});
clearTimeout(iaTimeout);
if (iaResp.ok) {
var iaData = await iaResp.json();
var raw = "";
for (var i = 0; i < iaData.content.length; i++) { if (iaData.content[i].text) raw +
console.log("[fetchLiveQuotes IA] raw:", raw.slice(0, 300));
raw = raw.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"");
var si = raw.indexOf("{"); var ei = raw.lastIndexOf("}");
if (si >= 0 && ei > si) {
try {
var parsedIA = JSON.parse(raw.slice(si, ei+1));
// Extrai câmbios que precisava
fxNeededIA.forEach(function(cur){
var candidates = ["FX_"+cur+"_BRL", cur+"_BRL", cur+"BRL"];
for (var j = 0; j < candidates.length; j++) {
var v = parseFloat(parsedIA[candidates[j]]);
if (v > 0) { fxRates[cur] = v; setCachedFX(cur, v); break; }
}
});
// Extrai preços
tickersForIAFallback.forEach(function(tk){
var cur = tickerMeta[tk].currency;
var fx = fxRates[cur] || (cur === "BRL" ? 1 : 0);
var p = parseFloat(parsedIA[tk]) || parseFloat(parsedIA[tk.toUpperCase()]) ||
result[tk.toUpperCase()] = {
priceOrig: p,
currency: cur,
priceBRL: p > 0 && fx > 0 ? p * fx : 0,
fx: fx,
timestamp: 0,
source: "ia",
};
});
} catch(e) { console.warn("[fetchLiveQuotes IA] parse JSON erro:", e); }
}
} else {
console.warn("[fetchLiveQuotes IA] HTTP", iaResp.status);
}
} catch(e) { console.warn("[fetchLiveQuotes IA] erro:", e); }
// Pra tickers que nem IA retornou, registra com 0 preço mas com moeda correta
tickersForIAFallback.forEach(function(tk){
if (!result[tk.toUpperCase()]) {
var cur = tickerMeta[tk].currency;
result[tk.toUpperCase()] = {
priceOrig: 0, currency: cur, priceBRL: 0, fx: fxRates[cur] || 0, timestamp: 0, so
};
}
});
}
console.log("[fetchLiveQuotes] Resultado final:", result);
return result;
}
var btnBaseV2 = {padding:"10px 16px",borderRadius:"8px",fontSize:"11px",fontWeight:700,bord
var lS = {display:"block",fontSize:"9px",fontWeight:600,color:"rgba(255,255,255,0.4)",textT
var iS = {width:"100%",padding:"8px 10px",borderRadius:"6px",border:"1px solid rgba(255,255
return <div>
{/* Step indicator V2 */}
<div style={{display:"flex",gap:"3px",marginBottom:"14px"}}>
{REC_V2_STEPS.map(function(s){
var isActive = s === step;
var idx = REC_V2_STEPS.indexOf(s);
var curIdx = REC_V2_STEPS.indexOf(step);
var isDone = idx < curIdx;
return <div key={s} style={{flex:1,textAlign:"center",padding:"6px 3px",borderRadius:
})}
</div>
*/}
{/* ═══════════════════════════════════════════════════════════ */}
{/* ETAPA 1 — ESTADO (substitui POSIÇÃO + SELECIONAR) {/* ═══════════════════════════════════════════════════════════ */}
{step === "estado" && (<div>
{loadingSnap && <div style={{textAlign:"center",padding:"30px",color:"rgba(255,255,255,
{snapError && <div style={{background:"rgba(248,113,113,0.06)",border:"1px solid rgba(2
{!loadingSnap && !latestAtualSnap && (
<div style={{background:"rgba(251,191,36,0.05)",border:"1px solid rgba(251,191,36,0.2
<div style={{fontSize:"12px",color:"#fbbf24",fontWeight:700,marginBottom:"6px"}}>⚠
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.5)",lineHeight:1.5}}>Importe
</div>
)}
{!loadingSnap && latestAtualSnap && (<div style={{display:"grid",gridTemplateColumns:"m
{/* ─── COLUNA 1 — CONTEXTO DO CICLO ─── */}
<div style={{background:"#0e0e0e",border:"1px solid rgba(255,255,255,0.05)",borderRad
<div style={{fontSize:"10px",fontWeight:700,color:"#a78bfa",textTransform:"uppercas
<div style={{marginBottom:"10px"}}>
<label style={lS}>Consultor</label>
<div style={{display:"flex",gap:"6px",alignItems:"stretch"}}>
<input value={consultorName} onChange={function(e){setConsultorName(e.target.va
<button
onClick={function(){ setShowConsultorEditor(true); }}
title="Editar perfil completo do consultor (foto, bio, contatos, links)"
style={{padding:"0 11px",borderRadius:"7px",border:"1px solid rgba(167,139,25
>Editar perfil</button>
</div>
{consultorProfile && (
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.3)",marginTop:"4px"}}>
{consultorProfile.foto_url ? "✓ Foto" : "○ Sem foto"} ·{" "}
{consultorProfile.whatsapp_url ? "✓ WhatsApp" : "○ Sem WhatsApp"} ·{" "}
{consultorProfile.calendly_url ? "✓ Agenda" : "○ Sem agenda"} ·{" "}
{consultorProfile.linkedin_url ? "✓ LinkedIn" : "○ Sem LinkedIn"}
</div>
)}
</div>
<div style={{marginBottom:"10px"}}>
<label style={lS}>Período</label>
<input value={period} onChange={function(e){setPeriod(e.target.value);}} type="mo
</div>
<div style={{marginBottom:"14px"}}>
<label style={lS}>Saldo disponível (R$)</label>
<input
value={availableCashV2?("R$ "+formatBRL(availableCashV2)):""}
onChange={function(e){setAvailableCashV2(String(parseBRL(e.target.value))); set
placeholder="R$ 0"
style={iS}
/>
</div>
{/* Status do snapshot */}
<div style={{background:"rgba(74,222,128,0.04)",border:"1px solid rgba(74,222,128,0
<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",ma
<span style={{fontSize:"9px",padding:"2px 7px",borderRadius:"10px",background:"
<span style={{fontSize:"9px",color:"rgba(255,255,255,0.35)"}}>{latestAtualSnap.
</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.5)",marginTop:"2px"}}>
{((latestAtualSnap.data && latestAtualSnap.data.ativos) || []).length} ativos ·
</div>
{resolvedTarget ? (
<div style={{fontSize:"9px",marginTop:"6px"}}>
{resolvedTarget.source === "saved" ? (
<span style={{color:"#a78bfa",fontWeight:700}}>✓ Alvo editado manualmente</
) : (
<span style={{color:"rgba(255,255,255,0.4)"}}>Alvo derivado do Journey Book
)}
</div>
) : (
<div style={{fontSize:"9px",color:"#fbbf24",marginTop:"6px"}}>⚠ Sem alvo config
)}
<button
onClick={function(){ setShowSnapshotViewer(true); }}
style={{marginTop:"8px",width:"100%",padding:"6px",fontSize:"10px",fontWeight:7
>✎ Ver e editar snapshot</button>
</div>
</div>
{/* ─── COLUNA 2 — GAPS EM DESTAQUE ─── */}
<div style={{background:"#0e0e0e",border:"1px solid rgba(255,255,255,0.05)",borderRad
<div style={{fontSize:"10px",fontWeight:700,color:"#60a5fa",textTransform:"uppercas
{gapsByClass.length === 0 && <div style={{fontSize:"11px",color:"rgba(255,255,255,0
{gapsByClass.map(function(g){
var hasTgt = g.tgPct > 0;
var clr = gapColor(g.absGap, hasTgt);
var barMax = Math.max(g.atPct, g.tgPct, 20);
var atBarPct = (g.atPct / barMax) * 100;
var tgBarPct = (g.tgPct / barMax) * 100;
var classClr = g.cls==="renda_fixa" ? "#3b82f6" : g.cls==="acoes_br" ? "#dc2626"
return <div key={g.cls} onClick={function(){ setGapDetailClasse(g.cls); setGapDet
<div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline
<span style={{color:"#f1f5f9",fontWeight:600}}>{CLASS_LABELS_V2[g.cls]} <span
<span style={{fontVariantNumeric:"tabular-nums",display:"flex",gap:"6px",alig
<span style={{color:"rgba(255,255,255,0.85)",fontWeight:700}}>{g.atPct.toFi
<span style={{color:"rgba(255,255,255,0.3)",fontSize:"10px"}}>→</span>
<span style={{color:"rgba(255,255,255,0.4)"}}>{hasTgt ? g.tgPct.toFixed(1)+
{hasTgt && <span style={{color:clr,fontWeight:700,minWidth:"50px",textAlign
</span>
</div>
{/* Mini barra */}
<div style={{position:"relative",height:"4px",background:"rgba(255,255,255,0.05
<div style={{position:"absolute",left:0,top:0,height:"100%",width:atBarPct+"%
{hasTgt && <div style={{position:"absolute",left:tgBarPct+"%",top:"-1px",widt
</div>
</div>;
})}
{/* Gaps RF por indexador */}
{rfGaps.length > 0 && (
<div style={{marginTop:"14px",paddingTop:"12px",borderTop:"1px dashed rgba(255,25
<div style={{fontSize:"9px",fontWeight:700,color:"rgba(255,255,255,0.4)",textTr
{rfGaps.map(function(g){
var hasTgt = g.tgPct > 0;
var clr = gapColor(g.absGap, hasTgt);
return <div key={g.ix} style={{display:"flex",justifyContent:"space-between",
<span style={{color:"rgba(255,255,255,0.65)"}}>{INDEXADOR_LABELS_V2[g.ix]}<
<span style={{fontVariantNumeric:"tabular-nums",display:"flex",gap:"5px",al
<span style={{color:"#f1f5f9"}}>{g.atPct.toFixed(1)}%</span>
<span style={{color:"rgba(255,255,255,0.3)"}}>→</span>
<span style={{color:"rgba(255,255,255,0.4)"}}>{hasTgt ? g.tgPct.toFixed(1
{hasTgt && <span style={{color:clr,fontWeight:700,minWidth:"48px",textAli
</span>
</div>;
})}
</div>
)}
</div>
{/* ─── COLUNA 3 — SUGESTÕES ─── */}
<div style={{background:"#0e0e0e",border:"1px solid rgba(255,255,255,0.05)",borderRad
<div style={{fontSize:"10px",fontWeight:700,color:"#fbbf24",textTransform:"uppercas
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.3)",marginBottom:"12px",lineH
{(sugestoes.reducao.length + sugestoes.em_avaliacao.length + sugestoes.fora_carteir
<div style={{textAlign:"center",padding:"20px 0",color:"rgba(255,255,255,0.3)",fo
Nenhum ativo com status especial.<br/>Toda a carteira em "Manter/Core".
</div>
)}
{sugestoes.reducao.length > 0 && (<div style={{marginBottom:"10px"}}>
<div style={{fontSize:"9px",fontWeight:700,color:"#f87171",marginBottom:"4px",let
{sugestoes.reducao.map(function(a,i){
return <div key={a.ticker || a.nome_original || i} style={{display:"flex",justi
<span style={{color:"#f1f5f9",fontWeight:600}}>{a.ticker || (a.nome_original|
<span style={{color:"rgba(255,255,255,0.5)",fontVariantNumeric:"tabular-nums"
</div>;
})}
</div>)}
{sugestoes.em_avaliacao.length > 0 && (<div style={{marginBottom:"10px"}}>
<div style={{fontSize:"9px",fontWeight:700,color:"#fbbf24",marginBottom:"4px",let
{sugestoes.em_avaliacao.map(function(a,i){
return <div key={a.ticker || a.nome_original || i} style={{display:"flex",justi
<span style={{color:"#f1f5f9",fontWeight:600}}>{a.ticker || (a.nome_original|
<span style={{color:"rgba(255,255,255,0.5)",fontVariantNumeric:"tabular-nums"
</div>;
})}
</div>)}
{sugestoes.fora_carteira.length > 0 && (<div>
<div style={{fontSize:"9px",fontWeight:700,color:"#fb923c",marginBottom:"4px",let
{sugestoes.fora_carteira.slice(0,8).map(function(a,i){
return <div key={a.ticker || a.nome_original || i} style={{display:"flex",justi
<span style={{color:"#f1f5f9",fontWeight:600}}>{a.ticker || (a.nome_original|
<span style={{color:"rgba(255,255,255,0.5)",fontVariantNumeric:"tabular-nums"
</div>;
})}
</div>)}
</div>
{sugestoes.fora_carteira.length > 8 && <div style={{fontSize:"9px",color:"rgba(25
</div>)}
{/* Botão de avanço */}
{!loadingSnap && latestAtualSnap && (
<div style={{marginTop:"16px",display:"flex",justifyContent:"flex-end"}}>
<button
onClick={function(){ setStep("ordens"); }}
disabled={!availableCashV2 || Number(availableCashV2) <= 0}
style={Object.assign({},btnBaseV2,{background:availableCashV2 && Number(available
>
Montar ordens →
</button>
</div>
)}
{/* ═══ MODAL: Gap detalhado por ativo ═══ */}
{gapDetailClasse && (function(){
// Prioriza snapshot/target explicitamente setados (p/ aba Estratégia);
// senão cai no latestAtualSnap da Recomendação Mensal
var snapForDetail = gapDetailSnapshot || (latestAtualSnap && latestAtualSnap.data) ||
var targetForDetail = gapDetailTarget || resolvedTarget || null;
if (!snapForDetail || !targetForDetail) return null;
var classe = gapDetailClasse;
var mode = gapDetailMode; // "carteira" | "classe"
var atVs = snapForDetail.ativos || [];
var totalPatr = atVs.reduce(function(s,a){ return s + (a.valor || 0); }, 0);
// Filtra ativos da classe
var ativosDaClasse = atVs.filter(function(a){ return a.classe === classe; });
var totalClasse = ativosDaClasse.reduce(function(s,a){ return s + (a.valor || 0); },
// Alvo por ativo (em % da carteira) vem do target.allocAtivos
var alvoAtivos = (targetForDetail && targetForDetail.allocAtivos) || {};
// Junta ativos atuais + ativos do alvo que o cliente ainda não tem
var tickersMap = {};
ativosDaClasse.forEach(function(a){
var tk = a.ticker || a.nome_original || "";
if (!tk) return;
tickersMap[tk] = {
ticker: tk,
nome: a.nome_original || a.ticker,
subclasse: a.subclasse || null,
status: a.status_recomendacao || null,
valor: a.valor || 0,
atPctCarteira: totalPatr > 0 ? (a.valor / totalPatr) * 100 : 0,
atPctClasse: totalClasse > 0 ? (a.valor / totalClasse) * 100 : 0,
tgPctCarteira: 0,
noAlvo: false,
forayCarteira: false,
// Dados pra cálculo de L/P na renderização (ver coluna Preço & L/P)
_classe: a.classe,
_preco_medio: a.preco_medio,
_preco: a.preco,
_quantidade: a.quantidade
};
});
// Filtra allocAtivos do alvo: adiciona só os que são dessa classe
// Pra saber a classe do alvo, cruza com allAppStocks (portfolio Internacional/Divide
var stockByTicker = {};
allAppStocks.forEach(function(s){ if (s.ticker) stockByTicker[s.ticker] = s; });
Object.keys(alvoAtivos).forEach(function(tk){
var tgPct = alvoAtivos[tk] || 0;
if (tgPct <= 0) return;
// Determina classe do ticker via stock do Suno research
var stock = stockByTicker[tk];
var classeAlvo = null;
if (stock && stock._portfolio) {
if (stock._portfolio === "Internacional") classeAlvo = "internacional";
else if (stock._portfolio === "FIIs") classeAlvo = "fiis";
else classeAlvo = "acoes_br"; // Dividendos, Valor, Small Caps
}
// Se o cliente já tem esse ticker, usa a classe do ativo do cliente
if (tickersMap[tk]) classeAlvo = classe; // já está no map
if (classeAlvo !== classe) return; // não é dessa classe
if (tickersMap[tk]) {
tickersMap[tk].tgPctCarteira = tgPct;
tickersMap[tk].noAlvo = true;
} else {
tickersMap[tk] = {
ticker: tk,
nome: stock ? stock.name : tk,
subclasse: null,
status: null,
valor: 0,
atPctCarteira: 0,
atPctClasse: 0,
tgPctCarteira: tgPct,
noAlvo: true,
forayCarteira: false,
};
}
});
// Marca ativos que estão fora do alvo (cliente tem mas não é carteira Suno)
Object.keys(tickersMap).forEach(function(tk){
if (tickersMap[tk].atPctCarteira > 0 && tickersMap[tk].tgPctCarteira === 0) {
tickersMap[tk].forayCarteira = true;
}
});
// Converte pra lista e ordena
var lista = Object.values(tickersMap);
// Alvo na unidade escolhida
lista.forEach(function(it){
if (mode === "carteira") {
it.atEff = it.atPctCarteira;
it.tgEff = it.tgPctCarteira;
} else {
it.atEff = it.atPctClasse;
// % da classe: converte alvo_carteira pra alvo_classe
// alvoClasse total desta classe = sum(allocAtivos da classe)
// mas pra simplificar: se totalClasse alvo = X% da carteira, cada ativo X% é it.
var tgClasseTotal = 0;
lista.forEach(function(x){ tgClasseTotal += x.tgPctCarteira || 0; });
it.tgEff = tgClasseTotal > 0 ? (it.tgPctCarteira / tgClasseTotal) * 100 : 0;
}
});
it.gapEff = it.atEff - it.tgEff;
it.absGapEff = Math.abs(it.gapEff);
lista.sort(function(a,b){ return (b.valor || 0) - (a.valor || 0); });
// Pra RF: agrupa por indexador
var gruposRF = null;
if (classe === "renda_fixa") {
gruposRF = {};
ativosDaClasse.forEach(function(a){
var ix = canonicalizeRFSubclasse(a);
if (!gruposRF[ix]) gruposRF[ix] = {atValor: 0, ativos: []};
gruposRF[ix].atValor += (a.valor || 0);
gruposRF[ix].ativos.push(a);
});
// Adiciona alvo por indexador
var allocIxTg = (targetForDetail && targetForDetail.allocIndexadoresRF) || {};
Object.keys(allocIxTg).forEach(function(ix){
if (!gruposRF[ix]) gruposRF[ix] = {atValor: 0, ativos: []};
gruposRF[ix].tgPctCarteira = allocIxTg[ix];
});
Object.keys(gruposRF).forEach(function(ix){
var g = gruposRF[ix];
g.atPctCarteira = totalPatr > 0 ? (g.atValor / totalPatr) * 100 : 0;
g.atPctClasse = totalClasse > 0 ? (g.atValor / totalClasse) * 100 : 0;
g.tgPctCarteira = g.tgPctCarteira || 0;
});
}
var classLabel = CLASS_LABELS_V2[classe] || classe;
var classClr = classe==="renda_fixa" ? "#3b82f6" : classe==="acoes_br" ? "#dc2626" :
function fmtPct(x){ return (x||0).toFixed(2) + "%"; }
function gapColorLocal(g) {
if (g > 0.5) return "#60a5fa"; // acima: azul
if (g < -0.5) return "#f87171"; // abaixo: vermelho
return "#4ade80"; // ok: verde
}
return (
<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",zIndex:2200,dis
<div style={{background:"#0a0a0a",border:"1px solid "+classClr+"33",borderRadius:
{/* Header */}
<div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-sta
<div>
<div style={{fontSize:"10px",fontWeight:700,color:classClr,textTransform:"u
<div style={{fontSize:"17px",fontWeight:800,color:"#fff"}}>{classLabel}</di
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginTop:"3px"}
R$ {totalClasse.toLocaleString("pt-BR",{maximumFractionDigits:0})} · {ati
</div>
</div>
<button onClick={function(){ setGapDetailClasse(null); setGapDetailSnapshot(n
</div>
{/* Toggle modo de visualização */}
<div style={{display:"flex",gap:"6px",marginBottom:"14px"}}>
{[{k:"carteira",l:"% da carteira total",d:"Quanto cada ativo representa do pa
var isSel = mode === opt.k;
return <button key={opt.k} onClick={function(){ setGapDetailMode(opt.k); }}
style={{flex:1,padding:"8px 10px",fontSize:"10px",fontWeight:700,borderRa
{opt.l}
</button>;
})}
</div>
{/* Legenda */}
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.45)",marginBottom:"10px",
<b style={{color:"rgba(255,255,255,0.6)"}}>Legenda:</b> <span style={{color:"
</div>
{/* Banner: alvo por ticker vazio (cliente só tem Asset Alloc, sem JB real) */}
{Object.keys(alvoAtivos).length === 0 && (
<div style={{background:"rgba(16,185,129,0.06)",border:"1px solid rgba(16,185
<div style={{display:"flex",gap:"10px",alignItems:"flex-start"}}>
<span style={{fontSize:"14px",color:"#10b981"}}> </span>
<div style={{flex:1}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#10b981",marginBotto
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.65)",lineHeight:
</div>
</div>
</div>
)}
{/* Grupos RF por indexador (só em RF) */}
{classe === "renda_fixa" && gruposRF && (
<div style={{marginBottom:"18px",padding:"12px",background:"rgba(59,130,246,0
<div style={{fontSize:"9px",fontWeight:700,color:"#60a5fa",textTransform:"u
{Object.keys(gruposRF).map(function(ix){
var g = gruposRF[ix];
var atE = mode === "carteira" ? g.atPctCarteira : g.atPctClasse;
var tgCarteiraTotal = Object.values(gruposRF).reduce(function(s,x){return
var tgE = mode === "carteira" ? g.tgPctCarteira : (tgCarteiraTotal > 0 ?
var gapEE = atE - tgE;
var gapClr = gapColorLocal(gapEE);
return <div key={ix} style={{display:"flex",justifyContent:"space-between
<span style={{color:"#f1f5f9",fontWeight:600}}>{INDEXADOR_LABELS_V2[ix]
<span style={{display:"flex",gap:"8px",alignItems:"baseline",fontVarian
<span style={{color:"rgba(255,255,255,0.85)",minWidth:"50px",textAlig
<span style={{color:"rgba(255,255,255,0.3)"}}>→</span>
<span style={{color:"rgba(255,255,255,0.5)",minWidth:"50px",textAlign
<span style={{color:gapClr,fontWeight:700,minWidth:"52px",textAlign:"
{Math.abs(gapEE) < 0.5 ? "●" : gapEE > 0 ? "▲" : "▼"} {Math.abs(gap
</span>
</span>
</div>;
})}
</div>
)}
{/* Tabela de ativos */}
<div style={{border:"1px solid rgba(255,255,255,0.05)",borderRadius:"8px",overf
<div style={{display:"grid",gridTemplateColumns:"minmax(0,1.8fr) minmax(0,0.9
<div>Ticker / Nome</div>
<div>Status / Subcl.</div>
<div style={{textAlign:"right"}} title="Preço médio do cliente, preço atual
<div style={{textAlign:"right"}} title="% atual na visão escolhida">Atual</
<div style={{textAlign:"right"}} title="% alvo na visão escolhida">Alvo</di
<div style={{textAlign:"right"}}>Gap</div>
</div>
{lista.length === 0 && <div style={{padding:"30px",textAlign:"center",color:"
{(function(){
function renderAsset(it) {
var hasTgt = it.tgEff > 0;
var gapClr = hasTgt ? gapColorLocal(it.gapEff) : "rgba(255,255,255,0.3)";
var statusBg = it.status === "core" ? "rgba(74,222,128,0.12)" : it.status
var statusClr = it.status === "core" ? "#4ade80" : it.status === "manter"
var statusLabels = {core:"Core",manter:"Manter",em_avaliacao:"Em aval.",r
return <div key={it.ticker} style={{display:"grid",gridTemplateColumns:"m
<div style={{minWidth:0}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9"}}>{it.tic
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",whiteSpace:
</div>
<div style={{display:"flex",flexDirection:"column",gap:"2px"}}>
{it.status && <span style={{fontSize:"8px",padding:"1px 5px",borderRa
{it.subclasse && <span style={{fontSize:"8px",color:"rgba(255,255,255
{it.forayCarteira && <span style={{fontSize:"8px",color:"#fb923c"}}>f
{it.noAlvo && it.valor === 0 && <span style={{fontSize:"8px",color:"#
</div>
<div style={{textAlign:"right",fontVariantNumeric:"tabular-nums",lineHe
{(function(){
var perf = calcPerformanceAtivo({classe:it._classe,preco:it._preco,
if (!perf) return <span style={{color:"rgba(255,255,255,0.2)",fontS
if (perf.unsupported) return <span style={{color:"rgba(255,255,255,
var pCor = perf.diffPct >= 0 ? "#4ade80" : "#f87171";
var sinal = perf.diffPct >= 0 ? "+" : "";
var tip = "Médio: " + fmtMoneyAuto(perf.precoMedio, perf.moeda)
+ " - Atual: " + fmtMoneyAuto(perf.precoAtual, perf.moeda)
+ " - L/P: " + sinal + fmtMoneyAuto(perf.diffFinanceiro, pe
+ (perf.fxNote ? " - " + perf.fxNote : "");
return <div title={tip}>
<div style={{color:"rgba(255,255,255,0.6)",fontSize:"9px"}}>
{fmtMoneyAuto(perf.precoMedio, perf.moeda)} {String.fromCharCod
</div>
<div style={{color:pCor,fontSize:"10px",fontWeight:700}}>
{sinal}{perf.diffPct.toFixed(1)}% {String.fromCharCode(183)} {s
</div>
</div>;
})()}
</div>
<div style={{textAlign:"right",fontSize:"11px",color:"rgba(255,255,255,
<div style={{textAlign:"right",fontSize:"11px",color:"rgba(255,255,255,
<div style={{textAlign:"right",fontSize:"11px",color:gapClr,fontVariant
{hasTgt ? ((Math.abs(it.gapEff) < 0.5 ? "● " : it.gapEff > 0 ? "▲ " :
</div>
</div>;
}
// Se for RF, agrupa por indexador; senão lista linear
if (classe === "renda_fixa") {
var ordemIx = ["pos_fixado","ipca","prefixado","fundo_rf","indefinido"];
var porIx = {};
lista.forEach(function(it){
var ix = it.subclasse || "indefinido";
if (!porIx[ix]) porIx[ix] = [];
porIx[ix].push(it);
});
Object.keys(porIx).forEach(function(ix){
porIx[ix].sort(function(a,b){ return (b.valor || 0) - (a.valor || 0); }
});
return ordemIx.filter(function(ix){ return porIx[ix] && porIx[ix].length
var grupo = porIx[ix];
var labelIx = ix === "indefinido" ? "Sem classificação" : (INDEXADOR_LA
return <div key={ix}>
<div style={{padding:"8px 12px",background:"rgba(59,130,246,0.06)",bo
<span style={{fontSize:"9px",fontWeight:700,color:"#60a5fa",textTra
<span style={{fontSize:"9px",color:"rgba(255,255,255,0.4)"}}>{grupo
</div>
{grupo.map(renderAsset)}
</div>;
});
} else {
return lista.map(renderAsset);
}
})()}
</div>
{/* Rodapé: totais */}
<div style={{marginTop:"12px",padding:"10px 14px",background:"rgba(0,0,0,0.3)",
<span>Total {classLabel}: <b style={{color:"#f1f5f9"}}>R$ {totalClasse.toLoca
<span>% da carteira: <b style={{color:"#f1f5f9"}}>{totalPatr > 0 ? ((totalCla
</div>
</div>
</div>
);
})()}
{/* Modal de visualização/edição do snapshot */}
{showSnapshotViewer && latestAtualSnap && (
<SnapshotViewerModal
snapshot={latestAtualSnap}
target={resolvedTarget}
isLatestAtual={true}
onClose={function(){ setShowSnapshotViewer(false); }}
onSaved={function(){
// Refaz o fetch do snapshot pra pegar as edições salvas
if (!editingProfile || !editingProfile.id) return;
supabase.from("client_snapshots").select("*").eq("client_profile_id", editingProf
if (res.error || !res.data) return;
var atuais = res.data.filter(function(s){return s.tipo==="atual";}).sort(functi
var alvo = res.data.find(function(s){return s.tipo==="alvo";});
setLatestAtualSnap(atuais[0] || null);
setSavedAlvoSnap(alvo || null);
});
}}
/>
)}
</div>)}
{/* ═══════════════════════════════════════════════════════════ */}
{/* ETAPA 2 — ORDENS */}
{/* ═══════════════════════════════════════════════════════════ */}
{step === "ordens" && (<div style={{maxHeight:"75vh",overflowY:"auto",position:"relative"
{/* ═══ FAIXA STICKY DE ALOCAÇÃO (sempre visível) ═══ */}
<div style={{position:"sticky",top:0,zIndex:10,background:"#0a0a0a",padding:"10px 12px"
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin
<div style={{fontSize:"9px",fontWeight:700,color:"#a78bfa",textTransform:"uppercase
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.35)",display:"flex",gap:"10px
<span><b style={{color:"rgba(255,255,255,0.6)"}}>ATUAL</b> hoje</span>
<span style={{color:"rgba(255,255,255,0.2)"}}>·</span>
<span><b style={{color:"#a78bfa"}}>PROJ.</b> após ordens</span>
<span style={{color:"rgba(255,255,255,0.2)"}}>·</span>
<span><b style={{color:"rgba(255,255,255,0.5)"}}>ALVO</b> JB</span>
<span style={{color:"rgba(255,255,255,0.2)",marginLeft:"8px"}}>Snapshot {latestAt
</div>
</div>
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))
{gapsByClass.map(function(g){
var hasTgt = g.tgPct > 0;
var projPct = projecaoByClass[g.cls] || 0;
var clr = gapColor(g.absGap, hasTgt);
var projGap = hasTgt ? Math.abs(projPct - g.tgPct) : 0;
var projClr = gapColor(projGap, hasTgt);
var moved = Math.abs(projPct - g.atPct) > 0.05;
var classClr = g.cls==="renda_fixa" ? "#3b82f6" : g.cls==="acoes_br" ? "#dc2626"
return <div key={g.cls} style={{background:"rgba(255,255,255,0.02)",padding:"7px
<div style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"3px"}}>
<span style={{width:"6px",height:"6px",borderRadius:"2px",background:classClr
<span style={{fontSize:"10px",fontWeight:600,color:"#f1f5f9"}}>{CLASS_LABELS_
</div>
{/* Header de colunas */}
<div style={{display:"flex",justifyContent:"space-between",fontSize:"7.5px",fon
<span title="Como está hoje">ATUAL</span>
<span title="Como fica se as ordens forem executadas">PROJ.</span>
<span title="Meta de alocação definida no Journey Book">ALVO</span>
</div>
<div style={{display:"flex",justifyContent:"space-between",fontSize:"10px",font
<span style={{color:"rgba(255,255,255,0.85)"}} title="% atual da carteira hoj
<span style={{color:moved?"#a78bfa":"rgba(255,255,255,0.25)",fontWeight:moved
<span style={{color:"rgba(255,255,255,0.4)"}} title="% alvo do JB">{hasTgt?g.
</div>
{hasTgt && <div style={{marginTop:"3px",height:"2px",background:"rgba(255,255,2
<div style={{position:"absolute",left:0,top:0,height:"100%",width:Math.min(pr
</div>}
</div>;
})}
</div>
{/* Saldo */}
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddin
<div style={{display:"flex",gap:"14px",flexWrap:"wrap"}}>
<span><span style={{color:"rgba(255,255,255,0.4)"}}>Disponível: </span><span styl
<span><span style={{color:"rgba(255,255,255,0.4)"}}>Alocado: </span><span style={
{totalVendas > 0 && <span><span style={{color:"rgba(255,255,255,0.4)"}}>Vendas: <
</div>
<span style={{fontWeight:700,fontVariantNumeric:"tabular-nums",color:saldoRestante<
</div>
{saldoRestante < -1 && <div style={{fontSize:"10px",color:"#f87171",marginTop:"4px"}}
</div>
{/* ═══ SUGESTÕES DO SISTEMA (não adicionadas ainda) ═══ */}
{(function(){
var pendSugestoes = [];
sugestoes.reducao.forEach(function(a){
var tk = a.ticker || a.nome_original;
if (tk && !allocations[tk] && !ignoredSuggestions[tk]) pendSugestoes.push({a:a, tip
});
sugestoes.em_avaliacao.forEach(function(a){
var tk = a.ticker || a.nome_original;
if (tk && !allocations[tk] && !ignoredSuggestions[tk]) pendSugestoes.push({a:a, tip
});
sugestoes.fora_carteira.forEach(function(a){
var tk = a.ticker || a.nome_original;
if (tk && !allocations[tk] && !ignoredSuggestions[tk]) pendSugestoes.push({a:a, tip
});
if (pendSugestoes.length === 0) return null;
return <div style={{background:"rgba(251,191,36,0.04)",border:"1px solid rgba(251,191
<div style={{fontSize:"10px",fontWeight:700,color:"#fbbf24",textTransform:"uppercas
<div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
{pendSugestoes.map(function(s,i){
var a = s.a;
var labelTipo = s.tipo === "reducao" ? "Em redução" : s.tipo === "em_avaliacao"
var corTipo = s.tipo === "reducao" ? "#f87171" : s.tipo === "em_avaliacao" ? "#
return <div key={s.tk+i} style={{display:"flex",justifyContent:"space-between",
<div style={{flex:1,minWidth:0}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9"}}>{s.tk}</div>
<div style={{fontSize:"9px",color:corTipo,marginTop:"1px"}}>{labelTipo} · {
</div>
<div style={{display:"flex",gap:"4px"}}>
<button
onClick={function(){
// Pré-preenche com o valor que o cliente tem em carteira, independente
// de sugestão — o consultor edita depois se quiser vender só parte.
addVendaOrdem(s.tk, a, a.valor || 0);
}}
style={{padding:"5px 9px",fontSize:"10px",fontWeight:700,borderRadius:"5p
>Adicionar venda</button>
<button
onClick={function(){
setIgnoredSuggestions(function(prev){ var n = Object.assign({}, prev);
}}
style={{padding:"5px 9px",fontSize:"10px",fontWeight:500,borderRadius:"5p
>Ignorar</button>
</div>
</div>;
})}
</div>
</div>;
})()}
{/* ═══ VENDAS ADICIONADAS ═══ */}
{(function(){
var vendasKeys = Object.keys(allocations).filter(function(tk){ return allocations[tk]
return <div style={{marginBottom:"14px"}}>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",ma
<div style={{fontSize:"10px",fontWeight:700,color:"#f87171",textTransform:"upperc
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",fontVariantNumeric:"ta
</div>
{vendasKeys.length === 0 && <div style={{fontSize:"10px",color:"rgba(255,255,255,0.
{vendasKeys.map(function(tk){
var al = allocations[tk];
var isEditing = editingOrderTicker === tk;
var posAtual = al._posAtual || 0;
var pctDaPosicao = posAtual > 0 ? ((al.value || 0) / posAtual) * 100 : 0;
return <div key={tk} style={{display:"flex",justifyContent:"space-between",alignI
<div style={{flex:1,minWidth:0}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9"}}>{tk} <span styl
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",marginTop:"1px"}}>P
</div>
<div style={{display:"flex",alignItems:"center",gap:"6px"}}>
{isEditing ? (
<input
autoFocus
value={al.value || ""}
onChange={function(e){ var v = parseBRL(e.target.value); updateOrdemValue
onBlur={function(){ setEditingOrderTicker(null); }}
onKeyDown={function(e){ if (e.key === "Enter") setEditingOrderTicker(null
style={{width:"110px",padding:"5px 8px",fontSize:"11px",borderRadius:"5px
/>
) : (
<button
onClick={function(){ setEditingOrderTicker(tk); }}
style={{padding:"5px 9px",fontSize:"11px",fontWeight:700,borderRadius:"5p
>R$ {(al.value || 0).toLocaleString("pt-BR",{maximumFractionDigits:0})}</bu
)}
<button
onClick={function(){ removeOrdem(tk); }}
style={{padding:"5px 8px",fontSize:"11px",borderRadius:"5px",border:"1px so
title="Remover"
>×</button>
</div>
</div>;
})}
<button
onClick={function(){
setShowAddSellModal(true);
setAddSellTicker(""); setAddSellSearch(""); setAddSellValue(""); setAddSellValu
}}
style={{width:"100%",padding:"8px",fontSize:"11px",fontWeight:700,borderRadius:"6
>+ Adicionar venda</button>
</div>;
})()}
{/* ═══ COMPRAS ADICIONADAS ═══ */}
{(function(){
var comprasKeys = Object.keys(allocations).filter(function(tk){ return !allocations[t
return <div style={{marginBottom:"14px"}}>
<div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",ma
<div style={{fontSize:"10px",fontWeight:700,color:"#60a5fa",textTransform:"upperc
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",fontVariantNumeric:"ta
</div>
{comprasKeys.length === 0 && <div style={{fontSize:"10px",color:"rgba(255,255,255,0
{comprasKeys.map(function(tk){
var al = allocations[tk];
var isEditing = editingOrderTicker === tk;
var clsLabel = CLASS_LABELS_V2[al._classe] || al._classe || "";
var badge = al._carteira ? al._carteira : clsLabel;
return <div key={tk} style={{display:"flex",justifyContent:"space-between",alignI
<div style={{flex:1,minWidth:0}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9"}}>{tk} <span styl
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",marginTop:"1px"}}>{
</div>
<div style={{display:"flex",alignItems:"center",gap:"6px"}}>
{isEditing ? (
<input
autoFocus
value={al.value || ""}
onChange={function(e){ var v = parseBRL(e.target.value); updateOrdemValue
onBlur={function(){ setEditingOrderTicker(null); }}
onKeyDown={function(e){ if (e.key === "Enter") setEditingOrderTicker(null
style={{width:"110px",padding:"5px 8px",fontSize:"11px",borderRadius:"5px
/>
) : (
<button
onClick={function(){ setEditingOrderTicker(tk); }}
style={{padding:"5px 9px",fontSize:"11px",fontWeight:700,borderRadius:"5p
>R$ {(al.value || 0).toLocaleString("pt-BR",{maximumFractionDigits:0})}</bu
)}
<button
onClick={function(){ removeOrdem(tk); }}
style={{padding:"5px 8px",fontSize:"11px",borderRadius:"5px",border:"1px so
title="Remover"
>×</button>
</div>
</div>;
})}
<button
onClick={function(){
setShowAddBuyModal(true);
setAddBuyStep("class");
setAddBuyClass(""); setAddBuyCarteira(""); setAddBuyTicker(""); setAddBuyTicker
}}
style={{width:"100%",padding:"8px",fontSize:"11px",fontWeight:700,borderRadius:"6
>+ Adicionar compra</button>
</div>;
})()}
{/* Botões de navegação */}
<div style={{display:"flex",justifyContent:"space-between",marginTop:"20px",paddingTop:
<div style={{display:"flex",gap:"6px"}}>
<button onClick={function(){ setStep("estado"); }} style={Object.assign({},btnBaseV
{Object.keys(allocations).length > 0 && (
<button
onClick={function(){
if (window.confirm("Limpar todas as ordens deste ciclo?")) {
setAllocations({});
setIgnoredSuggestions({});
}
}}
style={Object.assign({},btnBaseV2,{background:"transparent",border:"1px solid r
>Limpar ordens</button>
)}
</div>
<button
onClick={function(){ setStep("pdfs"); }}
disabled={Object.keys(allocations).length === 0}
style={Object.assign({},btnBaseV2,{background:Object.keys(allocations).length>0?"#D
>Gerar PDFs →</button>
</div>
{/* ═══ MODAL: Adicionar compra ═══ */}
{showAddBuyModal && (
<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:100,displa
<div style={{background:"#141414",border:"1px solid rgba(255,255,255,0.1)",borderRa
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",ma
<div style={{fontSize:"13px",fontWeight:700,color:"#f1f5f9"}}>Adicionar compra<
<button onClick={function(){ setShowAddBuyModal(false); }} style={{background:"
</div>
{/* Passo 1: Classe */}
{addBuyStep === "class" && (<div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginBottom:"10px"}
<div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
{[
ou Sma
{k:"acoes_br", l:"Ações BR", d:"Das carteiras Suno Dividendos, Valor {k:"fiis", l:"FIIs", d:"Da carteira Suno de FIIs"},
{k:"internacional", l:"Internacional", d:"Das carteiras Suno internacionais
{k:"alternativos", l:"Alternativos", d:"Ativos alternativos (input livre)"}
{k:"renda_fixa", l:"Renda Fixa", d:"CDB, LCA, LCI, Tesouro direto, etc."},
].map(function(c){
return <button key={c.k} onClick={function(){
setAddBuyClass(c.k);
if (c.k === "renda_fixa") setAddBuyStep("rf");
else if (c.k === "alternativos") setAddBuyStep("ticker");
else setAddBuyStep("carteira");
}} style={{textAlign:"left",padding:"10px 12px",borderRadius:"6px",border:"
<div style={{fontSize:"12px",fontWeight:700}}>{c.l}</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginTop:"2px
</button>;
})}
</div>
</div>)}
{/* Passo 2a: Carteira (se RV) */}
{addBuyStep === "carteira" && (<div>
<button onClick={function(){ setAddBuyStep("class"); }} style={{background:"tra
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginBottom:"10px"}
<div style={{display:"flex",flexDirection:"column",gap:"6px"}}>
{(function(){
var opts = [];
if (addBuyClass === "acoes_br") opts = [
{k:"Dividendos", l:"Dividendos"},
{k:"Valor", l:"Valor"},
{k:"Small Caps", l:"Small Caps"},
{k:"outro", l:"Outro ativo fora da carteira Suno"},
];
else if (addBuyClass === "internacional") {
var subs = getSubCarteirasInternacional();
opts = subs.map(function(s){ return {k:s, l:s}; });
opts.push({k:"outro", l:"Outro ativo fora das carteiras Suno"});
}
else if (addBuyClass === "fiis") opts = [
{k:"FIIs", l:"Carteira Suno de FIIs"},
{k:"outro", l:"Outro FII"},
];
return opts.map(function(o){
return <button key={o.k} onClick={function(){
setAddBuyCarteira(o.k);
setAddBuyStep("ticker");
}} style={{textAlign:"left",padding:"10px 12px",borderRadius:"6px",border
});
})()}
</div>
</div>)}
{/* Passo 2b: RF livre */}
{addBuyStep === "rf" && (<div>
<button onClick={function(){ setAddBuyStep("class"); }} style={{background:"tra
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginBottom:"10px"}
<label style={lS}>Indexador</label>
<select value={addBuyRFIndex} onChange={function(e){ setAddBuyRFIndex(e.target.
<option value="" style={{background:"#1a1a1a",color:"#f1f5f9"}}>Escolher…</op
<option value="pos_fixado" style={{background:"#1a1a1a",color:"#f1f5f9"}}>Pós
<option value="ipca" style={{background:"#1a1a1a",color:"#f1f5f9"}}>IPCA+</op
<option value="prefixado" style={{background:"#1a1a1a",color:"#f1f5f9"}}>Pref
<option value="fundo_rf" style={{background:"#1a1a1a",color:"#f1f5f9"}}>Fundo
</select>
<label style={lS}>Nome do produto</label>
<input value={addBuyRFName} onChange={function(e){ setAddBuyRFName(e.target.val
<label style={lS}>Valor a comprar (R$)</label>
<input value={addBuyValue?("R$ "+formatBRL(addBuyValue)):""} onChange={function
<button
onClick={function(){
if (!addBuyRFIndex || !addBuyRFName || !addBuyValue || Number(addBuyValue)
// Para RF, usa um pseudo-ticker único
var pseudoTicker = "RF_" + Date.now();
addCompraOrdem(pseudoTicker, {
value: Number(addBuyValue),
classe: "renda_fixa",
subclasse: addBuyRFIndex,
nome: addBuyRFName,
carteira: "Renda Fixa",
rfProduct: addBuyRFName,
source: "manual_rf",
});
setShowAddBuyModal(false);
}}
disabled={!addBuyRFIndex || !addBuyRFName || !addBuyValue || Number(addBuyVal
style={Object.assign({},btnBaseV2,{width:"100%",background:(addBuyRFIndex &&
>Adicionar ordem de RF</button>
</div>)}
{/* Passo 3: Ticker + Valor */}
{addBuyStep === "ticker" && (<div>
<button onClick={function(){
setAddBuyStep(addBuyClass === "alternativos" ? "class" : "carteira");
}} style={{background:"transparent",border:"none",color:"rgba(255,255,255,0.4)"
{addBuyCarteira === "outro" || addBuyClass === "alternativos" ? (<div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginBottom:"10px
<label style={lS}>Ticker</label>
<input
value={addBuyTicker}
onChange={function(e){ setAddBuyTicker(e.target.value.toUpperCase()); }}
placeholder="Ex: WEGE3, BBAS3, SMAL11..."
style={Object.assign({},iS,{marginBottom:"8px",textTransform:"uppercase"})}
/>
{(function(){
// Se o usuário digitou um BDR cuja stock subjacente está na carteira Suno,
// mostra um aviso — vai puxar a tese automaticamente.
var match = lookupStockWithBDR(addBuyTicker, allAppStocks);
if (!match || !match._isBDRMatch) return null;
return <div style={{padding:"7px 10px",background:"rgba(74,222,128,0.06)",b
✓ <b>{addBuyTicker}</b> é BDR de <b>{match._underlyingTicker}</b> ({match
</div>;
})()}
</div>) : (<div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginBottom:"10px
<b>{addBuyCarteira}</b> · {CLASS_LABELS_V2[addBuyClass]} · escolha o ticker
</div>
<input
value={addBuyTickerSearch}
onChange={function(e){ setAddBuyTickerSearch(e.target.value); }}
placeholder="Buscar ticker..."
style={Object.assign({},iS,{marginBottom:"6px"})}
/>
<div style={{maxHeight:"220px",overflowY:"auto",border:"1px solid rgba(255,25
{(function(){
var cands = getCandidatesByClassAndCarteira(addBuyClass, addBuyCarteira);
var q = addBuyTickerSearch.toLowerCase();
var filtered = q ? cands.filter(function(s){ return (s.ticker||"").toLowe
if (filtered.length === 0) return <div style={{padding:"14px",textAlign:"
return filtered.slice(0, 50).map(function(s){
var isSelected = addBuyTicker === s.ticker;
return <div key={s.ticker} onClick={function(){ setAddBuyTicker(s.ticke
<div style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9"}}>{s.tick
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)"}}>{s.name |
</div>;
});
})()}
</div>
</div>)}
<label style={lS}>Valor a comprar (R$)</label>
<input value={addBuyValue?("R$ "+formatBRL(addBuyValue)):""} onChange={function
<button
onClick={function(){
if (!addBuyTicker || !addBuyValue || Number(addBuyValue) <= 0) return;
// Já existe? atualiza valor
if (allocations[addBuyTicker]) {
updateOrdemValue(addBuyTicker, (allocations[addBuyTicker].value || setShowAddBuyModal(false);
return;
0) + N
}
var name = addBuyTicker;
// Aceita BDR: se o ticker for BDR e a stock subjacente estiver nas carteir
// da Suno, herda o nome e promove pra source="suno" (tese Suno disponível)
var stock = lookupStockWithBDR(addBuyTicker, allAppStocks);
if (stock) name = stock.name || stock.companyName || addBuyTicker;
var isBDRWithSunoThesis = stock && stock._isBDRMatch;
var resolvedSource = addBuyCarteira === "outro"
? (isBDRWithSunoThesis ? "suno_bdr" : "manual_outro")
: "suno";
var resolvedCarteira = addBuyCarteira === "outro"
? (isBDRWithSunoThesis ? (stock._portfolio || "Internacional") : "Fora da
: (addBuyCarteira || "");
addCompraOrdem(addBuyTicker, {
value: Number(addBuyValue),
classe: addBuyClass,
nome: name,
carteira: resolvedCarteira,
source: resolvedSource,
bdrUnderlying: isBDRWithSunoThesis ? stock._underlyingTicker : null,
});
setShowAddBuyModal(false);
}}
disabled={!addBuyTicker || !addBuyValue || Number(addBuyValue) <= 0}
style={Object.assign({},btnBaseV2,{width:"100%",background:(addBuyTicker && a
>{allocations[addBuyTicker] ? "Somar ao existente" : "Adicionar compra"}</butto
</div>)}
</div>
</div>
)}
{/* ═══ MODAL: Adicionar venda ═══ */}
{showAddSellModal && (
<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:100,displa
<div style={{background:"#141414",border:"1px solid rgba(255,255,255,0.1)",borderRa
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",ma
<div style={{fontSize:"13px",fontWeight:700,color:"#f1f5f9"}}>Adicionar venda</
<button onClick={function(){ setShowAddSellModal(false); }} style={{background:
</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginBottom:"10px"}}>
<input
value={addSellSearch}
onChange={function(e){ setAddSellSearch(e.target.value); }}
placeholder="Buscar ticker ou nome..."
style={Object.assign({},iS,{marginBottom:"6px"})}
/>
{/* Lista de ativos do cliente */}
<div style={{maxHeight:"280px",overflowY:"auto",border:"1px solid rgba(255,255,25
{(function(){
var ativosCliente = (latestAtualSnap && latestAtualSnap.data && latestAtualSn
// Ordena por valor decrescente
var ordenados = ativosCliente.slice().sort(function(a,b){ return (b.valor||0)
// Remove ativos já com ordem
ordenados = ordenados.filter(function(a){
var tk = a.ticker || a.nome_original;
return tk && !allocations[tk];
});
var q = addSellSearch.toLowerCase();
var filtered = q ? ordenados.filter(function(a){ return ((a.ticker||"").toLow
if (filtered.length === 0) return <div style={{padding:"14px",textAlign:"cent
return filtered.map(function(a){
var tk = a.ticker || a.nome_original;
var isSelected = addSellTicker === tk;
var classeLabel = CLASS_LABELS_V2[a.classe] || a.classe || "—";
return <div key={tk} onClick={function(){ setAddSellTicker(tk); }} style={{
<div style={{display:"flex",justifyContent:"space-between",alignItems:"ce
<div>
<div style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9"}}>{tk}</d
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)"}}>{(a.nome_
</div>
<div style={{textAlign:"right",fontVariantNumeric:"tabular-nums"}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9"}}>R$ {(a.
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.3)"}}>{(a.pct_t
</div>
</div>
</div>;
});
})()}
</div>
{/* Valor (R$ ou % da posição) */}
{addSellTicker && (function(){
var ativosCliente = (latestAtualSnap && latestAtualSnap.data && latestAtualSnap
var ativo = ativosCliente.find(function(a){ return (a.ticker || a.nome_original
var posicaoAtual = ativo ? (ativo.valor || 0) : 0;
return <div>
<label style={lS}>Valor a vender</label>
<div style={{display:"flex",gap:"6px",marginBottom:"6px"}}>
<button onClick={function(){ setAddSellValueMode("rs"); }} style={{flex:1,p
<button onClick={function(){ setAddSellValueMode("pct"); }} style={{flex:1,
</div>
{addSellValueMode === "rs" ? (
<input value={addSellValue?("R$ "+formatBRL(addSellValue)):""} onChange={fu
var v = parseBRL(e.target.value);
if (v > posicaoAtual) v = posicaoAtual;
setAddSellValue(String(v));
}} placeholder={"Até R$ " + posicaoAtual.toLocaleString("pt-BR",{maximumFra
) : (
<div>
<input
type="number" min="0" max="100" step="0.5"
value={addSellValue && posicaoAtual > 0 ? (Number(addSellValue) / posic
onChange={function(e){
var pct = Math.min(100, Math.max(0, Number(e.target.value) || 0));
var rs = posicaoAtual * (pct / 100);
setAddSellValue(String(rs));
}}
placeholder="% da posição (0-100)"
style={Object.assign({},iS,{marginBottom:"4px"})}
/>
</div>
)}
{addSellValue && <div style={{fontSize:"10px",color:"#f87171",textAlign:"righ
<button
onClick={function(){
if (!addSellTicker || !addSellValue || Number(addSellValue) <= 0) return;
addVendaOrdem(addSellTicker, ativo, Number(addSellValue));
setShowAddSellModal(false);
}}
disabled={!addSellValue || Number(addSellValue) <= 0}
style={Object.assign({},btnBaseV2,{width:"100%",background:(addSellValue &&
>Adicionar venda</button>
</div>;
})()}
</div>
</div>
)}
</div>)}
{/* ═══════════════════════════════════════════════════════════ */}
{/* ETAPA 3 — PDFs */}
{/* ═══════════════════════════════════════════════════════════ */}
{step === "pdfs" && (<div>
{/* Resumo do ciclo */}
<div style={{background:"#0e0e0e",border:"1px solid rgba(255,255,255,0.05)",borderRadiu
<div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marg
<div style={{fontSize:"10px",fontWeight:700,color:"#a78bfa",textTransform:"uppercas
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)"}}>{editingProfile && edi
</div>
<div style={{display:"flex",gap:"14px",fontSize:"11px",fontVariantNumeric:"tabular-nu
<span><span style={{color:"rgba(255,255,255,0.4)"}}>Ordens: </span><b style={{color
<span><span style={{color:"rgba(255,255,255,0.4)"}}>Vendas: </span><b style={{color
<span><span style={{color:"rgba(255,255,255,0.4)"}}>Compras: </span><b style={{colo
</div>
</div>
{/* Card Consultivo (único) */}
<div style={{marginBottom:"16px"}}>
{/* ── CARD CONSULTIVO ── */}
<div style={{background:"linear-gradient(135deg, rgba(180,40,40,0.05), rgba(139,92,24
<div style={{fontSize:"10px",fontWeight:700,color:"#DC2626",textTransform:"uppercas
<div style={{fontSize:"13px",fontWeight:700,color:"#f1f5f9",marginBottom:"4px"}}>Re
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",lineHeight:1.5,marginBot
{/* Resumo das ordens */}
<div style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.04)"
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",textTransform:"uppercas
{Object.keys(allocations).length === 0 ? (
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)",textAlign:"center",p
) : (
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.55)",lineHeight:1.6}}>
<div>Compras: <b style={{color:"#4ade80"}}>{Object.keys(allocations).filter(f
</div>
)}
</div>
{/* Botão Revisar e gerar PDF */}
<button
onClick={async function(){
// Cópia editável de allocations
var allocCopy = {};
Object.keys(allocations).forEach(function(tk){
allocCopy[tk] = Object.assign({}, allocations[tk]);
});
setIaReviewAllocations(allocCopy);
setIaReviewEdits({});
setIaReviewComprasObs("");
setIaReviewVendasObs("");
setIaReviewQuotesLoading(true);
setShowIaReview(true);
try {
var quotes = await fetchLiveQuotes();
setIaReviewQuotes(quotes || {});
} catch(e) {
console.warn("Falha ao buscar cotações pra revisão:", e);
setIaReviewQuotes({});
}
setIaReviewQuotesLoading(false);
}}
disabled={Object.keys(allocations).length === 0 || pdfConsultivoGerando}
style={Object.assign({},btnBaseV2,{width:"100%",background:Object.keys(allocation
>{pdfConsultivoGerando ? "Gerando PDF..." : " Revisar e gerar PDF"}</button>
</div>
</div>
{/* ═══ MODAL: Revisão das ordens antes de baixar o PDF Consultivo ═══ */}
{showIaReview && (
<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",zIndex:2200,displ
<div style={{background:"#0a0a0a",border:"1px solid rgba(255,255,255,0.08)",borderR
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",ma
<div>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>Revisar ordens do
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginTop:"3px"}}>
</div>
<button onClick={function(){ setShowIaReview(false); }} style={{background:"tra
</div>
{/* Aviso legal sobre o IR estimado */}
<div style={{background:"rgba(251,191,36,0.05)",border:"1px solid rgba(251,191,36
<b>⚠ IR estimado é uma referência, não cálculo definitivo.</b> Considera regras
</div>
{iaReviewQuotesLoading && <div style={{textAlign:"center",padding:"30px",color:"r
{!iaReviewQuotesLoading && (function(){
// Helpers locais
function curSym(c){ return c==="USD"?"US$":c==="EUR"?"\u20ac":c==="GBP"?"\u00a3
function fmtN(v){ if (v == null || isNaN(v)) return "—"; var s=Math.abs(v).toFi
function fmtMoneyLocal(v, c){ return curSym(c)+" "+fmtN(v); }
var stockMap = {};
allAppStocks.forEach(function(s){ if (s.ticker) stockMap[s.ticker] = s; });
// Mapa ticker → posição atual do cliente (do snapshot Gorila/MyProfit).
// Usado pra mostrar preço médio + L/P estimado em cada ordem.
var posClienteMap = {};
if (latestAtualSnap && latestAtualSnap.data && Array.isArray(latestAtualSnap.da
latestAtualSnap.data.ativos.forEach(function(a){
if (!a) return;
var key = (a.ticker || a.nome_original || "").toString().toUpperCase();
if (!key) return;
posClienteMap[key] = a;
});
}
// Computa linhas com preço, câmbio, qty derivados
function computeRow(tk) {
var al = iaReviewAllocations[tk] || {};
var stock = stockMap[tk];
var portfolio = stock ? stock._portfolio : null;
var currency = detectCurrencyFromTicker(tk, portfolio, al._classe);
var q = iaReviewQuotes[tk.toUpperCase()] || {};
var edit = iaReviewEdits[tk.toUpperCase()] || {};
// Preço original (na moeda nativa do ativo)
var priceOrig = edit.priceOrig != null ? edit.priceOrig : (q.priceOrig // FX (1 se BRL)
var fx = edit.fx != null ? edit.fx : (currency === "BRL" ? 1 : (q.fx > // Valor BRL — pode ser editado diretamente OU vir do allocation
var valueBRL = edit.value != null ? edit.value : (Math.abs(al.value) || 0);
// Quantidade — derivada por padrão (valueBRL / priceBRL), mas pode ser edita
var priceBRL = currency === "BRL" ? priceOrig : (priceOrig * fx);
var qty = edit.qty != null ? edit.qty : (priceBRL > 0 ? Math.floor(valueBRL /
var totalOrig = currency === "BRL" ? valueBRL : (fx > 0 ? valueBRL / fx : 0);
> 0 ?
0 ? q.
var isRF = (al._classe || "").indexOf("renda_fixa") >= 0 || tk.indexOf("RF_")
var isGeneratedId = /^(RF_|rf:|alt:)/i.test(tk) || tk.length > 12;
var displayName = isGeneratedId && al._nome ? al._nome : tk;
// Posição atual do cliente (se já tem o ativo) - usado pra L/P e IR
var posCliente = posClienteMap[tk.toUpperCase()] || null;
return {
tk: tk, al: al, currency: currency, isRF: isRF, displayName: displayName,
priceOrig: priceOrig, fx: fx, qty: qty, valueBRL: valueBRL, totalOrig: tota
isSell: al.type === "sell",
posCliente: posCliente // {preco_medio, preco, quantidade, classe, nome_or
};
}
var allRows = Object.keys(iaReviewAllocations).map(computeRow).filter(function(
var comprasRows = allRows.filter(function(r){return !r.isSell;}).sort(function(
var vendasRows = allRows.filter(function(r){return r.isSell;}).sort(function(a
// Atualiza um campo editado e recalcula derivados
function updateField(tk, field, valor) {
var num = Number(valor);
if (isNaN(num)) num = 0;
var next = Object.assign({}, iaReviewEdits);
next[tk.toUpperCase()] = Object.assign({}, next[tk.toUpperCase()] || {});
var stock = stockMap[tk];
var portfolio = stock ? stock._portfolio : null;
var currency = detectCurrencyFromTicker(tk, portfolio, (iaReviewAllocations[t
if (field === "priceOrig") {
next[tk.toUpperCase()].priceOrig = num;
// Recalcula qty mantendo valueBRL OU recalcula valueBRL mantendo qty?
// Comportamento: se editou preço, mantém valor BRL e recalcula qty
// (consultor está dizendo "mudou o preço, ajusta a quantidade")
// — não fazer nada extra: a recomputação automática faz isso
} else if (field === "fx") {
next[tk.toUpperCase()].fx = num;
// Mantém valor BRL, recalcula qty automático
} else if (field === "qty") {
next[tk.toUpperCase()].qty = Math.floor(num);
// Recalcula valueBRL = qty * priceBRL
var priceOrig = next[tk.toUpperCase()].priceOrig != null ? next[tk.toUpperC
var fx = next[tk.toUpperCase()].fx != null ? next[tk.toUpperCase()].fx : (c
var priceBRL = currency === "BRL" ? priceOrig : (priceOrig * fx);
next[tk.toUpperCase()].value = Math.floor(num) * priceBRL;
} else if (field === "value") {
next[tk.toUpperCase()].value = num;
// Recalcula qty (automático na renderização)
delete next[tk.toUpperCase()].qty; // limpa qty manual pra recalcular
}
setIaReviewEdits(next);
// Atualiza também o iaReviewAllocations.value se for value editado
if (field === "value" || field === "qty") {
var nextAlloc = Object.assign({}, iaReviewAllocations);
var newValue = field === "value" ? num : (next[tk.toUpperCase()].value || 0
nextAlloc[tk] = Object.assign({}, nextAlloc[tk], { value: newValue });
setIaReviewAllocations(nextAlloc);
}
}
function totaisPorMoeda(rows) {
var t = {};
rows.forEach(function(r){
if (!t[r.currency]) t[r.currency] = { brl: 0, orig: 0 };
t[r.currency].brl += r.valueBRL;
t[r.currency].orig += r.totalOrig;
});
return t;
}
var totCompras = totaisPorMoeda(comprasRows);
var totVendas = totaisPorMoeda(vendasRows);
function renderTabela(titulo, rows, cor, totais, obsValue, setObsValue) {
if (rows.length === 0 && Object.keys(totais).length === 0) {
return <div style={{marginBottom:"14px"}}>
<div style={{fontSize:"11px",fontWeight:800,color:cor,textTransform:"uppe
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)",fontStyle:"ita
</div>;
}
return <div style={{marginBottom:"14px"}}>
<div style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"6px
<span style={{fontSize:"11px",fontWeight:800,color:cor,textTransform:"upp
<span style={{fontSize:"9px",color:"rgba(255,255,255,0.3)"}}>({rows.lengt
</div>
<div style={{background:"rgba(255,255,255,0.015)",border:"1px solid rgba(25
{/* Cabeçalho */}
<div style={{display:"grid",gridTemplateColumns:"60px 1fr 60px 110px 90px
<span>Ticker</span><span>Nome</span><span>Moeda</span><span style={{tex
</div>
{rows.map(function(r){
var displayTicker = r.tk.indexOf("RF_") === 0 ? "RF" : r.tk;
var inputStyle = {width:"100%",padding:"4px 6px",borderRadius:"4px",bor
// ─── Calcula performance da posição atual do cliente (preço médio vs
// Usado tanto pra vendas (mostrar L/P realizado na venda) quanto pra c
// que aumentam posição existente (mostrar quanto a posição está valori
var perfPos = null;
if (r.posCliente) {
perfPos = calcPerformanceAtivo({
classe: r.posCliente.classe,
preco: r.posCliente.preco,
preco_medio: r.posCliente.preco_medio,
quantidade: r.posCliente.quantidade
}, fxUsdBrl);
}
// ─── Calcula L/P proporcional à venda e IR estimado (só para vendas)
var perfVenda = null;
var irEst = null;
if (r.isSell && r.posCliente && perfPos && !perfPos.unsupported) {
// Preço médio em moeda original (USD pra internacional, BRL pra rest
var pmCli = perfPos.precoMedio;
var qtdVenda = r.qty; // quantidade vendida agora
// Receita da venda na moeda original
var receitaOrig = r.totalOrig;
// Custo da venda = pmCli × qtdVenda (na moeda original)
var custoVendaOrig = pmCli * qtdVenda;
var ganhoOrig = receitaOrig - custoVendaOrig;
var pctVenda = custoVendaOrig > 0 ? (ganhoOrig / custoVendaOrig) * 10
perfVenda = {
moeda: perfPos.moeda,
ganho: ganhoOrig,
pct: pctVenda,
receitaBrl: r.valueBRL,
custoBrl: perfPos.moeda === "USD" && fxUsdBrl ? custoVendaOrig * fx
};
// IR estimado
irEst = calcEstimativaIR({
ticker: r.tk,
nome: r.posCliente.nome_original || r.displayName,
classe: r.posCliente.classe,
vendaBRL: r.valueBRL,
ganhoBRL: perfPos.moeda === "BRL" ? ganhoOrig : (fxUsdBrl ? ganhoOr
ganhoUSD: perfPos.moeda === "USD" ? ganhoOrig : null,
vendaUSD: perfPos.moeda === "USD" ? receitaOrig : null
});
}
return <Fragment key={r.tk}>
<div style={{display:"grid",gridTemplateColumns:"60px 1fr 60px 110px
<span style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9",overfl
<span style={{fontSize:"10px",color:"rgba(255,255,255,0.55)",overfl
<span style={{fontSize:"10px",color:"rgba(255,255,255,0.45)",fontWe
<input
type="number"
step="0.01"
value={r.priceOrig.toFixed(2)}
onChange={function(e){ updateField(r.tk, "priceOrig", e.target.va
title={"Preço atual em " + r.currency + " (" + curSym(r.currency)
style={inputStyle}
disabled={r.isRF}
/>
{r.currency !== "BRL" ? (
<input
type="number"
step="0.0001"
value={r.fx.toFixed(4)}
onChange={function(e){ updateField(r.tk, "fx", e.target.value);
title={"Câmbio " + r.currency + " - BRL"}
style={inputStyle}
/>
) : (
<span style={{fontSize:"10px",color:"rgba(255,255,255,0.3)",textA
)}
<input
type="number"
step="1"
value={r.qty}
onChange={function(e){ updateField(r.tk, "qty", e.target.value);
style={inputStyle}
disabled={r.isRF}
/>
<input
type="number"
step="0.01"
value={r.valueBRL.toFixed(2)}
onChange={function(e){ updateField(r.tk, "value", e.target.value)
style={inputStyle}
/>
</div>
{/* ─── Sub-linha: posição cliente, L/P e IR estimado ─── */}
{(perfPos || perfVenda) && (
<div style={{padding:"3px 10px 7px 10px",borderTop:"1px dashed rgba
{/* Pos. cliente */}
{perfPos && !perfPos.unsupported && (
<span style={{color:"rgba(255,255,255,0.55)"}} title="Posição a
<b style={{color:"rgba(255,255,255,0.4)",textTransform:"upper
{r.posCliente.quantidade}x {fmtMoneyAuto(perfPos.precoMedio,
<span style={{color:perfPos.diffPct>=0?"#4ade80":"#f87171",fo
({perfPos.diffPct>=0?"+":""}{perfPos.diffPct.toFixed(1)}%)
</span>
</span>
)}
{/* L/P realizado na venda */}
{r.isSell && perfVenda && (
<span style={{color:"rgba(255,255,255,0.55)"}} title="Lucro ou
<b style={{color:"rgba(255,255,255,0.4)",textTransform:"upper
<span style={{color:perfVenda.ganho>=0?"#4ade80":"#f87171",fo
{perfVenda.ganho>=0?"+":""}{fmtMoneyAuto(perfVenda.ganho, p
</span>
</span>
)}
{/* IR estimado */}
{r.isSell && irEst && (
<span style={{color:"rgba(255,255,255,0.55)"}} title={(irEst.re
<b style={{color:"rgba(255,255,255,0.4)",textTransform:"upper
{irEst.aplicavel ? (
<span style={{color:"#fbbf24",fontWeight:700}}>
{fmtMoneyAuto(irEst.irDevido, irEst.moeda)} ({(irEst.aliq
</span>
) : (
<span style={{color:"#4ade80",fontWeight:700}}>Sem IR</span
)}
<span style={{color:"rgba(255,255,255,0.35)",marginLeft:"4px"
</span>
)}
</div>
)}
</Fragment>;
})}
{/* Totais por moeda */}
{Object.keys(totais).sort().map(function(cur){
var t = totais[cur];
return <div key={cur} style={{display:"grid",gridTemplateColumns:"60px
<span></span>
<span style={{fontSize:"10px",fontWeight:700,color:cor,textTransform:
<span></span>
<span></span>
<span></span>
<span style={{fontSize:"10px",fontWeight:700,color:cor,textAlign:"rig
<span style={{fontSize:"10px",fontWeight:700,color:cor,textAlign:"rig
</div>;
})}
</div>
{/* Comentário/observação */}
<textarea
value={obsValue}
onChange={function(e){ setObsValue(e.target.value); }}
placeholder={"Observações sobre as " + titulo.toLowerCase() + " (aparece
style={{width:"100%",minHeight:"50px",padding:"8px 10px",marginTop:"6px",
/>
</div>;
}
return <div>
{renderTabela("Compras", comprasRows, "#4ade80", totCompras, iaReviewComprasO
{renderTabela("Vendas", vendasRows, "#f87171", totVendas, iaReviewVendasOb
{/* Banner de aviso se há edições manuais */}
{Object.keys(iaReviewEdits).length > 0 && (
<div style={{background:"rgba(251,191,36,0.06)",border:"1px solid rgba(251,
✎ {Object.keys(iaReviewEdits).length} linha(s) com edição manual. Os valo
</div>
)}
</div>;
})()}
{/* Rodapé com ações */}
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",ga
<button
onClick={function(){
// Restaura: limpa todas as edições manuais
setIaReviewEdits({});
// Restaura allocations originais
var allocCopy = {};
Object.keys(allocations).forEach(function(tk){
allocCopy[tk] = Object.assign({}, allocations[tk]);
});
setIaReviewAllocations(allocCopy);
setIaReviewComprasObs("");
setIaReviewVendasObs("");
}}
style={Object.assign({},btnBaseV2,{background:"transparent",border:"1px solid
>↻ Restaurar valores originais</button>
<div style={{display:"flex",gap:"8px"}}>
<button onClick={function(){ setShowIaReview(false); }} style={Object.assign(
<button
onClick={async function(){
var allocationsToUse = Object.assign({}, iaReviewAllocations);
setAllocations(allocationsToUse);
setShowIaReview(false);
await generatePDFConsultivoV2({
allocationsOverride: allocationsToUse,
quotesOverride: iaReviewQuotes,
editsOverride: iaReviewEdits,
comprasObsOverride: iaReviewComprasObs,
vendasObsOverride: iaReviewVendasObs
});
}}
disabled={pdfConsultivoGerando || iaReviewQuotesLoading}
style={Object.assign({},btnBaseV2,{background:"#DC2626",color:"#fff",opacit
>{pdfConsultivoGerando ? "Gerando PDF..." : "\ud83d\udcc5 Baixar PDF"}</butto
</div>
</div>
</div>
</div>
)}
</div>
</div>)}
</div>;
<div style={{display:"flex",justifyContent:"flex-start"}}>
<button onClick={function(){ setStep("ordens"); }} style={Object.assign({},btnBaseV2,
}
// ─────────────────────────────────────────────────────────────
function ConsultiveReportModal(p) {
var [mainTab, setMainTab] = useState(CONSULT_TAB_STRATEGY);
var [consultorName, setConsultorName] = useState("Rafael Manfroi Radaelli");
// Profile completo do consultor logado (carregado do Supabase tabela "consultores")
// Usado pra popular automaticamente o PDF Suno oficial com foto, bio, links clicáveis etc.
var [consultorProfile, setConsultorProfile] = useState(null);
var [showConsultorEditor, setShowConsultorEditor] = useState(false);
// Carrega o perfil do consultor logado ao montar o modal
useEffect(function() {
(async function() {
try {
var uid = await getUserId();
if (!uid) return;
var res = await supabase.from("consultores").select("*").eq("id", uid).single();
if (res.data) {
setConsultorProfile(res.data);
// Sincroniza nome do consultor com display_name se houver
if (res.data.display_name) setConsultorName(res.data.display_name);
}
} catch (e) {
console.warn("[ConsultiveReportModal] falha ao carregar profile:", e);
}
})();
}, []);
var [period, setPeriod] = useState("");
var [error, setError] = useState("");
// Client profiles
var [clientProfiles, setClientProfiles] = useState(function(){return loadClientProfiles();}
var [selectedProfileId, setSelectedProfileId] = useState("");
var [editingProfile, setEditingProfile] = useState(null);
var [showProfileEditor, setShowProfileEditor] = useState(false);
// Collapse/expand das seções da aba Estratégia (preferência do usuário, default = expandid
var [estrategiaClienteCollapsed, setEstrategiaClienteCollapsed] = useState(false);
var [snapshotsPosicaoCollapsed, setSnapshotsPosicaoCollapsed] = useState(false);
var [timelineSnapshotsCollapsed, setTimelineSnapshotsCollapsed] = useState(false);
// Snapshot wizard
var [showSnapshotWizard, setShowSnapshotWizard] = useState(false);
var [snapshotsList, setSnapshotsList] = useState([]);
var [loadingSnapshots, setLoadingSnapshots] = useState(false);
// M3: snapshot viewer modal
var [viewingSnapshot, setViewingSnapshot] = useState(null);
// M4: editor de alvo
var [showTargetEditor, setShowTargetEditor] = useState(false);
// Strategy tab — JB
var [jbFile, setJbFile] = useState(null);
var [jbFileName, setJbFileName] = useState("");
var [jbParsing, setJbParsing] = useState(false);
// Recommendation tab
var [recStep, setRecStep] = useState("position");
var [posFile, setPosFile] = useState(null);
var [posFileName, setPosFileName] = useState("");
var [posAssets, setPosAssets] = useState([]);
var [availableCash, setAvailableCash] = useState("");
var [allocations, setAllocations] = useState({}); // {ticker: {value: R$, text: "", verdict
var [previewApproved, setPreviewApproved] = useState(false);
var [writingTone, setWritingTone] = useState("simples"); // simples, intermediario, profiss
// Modal de gap detalhado por ativo (aba Estratégia)
var [gapDetailClasseStg, setGapDetailClasseStg] = useState(null);
var [gapDetailModeStg, setGapDetailModeStg] = useState("carteira");
var [gapDetailSnapshotStg, setGapDetailSnapshotStg] = useState(null);
var [gapDetailTargetStg, setGapDetailTargetStg] = useState(null);
// Câmbio USD/BRL pra L/P de ativos internacionais. Cache global; fetch on mount.
var [fxUsdBrlStg, setFxUsdBrlStg] = useState(null);
useEffect(function(){
var aborted = false;
fetchUsdBrl().then(function(r){ if (!aborted && r) setFxUsdBrlStg(r); });
return function(){ aborted = true; };
}, []);
var posFileRef = useRef(null);
var [crossrefData, setCrossrefData] = useState(null);
var [selectedAssets, setSelectedAssets] = useState({});
var [sellAssets, setSellAssets] = useState({}); // {ticker: {value: R$, total: bool}}
var [quotesLoading, setQuotesLoading] = useState(false);
var [quotesUpdated, setQuotesUpdated] = useState(null);
var [generating, setGenerating] = useState(false);
var [genProgress, setGenProgress] = useState("");
var [analyses, setAnalyses] = useState({});
var [strategyText, setStrategyText] = useState("");
var [pdfGenerating, setPdfGenerating] = useState(false);
var [filterVies, setFilterVies] = useState("all");
var [filterCarteira, setFilterCarteira] = useState("all");
var [filterClasse, setFilterClasse] = useState("all");
var [filterSentiment, setFilterSentiment] = useState("all");
var [filterRank, setFilterRank] = useState("all");
var [filterMargem, setFilterMargem] = useState("all");
var fileRef = useRef(null);
// All app stocks (Pilar 1 — Inteligência)
var allAppStocks = [];
["Dividendos","Valor","Small Caps","Internacional"].forEach(function(port) {
(p.data[port] || []).forEach(function(s) {
allAppStocks.push(Object.assign({_portfolio: port}, s));
});
});
// Load Carteiras Suno data (Pilar 5)
var carteirasData = loadCarteiras();
// ── Profile functions ──
function selectProfile(id) {
setSelectedProfileId(id);
var found = clientProfiles.find(function(pr){return pr.id===id;});
if (found) {
setEditingProfile(Object.assign({}, found));
// Load saved position if available
if (found.posAssets && found.posAssets.length > 0) {
setPosAssets(found.posAssets);
setPosFileName(found.posFileName || "Posição salva");
} else {
setPosAssets([]);
setPosFileName("");
}
// Load snapshots from cloud for this client
loadSnapshotsForClient(found.id);
}
else { setEditingProfile(null); setPosAssets([]); setPosFileName(""); setSnapshotsList([]
setError("");
}
function loadSnapshotsForClient(clientId) {
if (!clientId) { setSnapshotsList([]); return; }
setLoadingSnapshots(true);
listClientSnapshots(clientId).then(async function(list){
list = list || [];
var profile = clientProfiles.find(function(pr){return pr.id===clientId;});
// ═══ MIGRAÇÃO RETROATIVA: jbData sintético pra clientes que importaram Asset Alloc ══
// Clientes que importaram Asset Alloc ANTES da lógica `buildJbDataFromAssetAlloc` exis
// ficaram com `assetAllocImportDate` mas sem `jbData`, travando abas Estratégia/Recome
// Reconstruímos `jbData` sintético usando:
// // - allocMacroAlvo/Atual: derivados de profile.allocation
- snapshotAtual: o snapshot real (pode estar como 'inicial' legacy ou como 'atual'
// - profileData: o próprio profile
if (profile && !profile.jbData) {
// Procura snapshot da posição real: primeiro 'atual' (correto), senão cai pro // (que pode ter sido salvo como 'inicial' por versões antigas do Asset Alloc).
var snapAtualRow = list.find(function(s){return s.tipo==="atual";});
if (!snapAtualRow) {
snapAtualRow = list.find(function(s){
return s.tipo==="inicial" && s.data && s.data.origem !== "jb_initial";
'inici
});
}
var hasMigrationData = !!profile.assetAllocImportDate || !!snapAtualRow;
if (hasMigrationData) {
try {
// Reverte profile.allocation (formato {"Renda Fixa": {target, current}, ...})
// pro formato que buildJbDataFromAssetAlloc espera ({renda_fixa, acoes_br, ...})
var REVERSE_ALLOC_MAP = {
"Renda Fixa": "renda_fixa",
"Ações BR": "acoes_br",
"FIIs": "fiis",
"Internacional": "internacional",
"Alternativos": "alternativos"
};
var allocMacroAlvo = {};
var allocMacroAtual = {};
var srcAlloc = profile.allocation || {};
Object.keys(REVERSE_ALLOC_MAP).forEach(function(label){
var k = REVERSE_ALLOC_MAP[label];
var entry = srcAlloc[label];
if (entry) {
if (typeof entry.target === "number") allocMacroAlvo[k] = entry.target;
if (typeof entry.current === "number") allocMacroAtual[k] = entry.current;
}
});
// referenceDate: prioriza data do snapshot (que é a data real da planilha),
// só cai pra assetAllocImportDate como último recurso.
var snapDateForRef = snapAtualRow && snapAtualRow.snapshot_date;
var refDate = snapDateForRef || profile.assetAllocImportDate || null;
var profileDataMin = {
name: profile.name,
age: profile.age,
profession: profile.profession,
riskProfile: profile.riskProfile,
totalWealth: profile.totalWealth,
monthlyIncome: profile.monthlyIncome,
monthlyExpenses: profile.monthlyExpenses,
monthlyContribution: profile.monthlyContribution,
horizon: profile.horizon,
desiredIncome: profile.desiredIncome,
retirementAge: profile.retirementAge,
referenceDate: refDate
};
var snapshotAtualForBuild = snapAtualRow ? snapAtualRow.data : null;
// NOTA: suggestedPortfolio fica vazio na migração retroativa porque a planilha
// Asset Alloc original não é armazenada — só snapshot + profile vão pro banco.
// Pra habilitar alvo por ativo neste cliente, consultor precisa reimportar o xls
// (botão "+ Adicionar Asset Alloc" na aba Estratégia do cliente).
var syntheticJb = buildJbDataFromAssetAlloc(profileDataMin, snapshotAtualForBuild
if (syntheticJb) {
var migratedProfile = Object.assign({}, profile, {
jbData: syntheticJb,
jbImportDate: refDate || new Date().toISOString().slice(0,10),
assetAllocImportDate: profile.assetAllocImportDate || refDate || new Date().t
updatedAt: new Date().toISOString().slice(0,10)
});
var newList = clientProfiles.slice();
var idxMig = newList.findIndex(function(pr){return pr.id===clientId;});
if (idxMig >= 0) newList[idxMig] = migratedProfile;
setClientProfiles(newList);
saveClientProfiles(newList);
if (editingProfile && editingProfile.id === clientId) setEditingProfile(migrate
// Atualiza a var `profile` local pra próximos blocos usarem já migrado.
profile = migratedProfile;
console.log("[migration] jbData sintético gerado retroativamente pro cliente "
}
} catch(err) {
console.warn("[migration] falha ao gerar jbData sintético retroativo:", err);
}
}
}
(ou nã
// ═══ MIGRAÇÃO DE TIPO (execução): se achou legacy inicial E jbData é sintético // // {
faz o delete do 'inicial' e insert como 'atual'. Isso é feito DEPOIS da migração
porque a migração lê o 'inicial' legacy pra reconstruir o jbData.
var profileHasRealJbNow = profile && profile.jbData && profile.jbData.origem !== "ass
if (!profileHasRealJbNow) {
var legacyInicialRow = list.find(function(s){
return s.tipo === "inicial" && s.data && s.data.origem !== "jb_initial";
});
if (legacyInicialRow) {
try {
// Insere como 'atual' antes de deletar o 'inicial' (safer: se crashar no meio,
var atualAlreadyExists = list.some(function(s){ return s.tipo === "atual"; });
if (!atualAlreadyExists) {
var reclassified = Object.assign({}, legacyInicialRow.data, { tipo: "atual" }
await saveClientSnapshot(clientId, "atual", reclassified);
}
await deleteClientSnapshot(legacyInicialRow.id);
list = await listClientSnapshots(clientId);
console.log("[migration] snapshot 'inicial' legacy reclassificado como 'atual'
} catch(err) {
console.warn("[migration] falha ao reclassificar snapshot legacy:", err);
}
}
}
}
// ═══ M4: garante que 'inicial' existe E veio de JB REAL ═══
// Cenário A: cliente tem JB real mas não tem inicial → cria
// Cenário B: cliente tem JB real e tem inicial, mas origem != 'jb_initial' (legacy) →
// IMPORTANTE: só roda pra JB REAL. Se jbData for sintético (origem 'asset_alloc_synthe
// o "inicial derivado do JB" seria uma duplicata da posição atual (o sintético é const
// a partir da foto atual da Asset Alloc, não de uma posição histórica separada).
if (profile && profile.jbData && profile.jbData.origem !== "asset_alloc_synthetic") {
var existingInicial = list.find(function(s){return s.tipo==="inicial";});
var needRegen = !existingInicial || (existingInicial.data && existingInicial.data.ori
if (needRegen) {
try {
await saveInicialFromJB(clientId, profile.jbData);
list = await listClientSnapshots(clientId);
console.log(existingInicial ? "[snapshot] inicial antigo substituído pelo JB" : "
} catch(err) {
console.warn("[snapshot] falha ao gerar inicial do JB:", err);
}
}
}
setSnapshotsList(list);
setLoadingSnapshots(false);
}).catch(function(err){
console.error("[snapshot] load list error:", err);
setSnapshotsList([]);
setLoadingSnapshots(false);
});
}
function saveProfileToList(profile) {
var list = clientProfiles.slice();
var idx = list.findIndex(function(pr){return pr.id===profile.id;});
if (idx >= 0) list[idx] = profile; else list.push(profile);
setClientProfiles(list); saveClientProfiles(list);
setEditingProfile(Object.assign({}, profile));
}
function createNewProfileInline() {
var np = makeEmptyProfile();
setSelectedProfileId(np.id); setEditingProfile(np); setShowProfileEditor(true);
}
// ── Journey Book parsing (saves to profile) ──
function handleJBUpload(e) {
var f = e.target.files[0]; if (!f) return;
setJbFileName(f.name); setJbFile(f); setError("");
}
async function parseJourneyBook() {
if (!jbFile || !editingProfile) return;
setJbParsing(true); setError("");
try {
var parsed = await parseJBPdfToJson(jbFile);
// Aplica JB ao profile (preservando dados já digitados — só preenche campos vazios)
var updated = applyJBToProfile(editingProfile, parsed, { overwriteExisting: false });
saveProfileToList(updated);
// Também gera/atualiza snapshot inicial e alvo
try { await saveInicialFromJB(editingProfile.id, parsed); } catch(e) { console.warn("sa
try { await saveAlvoFromJB(editingProfile.id, parsed); } catch(e) { console.warn("saveA
setJbFile(null); setJbFileName("");
} catch(err) { console.error(err); setError("Erro ao processar JB: " + err.message); }
setJbParsing(false);
}
function clearJB() {
if (!editingProfile || !confirm("Remover Journey Book salvo deste cliente?")) return;
var updated = Object.assign({}, editingProfile, {jbData: null, jbImportDate: null});
saveProfileToList(updated);
}
// ── Position upload ──
async function handlePosUpload(e) {
var f = e.target.files[0]; if (!f) return;
setPosFileName(f.name); setPosFile(f); setError("");
try {
var arrayBuf = await new Promise(function(res, rej) {
var r = new FileReader(); r.onload = function(){res(r.result);}; r.onerror = function
});
var wb = XLSX.read(arrayBuf, {type:"array"});
var ws = wb.Sheets[wb.SheetNames[0]];
var allRows = XLSX.utils.sheet_to_json(ws, {header:1, defval:""});
if (allRows.length === 0) { setError("Planilha vazia"); return; }
// Find the header row (look for "Ativo" or "Ticker" or "Posição" in any row)
var headerIdx = -1;
var colMap = {};
for (var hi = 0; hi < Math.min(allRows.length, 50); hi++) {
var row = allRows[hi];
for (var ci = 0; ci < row.length; ci++) {
var val = String(row[ci]||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036
if (val === "ativo" || val === "ticker" || val === "codigo" || val === "papel") {
headerIdx = hi;
break;
}
}
if (headerIdx >= 0) break;
}
if (headerIdx < 0) {
// Fallback: try standard sheet_to_json
var raw2 = XLSX.utils.sheet_to_json(ws, {defval:""});
if (raw2.length > 0) {
var cols2 = Object.keys(raw2[0]);
var tc2 = cols2[0];
var assets2 = [];
for (var r2 = 0; r2 < raw2.length; r2++) {
var tk2 = String(raw2[r2][tc2]||"").trim().toUpperCase();
if (!tk2 || tk2.length < 2) continue;
assets2.push({ticker:tk2, name:"", qty:0, avgPrice:0, currentPrice:0, totalValue:
}
setPosAssets(assets2);
}
return;
}
// Map columns by header name
var headers = allRows[headerIdx];
function findHCol(patterns) {
for (var c = 0; c < headers.length; c++) {
var h = String(headers[c]||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u03
for (var p = 0; p < patterns.length; p++) { if (h.indexOf(patterns[p]) >= 0) return
}
return -1;
}
var iAtivo = findHCol(["ativo","ticker","codigo","papel"]);
var iSubClass = findHCol(["sub-classe","subclasse","sub classe","subcategoria"]);
var iClasse = findHCol(["classe","class","categoria","tipo"]);
var iQty = findHCol(["quantidade","qtd","qty","shares"]);
var iPos = findHCol(["posicao","posição","posição (r$)","posicao (r$)","saldo","valor",
var iPreco = findHCol(["preco (r$)","preco","cotacao","preco atual","ultimo"]);
var iPrecoMedio = findHCol(["preco medio","medio","custo","preco médio"]);
var iCorretora = findHCol(["corretora","broker","custodiante"]);
var assets = [];
for (var ri = headerIdx + 1; ri < allRows.length; ri++) {
var row = allRows[ri];
var ativoRaw = String(row[iAtivo >= 0 ? iAtivo : 0] || "").trim();
if (!ativoRaw || ativoRaw.length < 2) continue;
if (/^(total|subtotal|patrimonio|resultado|rentabilidade)$/i.test(ativoRaw)) continue
var subClass = iSubClass >= 0 ? String(row[iSubClass]||"").trim() : "";
var classe = iClasse >= 0 ? String(row[iClasse]||"").trim() : "";
var totalVal = iPos >= 0 ? parseFloat(String(row[iPos]||"0").toString().replace(/[^\d
var qty = iQty >= 0 ? parseFloat(String(row[iQty]||"0").toString().replace(/[^\d,.-]/
var preco = iPreco >= 0 ? parseFloat(String(row[iPreco]||"0").toString().replace(/[^\
var precoMedio = iPrecoMedio >= 0 ? parseFloat(String(row[iPrecoMedio]||"0").toString
// Extract ticker from ativo field (could be "VALE3" or "LCA 91% CDI BANCO...")
var ticker = ativoRaw.toUpperCase();
var name = "";
// If it looks like a ticker (4-6 chars + optional number), use as is
if (/^[A-Z]{3,6}\d{0,2}$/.test(ticker)) {
name = ativoRaw;
} else {
// It's a name (e.g. "LCA 91% CDI BANCO BTG"). Use first word or abbreviate
name = ativoRaw;
// Try to extract a short label
if (ativoRaw.length > 20) ticker = ativoRaw.slice(0, 20) + "...";
}
// Skip zero-value rows
if (totalVal === 0 && qty === 0) continue;
assets.push({
ticker: ticker, name: name,
qty: qty, avgPrice: precoMedio, currentPrice: preco,
totalValue: totalVal,
type: classe, // "Renda Fixa", "Renda Variável", "Caixa"
subClass: subClass // "Ações", "FIIs", "ETFs", "Indexado a Juros", "Fundos", "Caixa
});
}
setPosAssets(assets);
// Save position to client profile
if (editingProfile && assets.length > 0) {
var updated = Object.assign({}, editingProfile, {posAssets: assets, posFileName: f.na
saveProfileToList(updated);
}
if (assets.length > 0) setError("");
else setError("Nenhum ativo encontrado na planilha. Verifique o formato.");
} catch(err) { setError("Erro ao ler Excel: " + err.message); }
}
// ── Build asset list from ALL sources ──
function buildAssetList() {
var jbd = editingProfile ? editingProfile.jbData : null;
var cartLookup = {};
(carteirasData.carteiras || []).forEach(function(cart) {
(carteirasData.ativos[cart.id] || []).forEach(function(a) {
cartLookup[a.ticker] = Object.assign({carteira: cart.name, intl: cart.intl}, a);
});
});
var assetMap = {};
var suggested = jbd ? (jbd.suggestedPortfolio || []) : [];
var rationales = jbd ? (jbd.assetRationales || []) : [];
suggested.forEach(function(asset) {
assetMap[asset.ticker] = { ticker: asset.ticker, name: asset.name || "", class: asset.c
});
Object.keys(cartLookup).forEach(function(tk) {
if (!assetMap[tk]) {
var ca = cartLookup[tk];
assetMap[tk] = { ticker: tk, name: ca.name || "", class: ca.intl ? "Internacional" :
rat =
{ posM
}
});
var result = Object.keys(assetMap).map(function(tk) {
var a = assetMap[tk];
var appMatch = null;
for (var i = 0; i < allAppStocks.length; i++) { if (allAppStocks[i].ticker === tk) { ap
var rat = null;
for (var j = 0; j < rationales.length; j++) { if (rationales[j].ticker === tk) { var posMatch = null;
for (var pi = 0; pi < posAssets.length; pi++) { if (posAssets[pi].ticker === tk) var cartMatch = cartLookup[tk] || null;
a.name = a.name || (posMatch ? posMatch.name : "") || (appMatch ? appMatch.name : "");
a.currentPrice = rat ? rat.currentPrice : (posMatch ? posMatch.currentPrice : null);
a.ceilingPrice = rat ? rat.ceilingPrice : (cartMatch ? cartMatch.precoTeto : null);
a.deltaCeiling = (a.ceilingPrice && a.currentPrice) ? Math.round((a.ceilingPrice a.rationale = rat ? rat.rationale : null;
a.currentQty = posMatch ? posMatch.qty : 0; a.currentAvgPrice = posMatch ? posMatch.avg
a.currentTotalValue = posMatch ? posMatch.totalValue : 0; a.hasPosition = !!posMatch;
a.appMatch = appMatch ? { thesis: appMatch.thesis, result: appMatch.result, resultPros:
a.hasAppData = !!appMatch;
a.carteiraSuno = cartMatch;
// Calculate % of portfolio: JB suggested vs current position (from Excel)
/ a.cu
a.jbPercent = a.suggestedPercent || 0;
var excelTotal = posAssets.reduce(function(s,x){return s+(x.totalValue||0);},0);
var posMatch2 = null;
for (var pj = 0; pj < posAssets.length; pj++) { if (posAssets[pj].ticker === tk) { posM
a.posPercent = (posMatch2 && excelTotal > 0) ? (posMatch2.totalValue / excelTotal * 100
a.posValue = posMatch2 ? posMatch2.totalValue : 0;
return a;
});
result.sort(function(x,y) { var ra = x.carteiraSuno?(x.carteiraSuno.rank||999):999; var r
setCrossrefData(result); setSelectedAssets({}); setAnalyses({}); setRecStep("select");
}
// ── Fetch live quotes via AI + web search ──
function buildProfileContext() {
if (!editingProfile) return "";
var pr = editingProfile;
var parts = ["PERFIL DO CLIENTE:"];
if (pr.name) parts.push("Nome: " + pr.name);
if (pr.age) parts.push("Idade: " + pr.age + " anos");
if (pr.profession) parts.push("Profissao: " + pr.profession);
if (pr.totalWealth) parts.push("Patrimonio: R$ " + parseFloat(pr.totalWealth).toLocaleStr
if (pr.monthlyIncome) parts.push("Renda: R$ " + parseFloat(pr.monthlyIncome).toLocaleStri
if (pr.monthlyContribution) parts.push("Aporte mensal: R$ " + parseFloat(pr.monthlyContri
parts.push("Perfil: " + (pr.riskProfile || "Moderado"));
if (pr.horizon) parts.push("Horizonte: " + pr.horizon + " anos");
if (pr.longTermGoals) parts.push("Objetivos: " + pr.longTermGoals);
if (pr.strategy) parts.push("Estrategia: " + pr.strategy);
var alloc = pr.allocation || {};
var ap = []; ALLOC_CLASSES.forEach(function(cls) {
var a = alloc[cls] || {target:0,current:0};
ap.push(cls + ": meta=" + a.target + "%, atual=" + a.current + "%");
});
if (ap.length > 0) parts.push("Alocacao: " + ap.join("; "));
return parts.join("\n");
}
function buildJourneyContext() {
var jbd = editingProfile ? editingProfile.jbData : null;
var parts = [];
// JB = META ALVO (objetivo)
if (jbd) {
parts.push("JOURNEY BOOK (META ALVO — onde o cliente DEVERIA estar):");
if (jbd.projections) {
var pj = jbd.projections;
if (pj.capitalAtRetirement) parts.push("Capital projetado: R$ " + pj.capitalAtRetirem
}
if (jbd.allocationMacro && jbd.allocationMacro.classes) {
parts.push("ALOCACAO META:");
jbd.allocationMacro.classes.forEach(function(c) {
parts.push(" " + c.name + ": meta=" + c.suggestedPercent + "%");
});
}
}
// POSIÇÃO EXCEL = REALIDADE ATUAL (fonte de verdade)
if (posAssets.length > 0) {
var posTotal = posAssets.reduce(function(s,a){return s+(a.totalValue||0);},0);
parts.push("\nPOSICAO ATUAL DO EXCEL (realidade — fonte de verdade):");
parts.push("Patrimonio total em ativos: R$ " + posTotal.toLocaleString("pt-BR"));
if (availableCash) parts.push("Caixa disponivel para aportes: R$ " + parseFloat(availab
// Breakdown by class/subclass
var classBreak = {};
posAssets.forEach(function(a) {
var cls = a.type || "Outros"; // "Renda Fixa", "Renda Variável", "Caixa"
var sub = a.subClass || "Outros"; // "Ações", "FIIs", "ETFs", etc
var key = cls === "Renda Variável" ? sub : cls; // RF=class, RV=subclass
if (!classBreak[key]) classBreak[key] = {value:0, count:0, tickers:[]};
classBreak[key].value += (a.totalValue||0);
classBreak[key].count++;
classBreak[key].tickers.push(a.ticker);
});
parts.push("COMPOSICAO ATUAL POR CLASSE (do Excel):");
Object.keys(classBreak).forEach(function(k) {
var cb = classBreak[k];
var pct = posTotal > 0 ? (cb.value / posTotal * 100).toFixed(1) : "0";
parts.push(" " + k + ": R$ " + cb.value.toLocaleString("pt-BR") + " (" + pct + "%) —
});
// Top holdings
var sorted = posAssets.slice().sort(function(a,b){return (b.totalValue||0)-(a.totalValu
parts.push("MAIORES POSICOES:");
sorted.slice(0, 15).forEach(function(a) {
var pct = posTotal > 0 ? ((a.totalValue||0) / posTotal * 100).toFixed(1) : "0";
parts.push(" " + a.ticker + " (" + (a.subClass||a.type||"") + "): R$ " + (a.totalVal
});
}
return parts.join("\n");
}
function buildCarteirasContext() {
var cartCtx = [];
(carteirasData.carteiras || []).forEach(function(cart) {
var ativos = carteirasData.ativos[cart.id] || [];
if (ativos.length === 0) return;
cartCtx.push("CARTEIRA " + cart.name.toUpperCase() + ":");
ativos.forEach(function(a) {
cartCtx.push(" #" + (a.rank||"?") + " " + a.ticker + " Teto:" + (a.precoTeto!=null?(
});
});
return cartCtx.length > 0 ? "CARTEIRAS SUNO:\n" + cartCtx.join("\n") : "";
}
function buildMacroCtxShort() {
var md = loadMacroData(); var parts = [];
if (md.macroReports && md.macroReports.length > 0) { parts.push("MACRO: " + md.macroRepor
if (md.biasViews && Object.keys(md.biasViews).length > 0) { parts.push("VIES: " + Object.
return parts.join("\n");
}
// ── Generate preview: strategy + cash distribution + rationale per asset ──
async function generatePreview() {
var selected = (crossrefData || []).filter(function(c) { return selectedAssets[c.ticker];
if (selected.length === 0) return;
setGenerating(true); setError(""); setGenProgress("Gerando prévia estratégica...");
setPreviewApproved(false);
try {
var profileCtx = buildProfileContext();
var journeyCtx = buildJourneyContext();
var carteirasCtx = buildCarteirasContext();
var macroCtx = buildMacroCtxShort();
var baseCash = parseFloat(availableCash) || 0;
var sellTotal = Object.keys(sellAssets).reduce(function(s,tk){return s+(sellAssets[tk].
var cash = baseCash + sellTotal;
// Build sell context
var sellCtx = "";
if (sellTotal > 0) {
var sellItems = Object.keys(sellAssets).map(function(tk) {
var pa = posAssets.find(function(p){return p.ticker===tk;});
return { ticker: tk, sellValue: sellAssets[tk].value, currentValue: pa?(pa.totalVal
});
sellCtx = "\nVENDAS PROPOSTAS (R$ " + sellTotal.toLocaleString("pt-BR") + " total):\n
}
var assetsCtx = selected.map(function(a) {
var ctx = { ticker: a.ticker, name: a.name, class: a.class || a._classTag || "", jbPe
if (a.appMatch) ctx.appData = { result: (a.appMatch.result||"").slice(0,200), sentime
if (a.carteiraSuno) ctx.carteiraSuno = { rank: a.carteiraSuno.rank, precoTeto: a.cart
return ctx;
});
// Use shared tone instruction
var toneInst = getToneInstruction(writingTone, false);
var sys = 'Voce e um consultor de investimentos gerando um RELATORIO DE RECOMENDACOES M
+ '\n\nTOM DE ESCRITA: ' + toneInst
+ '\n\nREGRAS DE ESCRITA OBRIGATORIAS:'
+ ' - SEM SENSACIONALISMO. NAO use expressoes como "oportunidade unica", "momento exc
+ ' - NAO mencione rankings internos ("ativo #1 da carteira X", "lider da carteira Y"
+ ' - NAO mencione classificacoes internas como "vies Comprar/Aguardar".'
+ ' - FOQUE em: tese do ativo (o que a empresa faz e por que e relevante), resultados
+ ' - Escreva de forma EQUILIBRADA — mencione tanto pontos positivos quanto riscos.'
+ '\n\nVoce recebera: perfil do cliente, Journey Book (METAS), POSICAO ATUAL DO EXCEL
+ ' A POSICAO ATUAL vem do EXCEL — e a carteira real. O Journey Book e o PLANO com as
+ ' O cliente tem R$ ' + cash.toLocaleString("pt-BR") + ' disponiveis para investir'
+ '\n\nGere JSON:'
+ ' {"strategy":"3-5 paragrafos: 1) Onde esta a carteira hoje (dados do Excel) vs o p
+ ' "allocations":[{"ticker":"XXXX","value":NUMERO_EM_REAIS,"percent":PERCENTUAL_DO_C
+ (sellTotal > 0 ? ',"sells":[{"ticker":"XXXX","value":VALOR_DA_VENDA,"rationale":"1
+ '}'
+ '\n\nREGRAS TECNICAS: Distribua R$ ' + cash.toLocaleString("pt-BR") + ' inteligente
var userMsg = profileCtx + "\n" + journeyCtx + "\n" + macroCtx + "\n" + carteirasCtx +
var resp = await fetch("/api/anthropic", { method: "POST", headers: {"Content-Type":"ap
if (!resp.ok) throw new Error("API " + resp.status);
var d = await resp.json(); var raw = "";
for (var i = 0; i < d.content.length; i++) { if (d.content[i].text) raw += d.content[i]
raw = raw.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"");
var si = raw.indexOf("{"); var ei = raw.lastIndexOf("}");
if (si >= 0 && ei > si) raw = raw.slice(si, ei + 1);
raw = raw.replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]");
var parsed = JSON.parse(raw);
setStrategyText(parsed.strategy || "");
var allocMap = {};
(parsed.allocations || []).forEach(function(a) {
allocMap[a.ticker] = { value: a.value || 0, percent: a.percent || 0, rationale: a.rat
});
// Process sells
(parsed.sells || []).forEach(function(a) {
allocMap[a.ticker] = { value: -(a.value || 0), percent: 0, rationale: a.rationale ||
});
setAllocations(allocMap);
setRecStep("preview");
} catch(err) { console.error(err); setError("Erro: " + err.message); }
setGenerating(false); setGenProgress("");
}
// ── Readjust after consultant changes values ──
async function readjustTexts() {
setGenerating(true); setError(""); setGenProgress("Reajustando textos...");
try {
var items = Object.keys(allocations).map(function(tk) {
var a = allocations[tk];
var cr = (crossrefData||[]).find(function(c){return c.ticker===tk;});
return { ticker: tk, name: cr?cr.name:"", value: a.value, verdict: a.verdict, class:
});
var totalAlloc = items.reduce(function(s,a){return s+(a.value||0);},0);
var sys = 'O consultor ajustou os valores de aporte. Reescreva os textos mantendo os NO
+ ' NAO mencione rankings internos, "vies Comprar/Aguardar", "lider da carteira X". F
+ ' JSON: {"strategy":"NOVO TEXTO 3-5 paragrafos em linguagem simples","allocations":
var userMsg = "Estrategia anterior:\n" + strategyText.slice(0,2000) + "\n\nNOVOS VALORE
var resp = await fetch("/api/anthropic", { method:"POST", headers:{"Content-Type":"appl
if (!resp.ok) throw new Error("API " + resp.status);
var d = await resp.json(); var raw = "";
for (var i = 0; i < d.content.length; i++) { if (d.content[i].text) raw += d.content[i]
raw = raw.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"");
var si = raw.indexOf("{"); var ei = raw.lastIndexOf("}");
if (si >= 0 && ei > si) raw = raw.slice(si, ei + 1);
var parsed = JSON.parse(raw);
if (parsed.strategy) setStrategyText(parsed.strategy);
if (parsed.allocations) {
var newAlloc = Object.assign({}, allocations);
parsed.allocations.forEach(function(a) {
if (newAlloc[a.ticker]) {
newAlloc[a.ticker] = Object.assign({}, newAlloc[a.ticker], { rationale: a.rationa
}
});
setAllocations(newAlloc);
}
setPreviewApproved(false);
} catch(err) { console.error(err); setError("Erro: " + err.message); }
setGenerating(false); setGenProgress("");
}
function updateAllocation(ticker, field, value) {
setAllocations(function(prev) {
var n = Object.assign({}, prev);
n[ticker] = Object.assign({}, n[ticker]);
n[ticker][field] = value;
return n;
});
setPreviewApproved(false);
}
function deselectAsset(ticker) {
setSelectedAssets(function(prev) { var n = Object.assign({}, prev); delete n[ticker]; ret
setAnalyses(function(prev) { var n = Object.assign({}, prev); delete n[ticker]; return n;
}
function updateAnalysis(ticker, field, value) {
setAnalyses(function(prev) {
var n = Object.assign({}, prev);
n[ticker] = Object.assign({}, n[ticker]);
n[ticker][field] = value;
return n;
});
}
// ── Operational PDF (table for daily banker) ──
// ── Styles ──
var iS={width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255
var lS={fontSize:"10px",fontWeight:600,color:"rgba(255,255,255,0.5)",marginBottom:"4px",dis
var btnBase={padding:"8px 16px",borderRadius:"8px",border:"none",cursor:"pointer",fontWeigh
var selCount=Object.keys(selectedAssets).length;
var matchCount=crossrefData?crossrefData.filter(function(c){return c.hasAppData;}).length:0
var cartCount=crossrefData?crossrefData.filter(function(c){return c.carteiraSuno;}).length:
var jbData = editingProfile ? editingProfile.jbData : null;
var hasJB = !!jbData;
// ── RENDER ──
return (
<div style={p.inline?{padding:"0"}:{position:"fixed",inset:0,zIndex:2000,background:"rgba
{showSnapshotWizard && editingProfile && (
<SnapshotWizardModal
clientProfileId={editingProfile.id}
clientName={editingProfile.name || "Cliente"}
isAdmin={p.isAdmin}
onClose={function(){setShowSnapshotWizard(false);}}
onSaved={function(){loadSnapshotsForClient(editingProfile.id);}}
/>
)}
{viewingSnapshot && editingProfile && (
<SnapshotViewerModal
snapshot={viewingSnapshot}
target={editingProfile && editingProfile.jbData ? resolveTarget(snapshotsList.find(
isLatestAtual={(function(){
var atuais = snapshotsList.filter(function(s){return s.tipo==="atual";}).sort(fun
return atuais.length > 0 && atuais[0].id === viewingSnapshot.id;
})()}
onClose={function(){setViewingSnapshot(null);}}
onSaved={function(){loadSnapshotsForClient(editingProfile.id);}}
/>
)}
{showTargetEditor && editingProfile && (
<SnapshotTargetEditorModal
clientProfileId={editingProfile.id}
clientName={editingProfile.name || "Cliente"}
jbData={editingProfile.jbData}
savedAlvo={snapshotsList.find(function(s){return s.tipo==="alvo";})}
onClose={function(){setShowTargetEditor(false);}}
onSaved={function(){loadSnapshotsForClient(editingProfile.id);}}
/>
)}
<div style={{background:"#0A0A0A",borderRadius:p.inline?"0":"16px",border:p.inline?"non
{/* Header */}
<div style={{padding:"20px 24px 14px",borderBottom:"1px solid rgba(255,255,255,0.06)"
<div>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>Recomendações</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)",marginTop:"2px"}}>Estr
</div>
<button onClick={p.onClose} style={{background:"transparent",border:"none",color:"r
</div>
{/* Client selector */}
<div style={{padding:"12px 24px",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
<div style={{display:"flex",gap:"8px",alignItems:"center"}}>
<select value={selectedProfileId} onChange={function(e){selectProfile(e.target.va
<option value="" style={{background:"#1a1a1a"}}>Selecionar cliente...</option>
{clientProfiles.map(function(pr){return <option key={pr.id} value={pr.id} style
</select>
<button onClick={createNewProfileInline} style={{fontSize:"10px",color:"#DC2626",
</div>
</div>
{/* Sub-abas */}
{editingProfile && (<div>
<div style={{display:"flex",gap:"2px",padding:"10px 24px 0",borderBottom:"1px solid
{[{k:CONSULT_TAB_STRATEGY,l:"Estratégia (JB)",icon:" "},{k:CONSULT_TAB_RECOMMEND
return <button key={t.k} onClick={function(){setMainTab(t.k);}} style={{padding
})}
</div>
<div style={{padding:"20px 24px 24px"}}>
{error&&<div style={{color:"#f87171",fontSize:"11px",padding:"8px 10px",backgroun
{/* ═══ TAB ESTRATÉGIA ═══ */}
{mainTab===CONSULT_TAB_STRATEGY&&(<div>
{/* Profile editor */}
<div style={{background:"rgba(220,38,38,0.02)",border:"1px solid rgba(220,38,38
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center
<span style={{fontSize:"10px",fontWeight:700,color:"#DC2626",textTransform:
<button onClick={function(){setShowProfileEditor(!showProfileEditor);}} sty
</div>
{!showProfileEditor&&editingProfile.name&&<div style={{fontSize:"10px",color:
{showProfileEditor&&<div><ClientProfileEditor profile={editingProfile} onChan
</div>
{/* JB status — header clicável que minimiza/expande */}
<div onClick={function(){setEstrategiaClienteCollapsed(!estrategiaClienteCollap
<div style={{fontSize:"10px",fontWeight:700,color:"#fbbf24",textTransform:"up
{estrategiaClienteCollapsed && hasJB && (
<span style={{fontSize:"9px",color:"rgba(255,255,255,0.35)"}}>
{jbData.origem === "asset_alloc_synthetic" ? " Asset Alloc" : " </span>
JB sa
)}
</div>
{!estrategiaClienteCollapsed && (<>
{hasJB ? (
<div style={{background:"rgba(74,222,128,0.04)",border:"1px solid rgba(74,222
<div style={{display:"flex",justifyContent:"space-between",alignItems:"cent
<div style={{display:"flex",alignItems:"center",gap:"8px"}}>
{jbData.origem === "asset_alloc_synthetic" ? (
<span style={{fontSize:"9px",padding:"2px 8px",borderRadius:"10px",ba
) : (
<span style={{fontSize:"9px",padding:"2px 8px",borderRadius:"10px",ba
)}
<span style={{fontSize:"10px",color:"rgba(255,255,255,0.4)"}}>Importado
</div>
<div style={{display:"flex",gap:"4px"}}>
<label style={{fontSize:"9px",color:"#fbbf24",background:"rgba(251,191,
{jbData.origem === "asset_alloc_synthetic" ? "+ Adicionar JB" : "Reim
<input ref={fileRef} type="file" accept=".pdf" onChange={handleJBUplo
</label>
<button onClick={clearJB} style={{fontSize:"9px",color:"rgba(220,38,38,
</div>
</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.45)",lineHeight:1.6}
{jbData.origem === "asset_alloc_synthetic" ? (
<span>
{jbData.currentPortfolio && <span>{jbData.currentPortfolio.length} at
{jbData.allocationMacro && jbData.allocationMacro.classes && <span> ·
<br/><span style={{fontSize:"9px",color:"rgba(255,255,255,0.35)",font
</span>
) : (
<span>
{jbData.suggestedPortfolio&&<span>{jbData.suggestedPortfolio.length}
{jbData.projections&&jbData.projections.capitalAtRetirement&&<span> ·
{jbData.allocationMacro&&jbData.allocationMacro.classes&&<span> · {jb
</span>
)}
</div>
{jbFileName && <div style={{marginTop:"8px",padding:"8px",background:"rgba(
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.5)",marginBottom:"
<button onClick={parseJourneyBook} disabled={jbParsing} style={Object.ass
</div>}
</div>
) : (
<div style={{background:"rgba(255,255,255,0.02)",border:"1px dashed rgba(255,
<div style={{fontSize:"11px",color:"rgba(255,255,255,0.3)",marginBottom:"8p
<label style={{display:"inline-block",padding:"8px 16px",borderRadius:"7px"
Importar PDF do Journey Book
<input ref={fileRef} type="file" accept=".pdf" onChange={handleJBUpload}
</label>
{jbFileName && <div style={{marginTop:"8px"}}>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginBottom:"
<button onClick={parseJourneyBook} disabled={jbParsing} style={Object.ass
</div>}
</div>
)}
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.2)",lineHeight:1.6}}>O Jo
</>)}
{/* ─── SNAPSHOTS (M1) ─── */}
<div style={{marginTop:"20px",paddingTop:"16px",borderTop:"1px solid rgba(255,2
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center
<div onClick={function(){setSnapshotsPosicaoCollapsed(!snapshotsPosicaoColl
<div style={{fontSize:"10px",fontWeight:700,color:"#60a5fa",textTransform
{!snapshotsPosicaoCollapsed && <div style={{fontSize:"9px",color:"rgba(25
</div>
<button onClick={function(){setShowSnapshotWizard(true);}} style={{padding:
</div>
{!snapshotsPosicaoCollapsed && (<>
{loadingSnapshots && <div style={{fontSize:"10px",color:"rgba(255,255,255,0.3
{!loadingSnapshots && snapshotsList.length === 0 && (
<div style={{background:"rgba(255,255,255,0.02)",border:"1px dashed rgba(25
<div style={{fontSize:"11px",color:"rgba(255,255,255,0.35)"}}>Nenhum snap
</div>
)}
{!loadingSnapshots && snapshotsList.length > 0 && (
<div style={{display:"flex",flexDirection:"column",gap:"5px"}}>
{(function(){
return snapshotsList.map(function(snap){
var d = snap.data || {};
var patr = d.patrimonio_total || 0;
var ativos = (d.contagem && d.contagem.total) || (d.ativos ? d.ativos
var tipoLabels = {inicial:"Inicial", alvo:"Alvo", atual:"Atual"};
var tipoColors = {inicial:"#8b5cf6", alvo:"#10b981", atual:"#60a5fa"}
var tc = tipoColors[snap.tipo] || "#888";
return <div key={snap.id} style={{display:"flex",alignItems:"center",
onMouseEnter={function(e){e.currentTarget.style.background="rgba(59
onMouseLeave={function(e){e.currentTarget.style.background="rgba(25
onClick={function(){setViewingSnapshot(snap);}}>
<div style={{display:"flex",alignItems:"center",gap:"10px",flex:1,m
<span style={{fontSize:"9px",padding:"2px 8px",borderRadius:"10px
<div style={{fontSize:"11px",color:"rgba(255,255,255,0.7)",fontWe
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)"}}>· R$
{snap.tipo === "inicial" && <div style={{fontSize:"9px",color:"rg
</div>
<button onClick={function(e){
e.stopPropagation();
var warning = snap.tipo === "inicial" ? "Remover o snapshot inici
if(!confirm(warning))return;
deleteClientSnapshot(snap.id).then(function(){loadSnapshotsForCli
}} style={{fontSize:"10px",color:"rgba(220,38,38,0.5)",background:"
</div>;
});
})()}
</div>
)}
</>)}
{/* ─── M3: Overview + Timeline (M4: com alvo salvo + botão editar) ─── */}
{!loadingSnapshots && snapshotsList.length > 0 && editingProfile && editingPr
var atuais = snapshotsList.filter(function(s){return s.tipo==="atual";}).sl
atuais.sort(function(a,b){return (b.snapshot_date||"").localeCompare(a.snap
var latest = atuais[0];
if (!latest) return null;
var savedAlvo = snapshotsList.find(function(s){return s.tipo==="alvo";});
var target = resolveTarget(savedAlvo, editingProfile.jbData);
return <div>
<SnapshotOverview
snapshot={latest.data}
target={target}
targetIsSaved={!!savedAlvo}
onOpenSnapshot={function(s){setViewingSnapshot(s);}}
onEditTarget={function(){setShowTargetEditor(true);}}
onOpenGapDetail={function(classe){
setGapDetailSnapshotStg(latest.data);
setGapDetailTargetStg(target);
setGapDetailModeStg("carteira");
setGapDetailClasseStg(classe);
}}
/>
<SnapshotTimeline
snapshots={snapshotsList}
target={target}
onOpenSnapshot={function(s){setViewingSnapshot(s);}}
collapsed={timelineSnapshotsCollapsed}
onToggle={function(){setTimelineSnapshotsCollapsed(!timelineSnapshotsCo
/>
</div>;
})()}
{!loadingSnapshots && snapshotsList.length > 0 && editingProfile && !editingP
<div style={{marginTop:"14px",background:"rgba(251,191,36,0.06)",border:"1p
Este cliente ainda não tem estratégia importada. Importe a planilha As
</div>
)}
<div style={{marginTop:"10px",fontSize:"9px",color:"rgba(255,255,255,0.2)",li
</div>
</div>)}
{/* ═══ TAB RECOMENDAÇÃO ═══ */}
{mainTab===CONSULT_TAB_RECOMMEND&&(<div>
{!hasJB && <div style={{textAlign:"center",padding:"30px 0",color:"rgba(255,255
{hasJB && (
<RecommendFlowV2
editingProfile={editingProfile}
consultorName={consultorName}
setConsultorName={setConsultorName}
consultorProfile={consultorProfile}
setShowConsultorEditor={setShowConsultorEditor}
period={period}
setPeriod={setPeriod}
hasJB={hasJB}
allocations={allocations}
setAllocations={setAllocations}
carteirasData={carteirasData}
allAppStocks={allAppStocks}
macroReports={(function(){ try { var md = loadMacroData(); return (md && md
fiiReports={p.data && p.data.fiiReports ? p.data.fiiReports : []}
/>
)}
</div>)}
</div>
</div>)}
{!editingProfile && <div style={{padding:"40px 24px",textAlign:"center",color:"rgba(2
</div>
{/* ═══ MODAL: Gap detalhado por ativo ═══ */}
{gapDetailClasseStg && (function(){
// Modal da aba Estratégia — snapshot e target vêm via setters
var snapForDetail = gapDetailSnapshotStg || null;
var targetForDetail = gapDetailTargetStg || null;
if (!snapForDetail || !targetForDetail) return null;
var classe = gapDetailClasseStg;
var mode = gapDetailModeStg; // "carteira" | "classe"
var atVs = snapForDetail.ativos || [];
var totalPatr = atVs.reduce(function(s,a){ return s + (a.valor || 0); }, 0);
// Filtra ativos da classe
var ativosDaClasse = atVs.filter(function(a){ return a.classe === classe; });
var totalClasse = ativosDaClasse.reduce(function(s,a){ return s + (a.valor || 0); },
// Alvo por ativo (em % da carteira) vem do target.allocAtivos
var alvoAtivos = (targetForDetail && targetForDetail.allocAtivos) || {};
// Junta ativos atuais + ativos do alvo que o cliente ainda não tem
var tickersMap = {};
ativosDaClasse.forEach(function(a){
var tk = a.ticker || a.nome_original || "";
if (!tk) return;
tickersMap[tk] = {
ticker: tk,
nome: a.nome_original || a.ticker,
subclasse: a.subclasse || null,
status: a.status_recomendacao || null,
valor: a.valor || 0,
atPctCarteira: totalPatr > 0 ? (a.valor / totalPatr) * 100 : 0,
atPctClasse: totalClasse > 0 ? (a.valor / totalClasse) * 100 : 0,
tgPctCarteira: 0,
noAlvo: false,
forayCarteira: false,
// Dados pra cálculo de L/P na renderização (ver coluna Preço & L/P)
_classe: a.classe,
_preco_medio: a.preco_medio,
_preco: a.preco,
_quantidade: a.quantidade
};
});
// Filtra allocAtivos do alvo: adiciona só os que são dessa classe
// Pra saber a classe do alvo, cruza com allAppStocks (portfolio Internacional/Divide
var stockByTicker = {};
allAppStocks.forEach(function(s){ if (s.ticker) stockByTicker[s.ticker] = s; });
Object.keys(alvoAtivos).forEach(function(tk){
var tgPct = alvoAtivos[tk] || 0;
if (tgPct <= 0) return;
// Determina classe do ticker via stock do Suno research
var stock = stockByTicker[tk];
var classeAlvo = null;
if (stock && stock._portfolio) {
if (stock._portfolio === "Internacional") classeAlvo = "internacional";
else if (stock._portfolio === "FIIs") classeAlvo = "fiis";
else classeAlvo = "acoes_br"; // Dividendos, Valor, Small Caps
}
// Se o cliente já tem esse ticker, usa a classe do ativo do cliente
if (tickersMap[tk]) classeAlvo = classe; // já está no map
if (classeAlvo !== classe) return; // não é dessa classe
if (tickersMap[tk]) {
tickersMap[tk].tgPctCarteira = tgPct;
tickersMap[tk].noAlvo = true;
} else {
tickersMap[tk] = {
ticker: tk,
nome: stock ? stock.name : tk,
subclasse: null,
status: null,
valor: 0,
atPctCarteira: 0,
atPctClasse: 0,
tgPctCarteira: tgPct,
noAlvo: true,
forayCarteira: false,
};
}
});
// Marca ativos que estão fora do alvo (cliente tem mas não é carteira Suno)
Object.keys(tickersMap).forEach(function(tk){
if (tickersMap[tk].atPctCarteira > 0 && tickersMap[tk].tgPctCarteira === 0) {
tickersMap[tk].forayCarteira = true;
}
});
// Converte pra lista e ordena
var lista = Object.values(tickersMap);
// Alvo na unidade escolhida
lista.forEach(function(it){
if (mode === "carteira") {
it.atEff = it.atPctCarteira;
it.tgEff = it.tgPctCarteira;
} else {
it.atEff = it.atPctClasse;
// % da classe: converte alvo_carteira pra alvo_classe
// alvoClasse total desta classe = sum(allocAtivos da classe)
// mas pra simplificar: se totalClasse alvo = X% da carteira, cada ativo X% é it.
var tgClasseTotal = 0;
lista.forEach(function(x){ tgClasseTotal += x.tgPctCarteira || 0; });
it.tgEff = tgClasseTotal > 0 ? (it.tgPctCarteira / tgClasseTotal) * 100 : 0;
}
});
it.gapEff = it.atEff - it.tgEff;
it.absGapEff = Math.abs(it.gapEff);
lista.sort(function(a,b){ return (b.valor || 0) - (a.valor || 0); });
// Pra RF: agrupa por indexador
var gruposRF = null;
if (classe === "renda_fixa") {
gruposRF = {};
ativosDaClasse.forEach(function(a){
var ix = canonicalizeRFSubclasse(a);
if (!gruposRF[ix]) gruposRF[ix] = {atValor: 0, ativos: []};
gruposRF[ix].atValor += (a.valor || 0);
gruposRF[ix].ativos.push(a);
});
// Adiciona alvo por indexador
var allocIxTg = (targetForDetail && targetForDetail.allocIndexadoresRF) || {};
Object.keys(allocIxTg).forEach(function(ix){
if (!gruposRF[ix]) gruposRF[ix] = {atValor: 0, ativos: []};
gruposRF[ix].tgPctCarteira = allocIxTg[ix];
});
Object.keys(gruposRF).forEach(function(ix){
var g = gruposRF[ix];
g.atPctCarteira = totalPatr > 0 ? (g.atValor / totalPatr) * 100 : 0;
g.atPctClasse = totalClasse > 0 ? (g.atValor / totalClasse) * 100 : 0;
g.tgPctCarteira = g.tgPctCarteira || 0;
});
}
var classLabel = CLASS_LABELS_V2[classe] || classe;
var classClr = classe==="renda_fixa" ? "#3b82f6" : classe==="acoes_br" ? "#dc2626" :
function fmtPct(x){ return (x||0).toFixed(2) + "%"; }
function gapColorLocal(g) {
if (g > 0.5) return "#60a5fa"; // acima: azul
if (g < -0.5) return "#f87171"; // abaixo: vermelho
return "#4ade80"; // ok: verde
}
return (
<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",zIndex:2200,dis
<div style={{background:"#0a0a0a",border:"1px solid "+classClr+"33",borderRadius:
{/* Header */}
<div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-sta
<div>
<div style={{fontSize:"10px",fontWeight:700,color:classClr,textTransform:"u
<div style={{fontSize:"17px",fontWeight:800,color:"#fff"}}>{classLabel}</di
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginTop:"3px"}
R$ {totalClasse.toLocaleString("pt-BR",{maximumFractionDigits:0})} · {ati
</div>
</div>
<button onClick={function(){ setGapDetailClasseStg(null); setGapDetailSnapsho
</div>
{/* Toggle modo de visualização */}
<div style={{display:"flex",gap:"6px",marginBottom:"14px"}}>
{[{k:"carteira",l:"% da carteira total",d:"Quanto cada ativo representa do pa
var isSel = mode === opt.k;
return <button key={opt.k} onClick={function(){ setGapDetailModeStg(opt.k);
style={{flex:1,padding:"8px 10px",fontSize:"10px",fontWeight:700,borderRa
{opt.l}
</button>;
})}
</div>
{/* Legenda */}
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.45)",marginBottom:"10px",
<b style={{color:"rgba(255,255,255,0.6)"}}>Legenda:</b> <span style={{color:"
</div>
{/* Banner: alvo por ticker vazio (cliente só tem Asset Alloc, sem JB real) */}
{Object.keys(alvoAtivos).length === 0 && (
<div style={{background:"rgba(16,185,129,0.06)",border:"1px solid rgba(16,185
<div style={{display:"flex",gap:"10px",alignItems:"flex-start"}}>
<span style={{fontSize:"14px",color:"#10b981"}}> </span>
<div style={{flex:1}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#10b981",marginBotto
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.65)",lineHeight:
</div>
</div>
</div>
)}
{/* Grupos RF por indexador (só em RF) */}
{classe === "renda_fixa" && gruposRF && (
<div style={{marginBottom:"18px",padding:"12px",background:"rgba(59,130,246,0
<div style={{fontSize:"9px",fontWeight:700,color:"#60a5fa",textTransform:"u
{Object.keys(gruposRF).map(function(ix){
var g = gruposRF[ix];
var atE = mode === "carteira" ? g.atPctCarteira : g.atPctClasse;
var tgCarteiraTotal = Object.values(gruposRF).reduce(function(s,x){return
var tgE = mode === "carteira" ? g.tgPctCarteira : (tgCarteiraTotal > 0 ?
var gapEE = atE - tgE;
var gapClr = gapColorLocal(gapEE);
return <div key={ix} style={{display:"flex",justifyContent:"space-between
<span style={{color:"#f1f5f9",fontWeight:600}}>{INDEXADOR_LABELS_V2[ix]
<span style={{display:"flex",gap:"8px",alignItems:"baseline",fontVarian
<span style={{color:"rgba(255,255,255,0.85)",minWidth:"50px",textAlig
<span style={{color:"rgba(255,255,255,0.3)"}}>→</span>
<span style={{color:"rgba(255,255,255,0.5)",minWidth:"50px",textAlign
<span style={{color:gapClr,fontWeight:700,minWidth:"52px",textAlign:"
{Math.abs(gapEE) < 0.5 ? "●" : gapEE > 0 ? "▲" : "▼"} {Math.abs(gap
</span>
</span>
</div>;
})}
</div>
)}
{/* Tabela de ativos */}
<div style={{border:"1px solid rgba(255,255,255,0.05)",borderRadius:"8px",overf
<div style={{display:"grid",gridTemplateColumns:"minmax(0,1.8fr) minmax(0,0.9
<div>Ticker / Nome</div>
<div>Status / Subcl.</div>
<div style={{textAlign:"right"}} title="Preço médio do cliente, preço atual
<div style={{textAlign:"right"}} title="% atual na visão escolhida">Atual</
<div style={{textAlign:"right"}} title="% alvo na visão escolhida">Alvo</di
<div style={{textAlign:"right"}}>Gap</div>
</div>
{lista.length === 0 && <div style={{padding:"30px",textAlign:"center",color:"
{(function(){
function renderAsset(it) {
var hasTgt = it.tgEff > 0;
var gapClr = hasTgt ? gapColorLocal(it.gapEff) : "rgba(255,255,255,0.3)";
var statusBg = it.status === "core" ? "rgba(74,222,128,0.12)" : it.status
var statusClr = it.status === "core" ? "#4ade80" : it.status === "manter"
var statusLabels = {core:"Core",manter:"Manter",em_avaliacao:"Em aval.",r
return <div key={it.ticker} style={{display:"grid",gridTemplateColumns:"m
<div style={{minWidth:0}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#f1f5f9"}}>{it.tic
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.4)",whiteSpace:
</div>
<div style={{display:"flex",flexDirection:"column",gap:"2px"}}>
{it.status && <span style={{fontSize:"8px",padding:"1px 5px",borderRa
{it.subclasse && <span style={{fontSize:"8px",color:"rgba(255,255,255
{it.forayCarteira && <span style={{fontSize:"8px",color:"#fb923c"}}>f
{it.noAlvo && it.valor === 0 && <span style={{fontSize:"8px",color:"#
</div>
<div style={{textAlign:"right",fontVariantNumeric:"tabular-nums",lineHe
{(function(){
var perf = calcPerformanceAtivo({classe:it._classe,preco:it._preco,
if (!perf) return <span style={{color:"rgba(255,255,255,0.2)",fontS
if (perf.unsupported) return <span style={{color:"rgba(255,255,255,
var pCor = perf.diffPct >= 0 ? "#4ade80" : "#f87171";
var sinal = perf.diffPct >= 0 ? "+" : "";
var tip = "Médio: " + fmtMoneyAuto(perf.precoMedio, perf.moeda)
+ " - Atual: " + fmtMoneyAuto(perf.precoAtual, perf.moeda)
+ " - L/P: " + sinal + fmtMoneyAuto(perf.diffFinanceiro, pe
+ (perf.fxNote ? " - " + perf.fxNote : "");
return <div title={tip}>
<div style={{color:"rgba(255,255,255,0.6)",fontSize:"9px"}}>
{fmtMoneyAuto(perf.precoMedio, perf.moeda)} {String.fromCharCod
</div>
<div style={{color:pCor,fontSize:"10px",fontWeight:700}}>
{sinal}{perf.diffPct.toFixed(1)}% {String.fromCharCode(183)} {s
</div>
</div>;
})()}
</div>
<div style={{textAlign:"right",fontSize:"11px",color:"rgba(255,255,255,
<div style={{textAlign:"right",fontSize:"11px",color:"rgba(255,255,255,
<div style={{textAlign:"right",fontSize:"11px",color:gapClr,fontVariant
{hasTgt ? ((Math.abs(it.gapEff) < 0.5 ? "● " : it.gapEff > 0 ? "▲ " :
</div>
</div>;
}
// Se for RF, agrupa por indexador; senão lista linear
if (classe === "renda_fixa") {
console.log("[GapDetail V2] Agrupando RF por indexador. Total ativos:", l
var ordemIx = ["pos_fixado","ipca","prefixado","fundo_rf","indefinido"];
var porIx = {};
lista.forEach(function(it){
var ix = it.subclasse || "indefinido";
if (!porIx[ix]) porIx[ix] = [];
porIx[ix].push(it);
});
console.log("[GapDetail V2] Grupos:", Object.keys(porIx).map(function(ix)
Object.keys(porIx).forEach(function(ix){
porIx[ix].sort(function(a,b){ return (b.valor || 0) - (a.valor || 0); }
});
return ordemIx.filter(function(ix){ return porIx[ix] && porIx[ix].length
var grupo = porIx[ix];
var labelIx = ix === "indefinido" ? "Sem classificação" : (INDEXADOR_LA
return <div key={ix}>
<div style={{padding:"8px 12px",background:"rgba(59,130,246,0.06)",bo
<span style={{fontSize:"9px",fontWeight:700,color:"#60a5fa",textTra
<span style={{fontSize:"9px",color:"rgba(255,255,255,0.4)"}}>{grupo
</div>
{grupo.map(renderAsset)}
</div>;
});
} else {
return lista.map(renderAsset);
}
})()}
</div>
{/* Rodapé: totais */}
<div style={{marginTop:"12px",padding:"10px 14px",background:"rgba(0,0,0,0.3)",
<span>Total {classLabel}: <b style={{color:"#f1f5f9"}}>R$ {totalClasse.toLoca
<span>% da carteira: <b style={{color:"#f1f5f9"}}>{totalPatr > 0 ? ((totalCla
</div>
</div>
</div>
);
})()}
{showConsultorEditor && (
<ConsultorProfileEditor
profile={consultorProfile}
onClose={function(){ setShowConsultorEditor(false); }}
onSaved={function(updated){
setConsultorProfile(updated);
if (updated && updated.display_name) setConsultorName(updated.display_name);
setShowConsultorEditor(false);
}}
/>
)}
</div>
);
}
/* ═══════════════════════════════════════════
ConsultorProfileEditor — Modal pra editar perfil do consultor logado
(campos: nome de exibição, foto, bio, contatos, links — usados no PDF Suno oficial)
═══════════════════════════════════════════ */
function ConsultorProfileEditor(props) {
var initial = props.profile || {};
var [displayName, setDisplayName] = useState(initial.display_name || "");
var [bio, setBio] = useState(initial.bio || "Formado em Engenharia Civil pela Universidade
var [fotoUrl, setFotoUrl] = useState(initial.foto_url || "");
var [whatsappUrl, setWhatsappUrl] = useState(initial.whatsapp_url || "");
var [whatsappGestorUrl, setWhatsappGestorUrl] = useState(initial.whatsapp_gestor_url var [npsFormUrl, setNpsFormUrl] = useState(initial.nps_form_url || "");
var [calendlyUrl, setCalendlyUrl] = useState(initial.calendly_url || "");
var [linkedinUrl, setLinkedinUrl] = useState(initial.linkedin_url || "");
var [emailPublico, setEmailPublico] = useState(initial.email_publico || "");
var [telefonePublico, setTelefonePublico] = useState(initial.telefone_publico || "");
var [saving, setSaving] = useState(false);
var [errMsg, setErrMsg] = useState("");
|| "")
// Lê arquivo de imagem como data-URL
function onPhotoUpload(e) {
var file = e.target.files && e.target.files[0];
if (!file) return;
if (file.size > 1500 * 1024) {
setErrMsg("Foto muito grande (máx 1.5MB). Comprima antes de subir.");
return;
}
var reader = new FileReader();
reader.onload = function(ev){ setFotoUrl(ev.target.result); setErrMsg(""); };
reader.onerror = function(){ setErrMsg("Falha ao ler arquivo."); };
reader.readAsDataURL(file);
}
async function save() {
setErrMsg("");
setSaving(true);
try {
var uid = await getUserId();
if (!uid) { setErrMsg("Você precisa estar logado."); setSaving(false); return; }
var payload = {
display_name: displayName.trim(),
bio: bio.trim(),
foto_url: fotoUrl,
whatsapp_url: whatsappUrl.trim(),
whatsapp_gestor_url: whatsappGestorUrl.trim(),
nps_form_url: npsFormUrl.trim(),
calendly_url: calendlyUrl.trim(),
linkedin_url: linkedinUrl.trim(),
email_publico: emailPublico.trim(),
telefone_publico: telefonePublico.trim()
};
var res = await supabase.from("consultores").update(payload).eq("id", uid).select().sin
if (res.error) { setErrMsg("Erro ao salvar: " + res.error.message); setSaving(false); r
setSaving(false);
props.onSaved(res.data);
} catch (e) {
setErrMsg("Erro: " + (e.message || e));
setSaving(false);
}
}
var labelS = {fontSize:"10px",color:"rgba(255,255,255,0.5)",fontWeight:600,display:"block",
var inputS = {width:"100%",padding:"8px 10px",borderRadius:"6px",border:"1px solid rgba(255
var areaS = Object.assign({},inputS,{minHeight:"70px",resize:"vertical",lineHeight:1.5});
return (
<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",zIndex:2300,display:"
<div style={{background:"#0a0a0a",border:"1px solid rgba(255,255,255,0.08)",borderRadiu
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin
<div>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff"}}>Meu perfil de consulto
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginTop:"3px"}}>Esse
</div>
<button onClick={props.onClose} style={{background:"transparent",border:"none",colo
</div>
{errMsg && <div style={{padding:"8px 12px",background:"rgba(248,113,113,0.1)",border:
{/* ── DADOS PESSOAIS ── */}
<div style={{padding:"14px",background:"rgba(167,139,250,0.05)",border:"1px solid rgb
<div style={{fontSize:"10px",fontWeight:700,color:"#a78bfa",textTransform:"uppercas
<div style={{display:"grid",gridTemplateColumns:"160px 1fr",gap:"14px",alignItems:"
<div>
<label style={labelS}>Foto</label>
<div style={{width:"140px",height:"140px",borderRadius:"8px",background:fotoUrl
{fotoUrl
? <img src={fotoUrl} alt="" style={{width:"100%",height:"100%",objectFit:"c
: <span style={{color:"rgba(255,255,255,0.3)",fontSize:"10px"}}>Sem foto</s
}
</div>
<label style={{cursor:"pointer",display:"inline-block",padding:"5px 10px",backg
Subir foto
<input type="file" accept="image/jpeg,image/png" onChange={onPhotoUpload} sty
</label>
{fotoUrl && (
<button onClick={function(){ setFotoUrl(""); }} style={{marginLeft:"5px",padd
)}
</div>
<div>
<div style={{marginBottom:"10px"}}>
<label style={labelS}>Nome de exibição (aparece no PDF)</label>
<input value={displayName} onChange={function(e){setDisplayName(e.target.valu
</div>
<div>
<label style={labelS}>Bio (texto que aparece embaixo da foto)</label>
<textarea value={bio} onChange={function(e){setBio(e.target.value);}} placeho
</div>
</div>
</div>
</div>
{/* ── LINKS CLICÁVEIS ── */}
<div style={{padding:"14px",background:"rgba(74,222,128,0.04)",border:"1px solid rgba
<div style={{fontSize:"10px",fontWeight:700,color:"#4ade80",textTransform:"uppercas
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px"}}>
<div>
<label style={labelS}>WhatsApp pessoal (botão "Clique aqui!" Me contate)</label
<input value={whatsappUrl} onChange={function(e){setWhatsappUrl(e.target.value)
</div>
<div>
<label style={labelS}>WhatsApp gestor (Fale Conosco)</label>
<input value={whatsappGestorUrl} onChange={function(e){setWhatsappGestorUrl(e.t
</div>
<div>
<label style={labelS}>Formulário NPS (críticas e sugestões)</label>
<input value={npsFormUrl} onChange={function(e){setNpsFormUrl(e.target.value);}
</div>
<div>
<label style={labelS}>Agenda (Calendly / HubSpot meetings)</label>
<input value={calendlyUrl} onChange={function(e){setCalendlyUrl(e.target.value)
</div>
<div style={{gridColumn:"1 / -1"}}>
<label style={labelS}>LinkedIn</label>
<input value={linkedinUrl} onChange={function(e){setLinkedinUrl(e.target.value)
</div>
</div>
</div>
{/* ── CONTATO TEXTUAL ── */}
<div style={{padding:"14px",background:"rgba(96,165,250,0.04)",border:"1px solid rgba
<div style={{fontSize:"10px",fontWeight:700,color:"#60a5fa",textTransform:"uppercas
<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px"}}>
<div>
<label style={labelS}>Telefone público (vira tel: clicável)</label>
<input value={telefonePublico} onChange={function(e){setTelefonePublico(e.targe
</div>
<div>
<label style={labelS}>E-mail público (vira mailto: clicável)</label>
<input value={emailPublico} onChange={function(e){setEmailPublico(e.target.valu
</div>
</div>
</div>
<div style={{display:"flex",justifyContent:"flex-end",gap:"8px",paddingTop:"6px",bord
<button onClick={props.onClose} disabled={saving} style={{padding:"8px 16px",border
<button onClick={save} disabled={saving} style={{padding:"8px 18px",borderRadius:"7
</div>
</div>
</div>
);
}
/* ═══════════════════════════════════════════
AUTH: LoginScreen + AuthGate + AdminConsultoresPanel
═══════════════════════════════════════════ */
var ALLOWED_DOMAIN = "@suno.com.br";
function LoginScreen(props) {
var [mode, setMode] = useState("login"); // login | signup | forgot
var [email, setEmail] = useState("");
var [password, setPassword] = useState("");
var [nome, setNome] = useState("");
var [busy, setBusy] = useState(false);
var [msg, setMsg] = useState(null); // { type: "ok"|"err"|"info", text: "..." }
function handleSubmit(e) {
if (e && e.preventDefault) e.preventDefault();
setMsg(null);
var em = (email || "").trim().toLowerCase();
if (!em) return setMsg({ type: "err", text: "Informe seu email." });
if (mode === "signup") {
if (em.indexOf(ALLOWED_DOMAIN) < 0 || !em.endsWith(ALLOWED_DOMAIN)) {
return setMsg({ type: "err", text: "Apenas emails " + ALLOWED_DOMAIN + " são permitid
}
if (!password || password.length < 8) return setMsg({ type: "err", text: "A senha preci
if (!nome.trim()) return setMsg({ type: "err", text: "Informe seu nome completo." });
setBusy(true);
supabase.auth.signUp({
email: em,
password: password,
options: { data: { nome: nome.trim() } }
}).then(function(res) {
setBusy(false);
if (res.error) return setMsg({ type: "err", text: res.error.message || "Erro ao cadas
if (res.data && res.data.session) {
// Auto-logged in (email confirmation disabled in Supabase)
setMsg({ type: "ok", text: "Cadastro concluído! Entrando..." });
} else {
setMsg({ type: "info", text: "Cadastro criado. Verifique seu email para confirmar a
setMode("login");
}
}).catch(function(err) {
setBusy(false);
setMsg({ type: "err", text: err.message || "Erro ao cadastrar." });
});
return;
}
if (mode === "forgot") {
setBusy(true);
supabase.auth.resetPasswordForEmail(em, {
redirectTo: window.location.origin
}).then(function(res) {
setBusy(false);
if (res.error) return setMsg({ type: "err", text: res.error.message });
setMsg({ type: "ok", text: "Enviamos um link de redefinição para " + em + "." });
}).catch(function(err) {
setBusy(false);
setMsg({ type: "err", text: err.message || "Erro ao enviar email." });
});
return;
}
// login
if (!password) return setMsg({ type: "err", text: "Informe sua senha." });
setBusy(true);
supabase.auth.signInWithPassword({ email: em, password: password }).then(function(res) {
setBusy(false);
if (res.error) return setMsg({ type: "err", text: res.error.message || "Email ou }).catch(function(err) {
setBusy(false);
setMsg({ type: "err", text: err.message || "Erro ao entrar." });
});
senha
}
var inputStyle = {
width: "100%", boxSizing: "border-box",
padding: "12px 14px", borderRadius: "8px",
border: "1px solid rgba(255,255,255,0.1)",
background: "rgba(255,255,255,0.03)", color: "#e2e8f0",
fontSize: "13px", outline: "none", marginBottom: "10px"
};
var titles = { login: "Entrar", signup: "Criar conta", forgot: "Redefinir senha" };
return (
<div style={{minHeight:"100vh",background:"#09090b",color:"#e2e8f0",fontFamily:"system-ui
<div style={{width:"100%",maxWidth:"380px"}}>
<div style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"24px",justif
<div style={{width:"44px",height:"44px",borderRadius:"10px",background:"linear-grad
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeW
</div>
<div>
<h1 style={{margin:0,fontSize:"18px",fontWeight:800,color:"#fff"}}>Suno <span sty
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginTop:"2px"}}>Aces
</div>
</div>
<div style={{background:"#111",border:"1px solid rgba(255,255,255,0.06)",borderRadius
<div style={{fontSize:"14px",fontWeight:700,color:"#fff",marginBottom:"16px"}}>{tit
<form onSubmit={handleSubmit}>
{mode === "signup" && (
<input type="text" placeholder="Nome completo" value={nome} onChange={function(
)}
<input type="email" placeholder={"Email (" + ALLOWED_DOMAIN + ")"} value={email}
{mode !== "forgot" && (
<input type="password" placeholder={mode === "signup" ? "Senha (mín. 8 caracter
)}
{msg && (
<div style={{padding:"10px 12px",borderRadius:"7px",marginBottom:"10px",fontSiz
{msg.text}
</div>
)}
<button type="submit" disabled={busy} style={{width:"100%",padding:"12px",borderR
{busy ? "Aguarde..." : (mode === "login" ? "Entrar" : mode === "signup" ? "Cria
</button>
</form>
<div style={{marginTop:"16px",paddingTop:"14px",borderTop:"1px solid rgba(255,255,2
{mode === "login" && (
<>
<button type="button" onClick={function(){setMode("signup");setMsg(null);}} s
<button type="button" onClick={function(){setMode("forgot");setMsg(null);}} s
</>
)}
{mode !== "login" && (
<button type="button" onClick={function(){setMode("login");setMsg(null);}} styl
)}
</div>
</div>
<div style={{marginTop:"16px",textAlign:"center",fontSize:"10px",color:"rgba(255,255,
Cada consultor tem acesso apenas aos seus próprios clientes.<br/>
Research, carteiras e FIIs são compartilhados entre toda a equipe.
</div>
</div>
</div>
);
}
function AccessBlockedScreen(props) {
return (
<div style={{minHeight:"100vh",background:"#09090b",color:"#e2e8f0",fontFamily:"system-ui
<div style={{maxWidth:"380px",textAlign:"center"}}>
<div style={{fontSize:"36px",marginBottom:"14px"}}> </div>
<div style={{fontSize:"16px",fontWeight:700,color:"#fff",marginBottom:"8px"}}>Acesso
<div style={{fontSize:"12px",color:"rgba(255,255,255,0.5)",lineHeight:1.6,marginBotto
Sua conta foi desativada por um administrador. Entre em contato com Rafael para rea
</div>
</div>
</div>
<button onClick={function(){ supabase.auth.signOut(); }} style={{padding:"10px 22px",
);
}
function AdminConsultoresPanel() {
var [list, setList] = useState([]);
var [loading, setLoading] = useState(true);
var [err, setErr] = useState(null);
var [savingId, setSavingId] = useState(null);
function reload() {
setLoading(true);
supabase.from("consultores").select("*").order("created_at", { ascending: true }).then(fu
setLoading(false);
if (res.error) { setErr(res.error.message); return; }
setList(res.data || []);
});
}
useEffect(reload, []);
function toggleActive(c) {
setSavingId(c.id);
supabase.from("consultores").update({ ativo: !c.ativo }).eq("id", c.id).then(function(res
setSavingId(null);
if (res.error) { alert("Erro: " + res.error.message); return; }
reload();
});
}
function changeRole(c, newRole) {
if (!confirm("Alterar role de " + c.email + " para " + newRole + "?")) return;
setSavingId(c.id);
supabase.from("consultores").update({ role: newRole }).eq("id", c.id).then(function(res)
setSavingId(null);
if (res.error) { alert("Erro: " + res.error.message); return; }
reload();
});
}
return (
<div>
<div style={{fontSize:"18px",fontWeight:800,color:"#fff",marginBottom:"6px"}}>Consultor
<div style={{fontSize:"11px",color:"rgba(255,255,255,0.4)",marginBottom:"20px",lineHeig
Gerencie o acesso dos consultores ao Advisory Hub. Novos consultores entram pelo cada
</div>
{err && <div style={{padding:"10px 14px",background:"rgba(220,38,38,0.08)",border:"1px
{loading && <div style={{textAlign:"center",padding:"40px",color:"rgba(255,255,255,0.3)
{!loading && list.length === 0 && (
<div style={{textAlign:"center",padding:"40px",color:"rgba(255,255,255,0.3)",fontSize
)}
{!loading && list.map(function(c) {
var saving = savingId === c.id;
return (
<div key={c.id} style={{background:"#111",border:"1px solid rgba(255,255,255,0.05)"
<div style={{flex:1,minWidth:"200px"}}>
<div style={{display:"flex",alignItems:"center",gap:"8px"}}>
<span style={{fontWeight:700,fontSize:"13px",color:"#f1f5f9"}}>{c.nome || c.e
{c.role === "admin" && <span style={{fontSize:"9px",padding:"2px 7px",borderR
{!c.ativo && <span style={{fontSize:"9px",padding:"2px 7px",borderRadius:"10p
</div>
<div style={{fontSize:"11px",color:"rgba(255,255,255,0.4)",marginTop:"2px"}}>{c
<div style={{fontSize:"9px",color:"rgba(255,255,255,0.25)",marginTop:"2px"}}>Cr
</div>
<div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>
<button disabled={saving} onClick={function(){toggleActive(c);}} style={{paddin
{saving ? "..." : (c.ativo ? "Desativar" : "Ativar")}
</button>
{c.role === "consultor" ? (
<button disabled={saving} onClick={function(){changeRole(c, "admin");}} style
) : (
<button disabled={saving} onClick={function(){changeRole(c, "consultor");}} s
)}
</div>
</div>
);
})}
</div>
);
}
function AuthGate() {
var [session, setSession] = useState(null);
var [profile, setProfile] = useState(null);
var [loading, setLoading] = useState(true);
var [profileErr, setProfileErr] = useState(null);
// Subscribe to session changes
useEffect(function() {
var mounted = true;
supabase.auth.getSession().then(function(res) {
if (!mounted) return;
setSession(res.data && res.data.session ? res.data.session : null);
setLoading(false);
});
var sub = supabase.auth.onAuthStateChange(function(event, newSession) {
if (!mounted) return;
setSession(newSession || null);
if (!newSession) setProfile(null);
});
return function() {
mounted = false;
if (sub && sub.data && sub.data.subscription) sub.data.subscription.unsubscribe();
};
}, []);
// Load profile whenever session appears.
// If the profile is missing (e.g. trigger disabled by Supabase), call the
// provision_consultor RPC as a fallback. The RPC is idempotent.
var uid = session && session.user ? session.user.id : null;
useEffect(function() {
if (!uid) { setProfile(null); return; }
setProfileErr(null);
function fetchProfile(isRetry) {
supabase.from("consultores").select("*").eq("id", uid).single().then(function(res) {
if (!res.error) {
setProfile(res.data);
return;
}
// Profile not found — if this is the first attempt, try to auto-provision.
if (!isRetry) {
supabase.rpc("provision_consultor").then(function(rpc) {
if (rpc.error) {
setProfileErr(rpc.error.message);
setProfile(null);
return;
}
// RPC succeeded — it returns the consultor row directly.
if (rpc.data) {
setProfile(rpc.data);
} else {
// Fallback: re-query after RPC just in case.
fetchProfile(true);
}
});
} else {
setProfileErr(res.error.message);
setProfile(null);
}
});
}
fetchProfile(false);
}, [uid]);
function handleLogout() {
// Clear app-specific localStorage so the next user doesn't briefly see stale data
try {
["tt-v7","tt-v6","tt-clients","tt-macro","tt-carteiras-suno","suno-admin-unlock"].forEa
} catch(e) {}
supabase.auth.signOut();
}
if (loading) {
return <div style={{minHeight:"100vh",background:"#09090b",color:"rgba(255,255,255,0.3)",
}
if (!session) return <LoginScreen />;
if (profileErr && !profile) {
return (
<div style={{minHeight:"100vh",background:"#09090b",color:"#e2e8f0",fontFamily:"system-
<div style={{maxWidth:"420px",textAlign:"center"}}>
<div style={{fontSize:"36px",marginBottom:"14px"}}> </div>
<div style={{fontSize:"15px",fontWeight:700,color:"#fff",marginBottom:"8px"}}>Perfi
<div style={{fontSize:"11px",color:"rgba(255,255,255,0.5)",lineHeight:1.6,marginBot
Sua conta foi criada mas o perfil de consultor não foi provisionado. Isso costuma
</div>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.3)",fontFamily:"monospace",m
<button onClick={handleLogout} style={{padding:"10px 22px",borderRadius:"8px",borde
</div>
</div>
);
}
if (!profile) {
return <div style={{minHeight:"100vh",background:"#09090b",color:"rgba(255,255,255,0.3)",
}
if (!profile.ativo) return <AccessBlockedScreen />;
return <MainApp session={session} profile={profile} onLogout={handleLogout} />;
}
function MainApp(props) {
var [data,setData]=useState(function(){return makeData();});
var [tab,setTab]=useState("Dividendos");var [isub,setIsub]=useState("Dollar Income");
var [search,setSearch]=useState("");var [sf,setSf]=useState("all");
var [panel,setPanel]=useState(false);var [notif,setNotif]=useState(null);
var [revalLoad,setRevalLoad]=useState(false);var [revalProg,setRevalProg]=useState("");
// Navigation: pilar + page
var [pilar, setPilar] = useState("research"); // research, consultoria, clientes
var [page, setPage] = useState("teses"); // sub-pages
var [openDropdown, setOpenDropdown] = useState(null);
var [syncStatus, setSyncStatus] = useState("idle"); // idle, syncing, synced, error
var [cloudReady, setCloudReady] = useState(0); // increments when cloud data arrives, force
// Auth state — passed in via props from AuthGate. Every authenticated consultor
// has access to the Consulta IA feature. Only role='admin' sees the Consultores admin pane
var session = props.session;
var profile = props.profile; // { id, email, nome, role, ativo }
var isAdmin = profile && profile.role === "admin";
var adminMode = !!session; // any logged-in user sees advanced features (Consulta IA)
// Load: localStorage first (instant), then cloud (async override if newer).
// Depends on session.user.id — triggers only once we have an authenticated user.
// If cloud is empty but local has data, push local to cloud (initial migration per user).
var sessionUserId = session && session.user ? session.user.id : null;
useEffect(function(){
if (!sessionUserId) return; // wait for auth
// 1. Local load (instant) — note: client_profiles will be overwritten by the per-user cl
try{var s=localStorage.getItem("tt-v7");if(!s)s=localStorage.getItem("tt-v6");if(s)setDat
// 2. Cloud load (async)
setSyncStatus("syncing");
var loadCount = 0;
function checkDone() { loadCount++; if (loadCount >= 4) { setSyncStatus("synced"); setClo
loadFromCloud("app_data", "data").then(function(cloudData) {
if (cloudData && Object.keys(cloudData).length > 0 && (cloudData.Dividendos || cloudDat
setData(migrateData(cloudData));
try { localStorage.setItem("tt-v7", JSON.stringify(cloudData)); } catch(e) {}
console.log("[sync] loaded app_data from cloud");
} else {
// Cloud empty — push local data up
try { var local = localStorage.getItem("tt-v7"); if(local){ var ld=JSON.parse(local);
}
checkDone();
}).catch(function(err) { console.error("[sync] cloud load error:", err); setSyncStatus("e
loadFromCloud("client_profiles", "profiles").then(function(cp) {
if (cp && Array.isArray(cp) && cp.length > 0) {
try { localStorage.setItem("tt-clients", JSON.stringify(cp)); } catch(e) {}
console.log("[sync] loaded client_profiles from cloud (" + cp.length + " profiles)");
} else {
// Cloud empty — push local
try { var local = localStorage.getItem("tt-clients"); if(local){ var lp=JSON.parse(lo
}
checkDone();
}).catch(function(){ checkDone(); });
loadFromCloud("macro_data", "data").then(function(md) {
if (md && Object.keys(md).length > 0) {
try { localStorage.setItem("tt-macro", JSON.stringify(md)); } catch(e) {}
console.log("[sync] loaded macro_data from cloud");
} else {
try { var local = localStorage.getItem("tt-macro"); if(local){ var lm=JSON.parse(loca
}
checkDone();
}).catch(function(){ checkDone(); });
loadFromCloud("carteiras_data", "data").then(function(cd) {
if (cd && Object.keys(cd).length > 0) {
try { localStorage.setItem("tt-carteiras-suno", JSON.stringify(cd)); } catch(e) {}
console.log("[sync] loaded carteiras_data from cloud");
} else {
try { var local = localStorage.getItem("tt-carteiras-suno"); if(local){ var lc=JSON.p
}
checkDone();
}).catch(function(){ checkDone(); });
},[sessionUserId]);
// Save: localStorage + cloud (debounced)
useEffect(function(){
if (!sessionUserId) return;
try{localStorage.setItem("tt-v7",JSON.stringify(data));}catch(e){}
var hasContent = (data.Dividendos && data.Dividendos.length > 0) || (data.Valor && if (hasContent) {
syncToCloud("app_data", {data: data, updated_at: new Date().toISOString()});
data.V
}
},[data, sessionUserId]);
// Force sync: push ALL local data to cloud (manual trigger)
function forceSync() {
new Da
setSyncStatus("syncing");
notify("Sincronizando todos os dados...");
try {
var localData = localStorage.getItem("tt-v7");
if (localData) syncToCloud("app_data", {data: JSON.parse(localData), updated_at: var localClients = localStorage.getItem("tt-clients");
if (localClients) syncToCloud("client_profiles", {profiles: JSON.parse(localClients), u
var localMacro = localStorage.getItem("tt-macro");
if (localMacro) syncToCloud("macro_data", {data: JSON.parse(localMacro), updated_at: ne
var localCarteiras = localStorage.getItem("tt-carteiras-suno");
if (localCarteiras) syncToCloud("carteiras_data", {data: JSON.parse(localCarteiras), up
setTimeout(function(){ setSyncStatus("synced"); notify("Dados enviados para a nuvem!");
} catch(err) { console.error("[sync] force sync error:", err); setSyncStatus("error"); no
}
function notify(msg,type){setNotif({msg:msg,type:type||"ok"});setTimeout(function(){setNoti
function nav(p, pg) { setPilar(p); setPage(pg); setOpenDropdown(null); }
function handleAdd(entry,portfolio){setData(function(prev){var u={};Object.keys(prev).forEa
// Carteira "key" combina portfolio + subcarteira internacional. Formatos:
// // "Dividendos" | "Valor" | "Small Caps"
"Internacional:Dollar Income" | "Internacional:Hidden Value" | "Internacional:Great Co
function parsePortKey(key){
if(!key)return{port:"",sub:""};
var ix=key.indexOf(":");
if(ix<0)return{port:key,sub:""};
return{port:key.slice(0,ix),sub:key.slice(ix+1)};
}
function portKeyLabel(key){
var p=parsePortKey(key);
return p.sub?p.sub:p.port;
}
function isInternationalSub(key){return key&&key.indexOf("Internacional:")===0;}
// Verifica se um stock pertence à carteira (port + sub opcional). Para Internacional,
// confere por sub (preferindo intlSub explícito, caindo pra INTL_SUBS como fallback).
function stockMatchesKey(stock,key){
var p=parsePortKey(key);
if(p.port!=="Internacional")return true;
if(!p.sub)return true;
if(stock.intlSub)return stock.intlSub===p.sub;
var lst=(typeof INTL_SUBS!=="undefined"&&INTL_SUBS[p.sub])||[];
return lst.indexOf(stock.ticker)>=0;
}
// Localiza o stock numa carteira-key. Retorna { list, index } ou null.
function findStockInKey(dataObj,ticker,key){
var p=parsePortKey(key);
var list=dataObj[p.port]||[];
for(var i=0;i<list.length;i++){
if(list[i].ticker===ticker && stockMatchesKey(list[i],key))return{list:list,index:i};
}
return null;
}
function handleDel(ticker,fromKey){
var keyToUse=fromKey;
if(!keyToUse){
keyToUse=(tab==="Internacional"?"Internacional:"+isub:tab);
}
var p=parsePortKey(keyToUse);
setData(function(prev){
var u={};Object.keys(prev).forEach(function(k){u[k]=prev[k].slice();});
u[p.port]=(u[p.port]||[]).filter(function(s){
if(s.ticker!==ticker)return true;
return !stockMatchesKey(s,keyToUse);
});
return u;
});
notify(ticker+" excluído de "+portKeyLabel(keyToUse)+".");
}
function handleMove(ticker,fromKey,toKey){
if(!fromKey||!toKey||fromKey===toKey)return;
var fp=parsePortKey(fromKey);
var tp=parsePortKey(toKey);
setData(function(prev){
var u={};Object.keys(prev).forEach(function(k){u[k]=prev[k].slice();});
var srcList=u[fp.port]||[];
var srcIdx=-1;
for(var i=0;i<srcList.length;i++){
if(srcList[i].ticker===ticker && stockMatchesKey(srcList[i],fromKey)){srcIdx=i;break;
}
if(srcIdx<0)return prev;
var stock=srcList[srcIdx];
var cloned=JSON.parse(JSON.stringify(stock));
// CASO 1: mover entre subcarteiras Internacional — só troca o intlSub do registro.
if(fp.port==="Internacional"&&tp.port==="Internacional"){
srcList[srcIdx]=Object.assign({},stock,{intlSub:tp.sub,lastUpdated:new Date().toISOSt
u[fp.port]=srcList;
return u;
}
// Remove da origem
u[fp.port]=srcList.filter(function(s,ix){return ix!==srcIdx;});
// Ajusta intlSub conforme destino
if(tp.port==="Internacional"){
cloned.intlSub=tp.sub||cloned.intlSub||isub;
}else{
delete cloned.intlSub;
}
cloned.lastUpdated=new Date().toISOString().slice(0,10);
// Adiciona no destino — se já houver um registro do mesmo ticker que case com a var dstList=u[tp.port]||[];
var dstIdx=-1;
for(var j=0;j<dstList.length;j++){
if(dstList[j].ticker===ticker && stockMatchesKey(dstList[j],toKey)){dstIdx=j;break;}
key de
}
if(dstIdx>=0){
dstList[dstIdx]=mergeStock(dstList[dstIdx],cloned);
}else{
dstList.push(cloned);
}
u[tp.port]=dstList;
return u;
});
notify(ticker+" movido para "+portKeyLabel(toKey)+".");
}
function handleCopy(ticker,fromKey,toKey){
if(!fromKey||!toKey||fromKey===toKey)return;
var fp=parsePortKey(fromKey);
var tp=parsePortKey(toKey);
// Copiar entre subcarteiras Internacional é bloqueado (1 ticker por Internacional)
if(fp.port==="Internacional"&&tp.port==="Internacional"){
notify("Não é possível ter o mesmo ticker em 2 subcarteiras Internacional.","err");
return;
}
setData(function(prev){
var u={};Object.keys(prev).forEach(function(k){u[k]=prev[k].slice();});
var srcList=u[fp.port]||[];
var srcStock=null;
for(var i=0;i<srcList.length;i++){
if(srcList[i].ticker===ticker && stockMatchesKey(srcList[i],fromKey)){srcStock=srcLis
}
if(!srcStock)return prev;
var cloned=JSON.parse(JSON.stringify(srcStock));
if(tp.port==="Internacional"){
cloned.intlSub=tp.sub||cloned.intlSub||isub;
}else{
delete cloned.intlSub;
}
cloned.lastUpdated=new Date().toISOString().slice(0,10);
var dstList=u[tp.port]||[];
var dstIdx=-1;
for(var j=0;j<dstList.length;j++){
if(dstList[j].ticker===ticker && stockMatchesKey(dstList[j],toKey)){dstIdx=j;break;}
}
if(dstIdx>=0){
dstList[dstIdx]=mergeStock(dstList[dstIdx],cloned);
}else{
dstList.push(cloned);
}
u[tp.port]=dstList;
return u;
});
notify(ticker+" copiado para "+portKeyLabel(toKey)+".");
}
async function handleReeval() {
var portfolio = tab; var list = (data[portfolio] || []).slice();
if (list.length === 0) return;
setRevalLoad(true); setRevalProg("Preparando...");
var sys = 'Voce e um analista financeiro brasileiro. Para CADA ativo, avalie: 1) rankScor
var stocksSummary = list.map(function(s) { return {ticker:s.ticker,name:s.name,quarter:s.
var batchSize = 15; var results = [];
for (var b = 0; b < stocksSummary.length; b += batchSize) {
var batch = stocksSummary.slice(b, b + batchSize);
setRevalProg("Lote " + (Math.floor(b/batchSize)+1) + "...");
try {
var resp = await fetch("/api/anthropic", {method:"POST",headers:{"Content-Type":"appl
if (!resp.ok) throw new Error("API "+resp.status);
var d = await resp.json(); var raw = "";
for (var ci=0;ci<d.content.length;ci++){if(d.content[ci].text)raw+=d.content[ci].text
raw=raw.trim().replace(/```json\s*/g,"").replace(/```\s*/g,"");
var si=raw.indexOf("[");var ei=raw.lastIndexOf("]");
if(si>=0&&ei>si)raw=raw.slice(si,ei+1);
results=results.concat(JSON.parse(raw));
} catch(err){console.error(err);}
}
if (results.length > 0) {
setData(function(prev){var u={};Object.keys(prev).forEach(function(k){u[k]=prev[k].slic
for(var ri=0;ri<results.length;ri++){var r=results[ri];for(var pi=0;pi<pList.length;p
u[portfolio]=pList;return u;});
notify(results.length+" ativos reavaliados!");
}
setRevalLoad(false);setRevalProg("");
}
var stocks=(data[tab]||[]).filter(function(s){var mq=!search||s.ticker.toLowerCase().indexO
if(tab==="Internacional"){var subT=INTL_SUBS[isub]||[];stocks=stocks.filter(function(s){ret
var hasRanks=stocks.some(function(s){return typeof s.rankScore==="number";});
if(hasRanks)stocks=stocks.slice().sort(function(a,b){return(b.rankScore||0)-(a.rankScore||0
stocks=stocks.map(function(s,i){var c=Object.assign({},s);if(hasRanks)c._rank=i+1;return c;
var all=[].concat(data.Dividendos||[],data.Valor||[],data["Small Caps"]||[],data.Internacio
var stats=[{l:"Total",v:all.length,c:"#DC2626"},{l:"Positivos",v:all.filter(function(s){ret
// Pillar configs
var pillarItems = {
research: [{id:"teses",label:"Teses & Resultados"},{id:"carteiras",label:"Carteiras Suno"
consultoria: [{id:"recomendacoes",label:"Recomendações"},{id:"reuniao",label:"Preparo de
clientes: [{id:"perfis",label:"Perfis & JB"},{id:"panorama",label:"Panorama de Resultados
};
var pillarColors = {research:"#991b1b",consultoria:"#DC2626",clientes:"#ef4444"};
var pillarLabels = {research:"Research",consultoria:"Consultoria",clientes:"Clientes"};
return(
<div style={{minHeight:"100vh",background:"#09090b",color:"#e2e8f0",fontFamily:"system-ui
{notif&&<div style={{position:"fixed",top:"14px",right:"14px",zIndex:1000,padding:"10px
{/* ═══ HEADER ═══ */}
<div style={{padding:"10px 16px",borderBottom:"1px solid rgba(255,255,255,0.06)",backgr
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWr
<div style={{display:"flex",alignItems:"center",gap:"10px",cursor:"pointer",flexShr
<div style={{width:"32px",height:"32px",borderRadius:"8px",background:"linear-gra
<div style={{display:"flex",alignItems:"center",gap:"6px"}}><h1 style={{margin:0,
</div>
{/* Navigation pillars */}
<div style={{display:"flex",gap:"4px",flexWrap:"wrap",alignItems:"center"}}>
{["research","consultoria","clientes"].map(function(pKey){
var isActive = pilar === pKey;
var color = pillarColors[pKey];
var items = pillarItems[pKey];
var isOpen = openDropdown === pKey;
return <div key={pKey} style={{position:"relative"}}>
<button onClick={function(e){e.stopPropagation();setOpenDropdown(isOpen?null:
{pillarLabels[pKey]}
<span style={{fontSize:"8px",opacity:0.5}}>▾</span>
</button>
{isOpen&&<div style={{position:"absolute",top:"100%",left:0,marginTop:"4px",b
{items.map(function(item){
var itemActive = pilar===pKey && page===item.id;
return <button key={item.id} onClick={function(e){e.stopPropagation();nav
})}
</div>}
</div>;
})}
{/* User badge + logout */}
{profile && (
<div style={{display:"flex",alignItems:"center",gap:"8px",marginLeft:"10px",pad
<div style={{textAlign:"right",lineHeight:1.2}}>
<div style={{fontSize:"11px",fontWeight:700,color:"#e2e8f0"}}>{profile.nome
<div style={{fontSize:"9px",color:isAdmin?"#fbbf24":"rgba(255,255,255,0.35)
</div>
<button onClick={function(e){e.stopPropagation();if(props.onLogout)props.onLo
</div>
)}
</div>
</div>
</div>
{/* ═══ CONTENT ═══ */}
<div>
{/* RESEARCH > TESES */}
{pilar==="research"&&page==="teses"&&(<div>
<div style={{padding:"10px 16px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}
<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(60px, 1f
{panel&&<AddPanel onAdd={handleAdd} currentData={data}/>}
<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",ma
<div style={{display:"flex",gap:"2px",flexWrap:"wrap"}}>{["Visão Geral","Divide
var count;
if (t === "FIIs") {
// FIIs vem de carteirasData (não de data.FIIs)
count = 0;
try {
var cartsRaw = localStorage.getItem("tt-carteiras-suno");
if (cartsRaw) {
var cartsObj = JSON.parse(cartsRaw);
var cartList = cartsObj.carteiras || [];
var cartAtivos = cartsObj.ativos || {};
var fiiC = cartList.find(function(c){ return /fii|imobili/i.test(c.name
if (!fiiC) {
fiiC = cartList.find(function(c){
var ats = cartAtivos[c.id] || [];
return ats.length > 0 && ats.every(function(a){ return /11$/.test(a
});
}
if (fiiC) count = (cartAtivos[fiiC.id] || []).length;
}
} catch(e) { count = 0; }
} else {
count = (data[t] || []).length;
}
return <button key={t} onClick={function(){setTab(t);if(t==="Internacional")s
})}</div>
{isAdmin&&<button onClick={function(){setPanel(!panel);}} style={{padding:"6px
</div>
</div>
{tab==="Internacional"&&(<div style={{padding:"0 16px",background:"rgba(220,38,38,0
{tab!=="Visão Geral"&&tab!=="FIIs"&&(<div style={{padding:"8px 16px",display:"flex"
{revalProg&&<div style={{padding:"6px 24px"}}><div style={{fontSize:"10px",color:"#
<div style={{padding:"0 16px 24px"}}>{tab==="FIIs"&&<FIIsTab/>}{tab!=="FIIs"&&(tab==
{(function(){
var ranked=all.filter(function(s){return typeof s.rankScore==="number";}).slice
var top10=ranked.slice(0,10);var bottom10=ranked.slice(-10).reverse();
function findPort(ticker){var ports=["Dividendos","Valor","Small Caps","Interna
var rowS={display:"flex",alignItems:"center",justifyContent:"space-between",pad
var scCol=function(sc){return sc>=8?"#4ade80":sc>=5?"#fbbf24":"#f87171";};
function renderRow(s,i,isTop){var port=findPort(s.ticker);var sc=s.rankScore||0
return <div key={s.ticker} style={rowS}><div style={{display:"flex",alignItem
return <div>
<div style={{background:"#111",borderRadius:"12px",overflow:"hidden",border:"
<div style={{background:"#111",borderRadius:"12px",overflow:"hidden",border:"
</div>;
})()}
</div>):(<div>{stocks.length===0&&<div style={{textAlign:"center",padding:"40px 0",
var allKeys=["Dividendos","Valor","Small Caps","Internacional:Dollar Income","Int
var curKey=tab==="Internacional"?("Internacional:"+isub):tab;
var ei={};
allKeys.forEach(function(k){
if(k===curKey)return;
var ix=k.indexOf(":");
var port=ix<0?k:k.slice(0,ix);
var sub=ix<0?"":k.slice(ix+1);
var list=data[port]||[];
var found=list.some(function(x){
if(x.ticker!==s.ticker)return false;
if(port!=="Internacional")return true;
if(!sub)return true;
if(x.intlSub)return x.intlSub===sub;
var ils=(typeof INTL_SUBS!=="undefined"&&INTL_SUBS[sub])||[];
return ils.indexOf(x.ticker)>=0;
});
if(found)ei[k]=true;
});
return <StockCard key={s.ticker} stock={s} currentKey={curKey} allKeys={allKeys}
})}</div>))}</div>
</div>)}
{/* RESEARCH > CARTEIRAS (read-only para consultor; edição só admin) */}
{pilar==="research"&&page==="carteiras"&&<CarteirasModal key={cloudReady} onClose={fu
{/* RESEARCH > MACRO (admin-only) */}
{pilar==="research"&&page==="macro"&&isAdmin&&<MacroModal key={cloudReady} onClose={f
{pilar==="research"&&page==="fiis"&&isAdmin&&<FIIsPage key={cloudReady}/>}
{pilar==="research"&&page==="chat"&&isAdmin&&<div style={{padding:"24px"}}><AdvisorCh
{/* CONSULTORIA > RECOMENDAÇÕES */}
{pilar==="consultoria"&&page==="recomendacoes"&&<ConsultiveReportModal key={cloudRead
{/* CONSULTORIA > REUNIÃO */}
{pilar==="consultoria"&&page==="reuniao"&&<MeetingPrepModal key={cloudReady} data={da
{/* CLIENTES > PERFIS */}
{pilar==="clientes"&&page==="perfis"&&<ClientProfilesModal key={cloudReady} onClose={
{/* CLIENTES > PANORAMA */}
{pilar==="clientes"&&page==="panorama"&&<ReportModal key={cloudReady} data={data} onC
{/* CLIENTES > CONSULTORES (admin-only) */}
{pilar==="clientes"&&page==="consultores"&&isAdmin&&<div style={{padding:"24px"}}><Ad
{/* CLIENTES > CONFIG (admin-only) */}
{pilar==="clientes"&&page==="config"&&isAdmin&&(<div style={{padding:"24px"}}>
<div style={{fontSize:"16px",fontWeight:800,color:"#fff",marginBottom:"16px"}}>Conf
<div style={{marginBottom:"20px",background:"rgba(74,222,128,0.04)",border:"1px sol
<div style={{fontSize:"11px",fontWeight:700,color:"#4ade80",marginBottom:"8px"}}>
<div style={{fontSize:"10px",color:"rgba(255,255,255,0.4)",marginBottom:"10px",li
Os dados são sincronizados automaticamente com o Supabase. Acesse de qualquer d
</div>
<div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
<button onClick={function(){
setSyncStatus("syncing");
notify("Enviando todos os dados para a nuvem...");
var hasContent = data.Dividendos||data.Valor;
if(hasContent) syncToCloud("app_data", {data: data, updated_at: new Date().to
var cp = loadClientProfiles();
if(cp.length>0) syncToCloud("client_profiles", {profiles: cp, updated_at: new
var md = loadMacroData();
if(Object.keys(md).length>0) syncToCloud("macro_data", {data: md, updated_at:
var cd = loadCarteiras();
if(Object.keys(cd).length>0) syncToCloud("carteiras_data", {data: cd, updated
setTimeout(function(){setSyncStatus("synced");notify("Dados enviados para a n
}} style={{padding:"8px 16px",borderRadius:"8px",border:"1px solid rgba(74,222,
<button onClick={function(){
setSyncStatus("syncing");
notify("Baixando dados da nuvem...");
loadFromCloud("app_data","data").then(function(d){if(d&&(d.Dividendos||d.Valo
loadFromCloud("client_profiles","profiles").then(function(cp){if(cp&&cp.lengt
loadFromCloud("macro_data","data").then(function(md){if(md&&Object.keys(md).l
loadFromCloud("carteiras_data","data").then(function(cd){if(cd&&Object.keys(c
setTimeout(function(){setSyncStatus("synced");setCloudReady(function(c){retur
}} style={{padding:"8px 16px",borderRadius:"8px",border:"1px solid rgba(96,165,
</div>
<div style={{marginTop:"8px",fontSize:"9px",color:"rgba(255,255,255,0.25)"}}>Stat
</div>
<div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
<button onClick={forceSync} style={{padding:"8px 16px",borderRadius:"8px",border:
<button onClick={function(){if(confirm("Resetar dados?")){try{localStorage.remove
<button onClick={function(){var b=new Blob([JSON.stringify(data,null,2)],{type:"a
<label style={{padding:"8px 16px",borderRadius:"8px",border:"1px solid rgba(34,19
</div>
</div>)}
</div>
</div>
);
}
/* Root export: gate the whole app behind authentication. */
export default function App() {
return <AuthGate />;
}
