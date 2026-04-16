import { useState, useEffect } from "react";
import { supabase } from "./supabase";

/* ───── Constants ───── */
const STEPS = [
  { id: "pessoal", label: "Dados Pessoais" },
  { id: "conjugal", label: "Estado Civil" },
  { id: "filhos", label: "Filhos & Dependentes" },
  { id: "profissional", label: "Profissional" },
  { id: "financeiro", label: "Renda & Gastos" },
  { id: "patrimonio", label: "Patrimônio" },
  { id: "imoveis", label: "Imóveis" },
  { id: "offshore", label: "Offshore" },
  { id: "previdencia", label: "Previdência & Seguro" },
  { id: "societario", label: "Societário" },
  { id: "reuniao", label: "Reunião" },
];

const ESTADOS_CIVIS = [
  "Solteiro(a)",
  "Casado(a)",
  "União Estável",
  "Divorciado(a)",
  "Separado(a) judicialmente",
  "Viúvo(a)",
];

const REGIMES = [
  "Comunhão Parcial de Bens",
  "Comunhão Universal de Bens",
  "Separação Total de Bens",
  "Participação Final nos Aquestos",
];

const ESTADOS_BR = [
  "AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA",
  "PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"
];

// Estados civis que devem mostrar campos do cônjuge/companheiro
const COM_PARCEIRO = ["Casado(a)", "União Estável"];

const emptyForm = () => ({
  nome: "", data_nascimento: "", cidade: "", estado: "",
  estado_civil: "", nome_conjuge: "", regime_bens: "", nascimento_conjuge: "",
  conjuge_dependente: "",
  tem_filhos: "", filhos: [{ nome: "", idade: "", estudo: "", faculdade: "", tipo_faculdade: "", tempo_formatura: "", curso_exterior: "" }],
  outro_dependente: "", detalhes_dependente: "",
  atividade_profissional: "", modelo_trabalho: "", valor_pro_labore: "",
  contribui_inss: "", valor_aposentadoria: "", saldo_fgts: "", valor_fgts: "",
  renda_mensal: "", gasto_mensal: "", gasto_pessoal: "", aporte_mensal: "",
  patrimonio_investido: "",
  patrimonio_imobilizado: "", valor_imobilizado: "",
  quantidade_imoveis: "", imoveis: [{ descricao: "", valor: "", uso: "", pode_vender: "", estado: "" }],
  outros_bens: "", detalhes_bens: "", bens_liquidaveis: "",
  patrimonio_offshore: "", tipos_ativos_offshore: "", valor_offshore: "",
  imoveis_exterior: "", quantidade_imoveis_exterior: "", valor_imoveis_exterior: "",
  previdencia_privada: "", valor_previdencia: "", aporte_previdencia: "",
  seguro_vida: "", valor_cobertura: "", tempo_assistencia: "",
  participacao_societaria: "", percentual_participacao: "", valor_empresa: "",
  financiamento: "", valor_financiamento: "", seguro_financiamento: "",
  data_reuniao: "", consultor: "",
});

/* ───── Helpers ───── */
const fmt = (v) => {
  if (!v) return "—";
  if (typeof v === "string" && v.length === 10 && v.includes("-")) {
    const [y, m, d] = v.split("-");
    return `${d}/${m}/${y}`;
  }
  return v;
};
const currency = (v) => {
  if (!v) return "—";
  const n = parseFloat(String(v).replace(/[^\d.,\-]/g, "").replace(",", "."));
  if (isNaN(n)) return v;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
};

/* ═══════════════════════════════════════
   STABLE sub-components (outside main)
   ═══════════════════════════════════════ */

function FI({ label, value, onChange, type = "text", placeholder, textarea, options }) {
  return (
    <div className="fg">
      <label className="fl">{label}</label>
      {options ? (
        <select className="fi" value={value || ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">Selecione...</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : textarea ? (
        <textarea className="fi" placeholder={placeholder} value={value || ""} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="fi" type={type} placeholder={placeholder} value={value || ""} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function RG({ label, value, onChange, opts }) {
  return (
    <div className="fg">
      <label className="fl">{label}</label>
      <div className="rg">
        {opts.map((o) => (
          <button key={o} type="button" className={`rb ${value === o ? "sel" : ""}`} onClick={() => onChange(o)}>{o}</button>
        ))}
      </div>
    </div>
  );
}

function NB({ step, setStep, total, onSubmit, saving }) {
  return (
    <div className="bn">
      {step > 0 ? <button className="bt bs" onClick={() => setStep(step - 1)}>← Voltar</button> : <div />}
      {step < total - 1 ? (
        <button className="bt bp" onClick={() => setStep(step + 1)}>Próximo →</button>
      ) : (
        <button className="bt bsub" onClick={onSubmit} disabled={saving}>
          {saving ? "Enviando..." : "✓ Enviar Questionário"}
        </button>
      )}
    </div>
  );
}

function DR({ label, value, isCurrency }) {
  return (
    <div className="dr">
      <span className="dl">{label}</span>
      <span className="dv">{isCurrency ? currency(value) : fmt(value)}</span>
    </div>
  );
}

/* ───── Step Components ───── */

function StepPessoal({ form, set, step, setStep, onSubmit, saving }) {
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Dados Pessoais</h2>
      <p className="sd">Informações básicas para iniciarmos seu planejamento patrimonial.</p>
      <FI label="Nome completo" value={form.nome} onChange={(v) => set("nome", v)} placeholder="Seu nome completo" />
      <div className="fr"><FI label="Data de nascimento" value={form.data_nascimento} onChange={(v) => set("data_nascimento", v)} type="date" /><div /></div>
      <div className="fr">
        <FI label="Cidade" value={form.cidade} onChange={(v) => set("cidade", v)} placeholder="Ex: São Paulo" />
        <FI label="Estado" value={form.estado} onChange={(v) => set("estado", v)} options={ESTADOS_BR} />
      </div>
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepConjuge({ form, set, step, setStep, onSubmit, saving }) {
  const comParceiro = COM_PARCEIRO.includes(form.estado_civil);
  const labelParceiro = form.estado_civil === "União Estável" ? "companheiro(a)" : "cônjuge";

  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Estado Civil</h2>
      <p className="sd">Informações sobre seu estado civil e, se aplicável, cônjuge ou companheiro(a).</p>

      <FI
        label="Estado civil"
        value={form.estado_civil}
        onChange={(v) => set("estado_civil", v)}
        options={ESTADOS_CIVIS}
      />

      {comParceiro && <>
        <FI label={`Nome do(a) ${labelParceiro}`} value={form.nome_conjuge} onChange={(v) => set("nome_conjuge", v)} placeholder="Nome completo" />
        {form.estado_civil === "Casado(a)" && (
          <FI label="Regime de bens" value={form.regime_bens} onChange={(v) => set("regime_bens", v)} options={REGIMES} />
        )}
        <FI label={`Data de nascimento do(a) ${labelParceiro}`} value={form.nascimento_conjuge} onChange={(v) => set("nascimento_conjuge", v)} type="date" />
        <RG label={`Seu(sua) ${labelParceiro} depende financeiramente de você?`} value={form.conjuge_dependente} onChange={(v) => set("conjuge_dependente", v)} opts={["Sim", "Não"]} />
      </>}

      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepFilhos({ form, set, step, setStep, onSubmit, saving }) {
  const setChild = (idx, key, val) => { const a = [...form.filhos]; a[idx] = { ...a[idx], [key]: val }; set("filhos", a); };
  const addChild = () => set("filhos", [...form.filhos, { nome: "", idade: "", estudo: "", faculdade: "", tipo_faculdade: "", tempo_formatura: "", curso_exterior: "" }]);
  const removeChild = (i) => set("filhos", form.filhos.filter((_, idx) => idx !== i));
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Filhos & Dependentes</h2>
      <p className="sd">Informe sobre seus filhos e outros dependentes financeiros.</p>
      <RG label="Você tem filhos?" value={form.tem_filhos} onChange={(v) => set("tem_filhos", v)} opts={["Sim", "Não"]} />
      {form.tem_filhos === "Sim" && <>
        {form.filhos.map((f, i) => (
          <div key={i} className="cc">
            <div className="cch"><span className="cct">Filho(a) {i + 1}</span>{form.filhos.length > 1 && <button className="brm" onClick={() => removeChild(i)}>✕</button>}</div>
            <div className="fr">
              <FI label="Nome" value={f.nome} onChange={(v) => setChild(i, "nome", v)} placeholder="Nome" />
              <FI label="Idade" value={f.idade} onChange={(v) => setChild(i, "idade", v)} type="number" placeholder="Ex: 18" />
            </div>
            <FI label="Situação dos estudos" value={f.estudo} onChange={(v) => setChild(i, "estudo", v)} placeholder="Ex: Cursando faculdade..." />
            <div className="fr">
              <FI label="Faculdade" value={f.faculdade} onChange={(v) => setChild(i, "faculdade", v)} placeholder="Nome da instituição" />
              <div className="fg"><label className="fl">Pública ou Privada?</label><div className="rg">
                {["Pública", "Privada", "N/A"].map((o) => (<button key={o} type="button" className={`rb ${f.tipo_faculdade === o ? "sel" : ""}`} onClick={() => setChild(i, "tipo_faculdade", o)}>{o}</button>))}
              </div></div>
            </div>
            <div className="fr">
              <FI label="Tempo até se formar" value={f.tempo_formatura} onChange={(v) => setChild(i, "tempo_formatura", v)} placeholder="Ex: 2 anos" />
              <div className="fg"><label className="fl">Pretende estudar fora?</label><div className="rg">
                {["Sim", "Não", "Talvez"].map((o) => (<button key={o} type="button" className={`rb ${f.curso_exterior === o ? "sel" : ""}`} onClick={() => setChild(i, "curso_exterior", o)}>{o}</button>))}
              </div></div>
            </div>
          </div>
        ))}
        <button className="bad" onClick={addChild}>+ Adicionar filho(a)</button>
      </>}
      <div style={{ marginTop: 24 }}>
        <RG label="Possui outro dependente financeiro? (pais, irmãos)" value={form.outro_dependente} onChange={(v) => set("outro_dependente", v)} opts={["Sim", "Não"]} />
        {form.outro_dependente === "Sim" && <FI label="Detalhes" value={form.detalhes_dependente} onChange={(v) => set("detalhes_dependente", v)} textarea placeholder="Quem são, qual a situação..." />}
      </div>
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepProfissional({ form, set, step, setStep, onSubmit, saving }) {
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Profissional</h2>
      <p className="sd">Informações sobre sua atividade profissional e previdência.</p>
      <FI label="Atividade profissional" value={form.atividade_profissional} onChange={(v) => set("atividade_profissional", v)} placeholder="Descreva sua atividade" />
      <RG label="Modelo de trabalho" value={form.modelo_trabalho} onChange={(v) => set("modelo_trabalho", v)} opts={["CLT", "PJ (Pró-labore)", "Autônomo", "Servidor Público", "Outro"]} />
      {form.modelo_trabalho === "PJ (Pró-labore)" && <FI label="Valor do pró-labore (R$)" value={form.valor_pro_labore} onChange={(v) => set("valor_pro_labore", v)} placeholder="Ex: 30.000" />}
      <RG label="Contribui para o INSS?" value={form.contribui_inss} onChange={(v) => set("contribui_inss", v)} opts={["Sim", "Não"]} />
      <FI label="Valor estimado da aposentadoria (R$)" value={form.valor_aposentadoria} onChange={(v) => set("valor_aposentadoria", v)} placeholder="Ex: 7.500" />
      <RG label="Possui saldo no FGTS?" value={form.saldo_fgts} onChange={(v) => set("saldo_fgts", v)} opts={["Sim", "Não"]} />
      {form.saldo_fgts === "Sim" && <FI label="Valor do FGTS (R$)" value={form.valor_fgts} onChange={(v) => set("valor_fgts", v)} placeholder="Ex: 150.000" />}
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepFinanceiro({ form, set, step, setStep, onSubmit, saving }) {
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Renda & Gastos</h2>
      <p className="sd">Entender sua renda e gastos ajuda a dimensionar seu planejamento.</p>
      <div className="fr">
        <FI label="Renda mensal (R$)" value={form.renda_mensal} onChange={(v) => set("renda_mensal", v)} placeholder="Ex: 50.000" />
        <FI label="Gasto médio mensal (R$)" value={form.gasto_mensal} onChange={(v) => set("gasto_mensal", v)} placeholder="Ex: 25.000" />
      </div>
      <div className="fr">
        <FI label="Gasto pessoal (R$)" value={form.gasto_pessoal} onChange={(v) => set("gasto_pessoal", v)} placeholder="Ex: 10.000" />
        <FI label="Aporte mensal (R$)" value={form.aporte_mensal} onChange={(v) => set("aporte_mensal", v)} placeholder="Ex: 15.000" />
      </div>
      <FI label="Patrimônio total investido hoje (R$)" value={form.patrimonio_investido} onChange={(v) => set("patrimonio_investido", v)} placeholder="Ex: 2.000.000" />
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepPatrimonio({ form, set, step, setStep, onSubmit, saving }) {
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Patrimônio</h2>
      <p className="sd">Informações sobre patrimônio imobilizado e outros bens.</p>
      <RG label="Possui patrimônio imobilizado?" value={form.patrimonio_imobilizado} onChange={(v) => set("patrimonio_imobilizado", v)} opts={["Sim", "Não"]} />
      {form.patrimonio_imobilizado === "Sim" && <FI label="Valor total imobilizado (R$)" value={form.valor_imobilizado} onChange={(v) => set("valor_imobilizado", v)} placeholder="Ex: 3.000.000" />}
      <RG label="Possui outros bens? (carro, etc.)" value={form.outros_bens} onChange={(v) => set("outros_bens", v)} opts={["Sim", "Não"]} />
      {form.outros_bens === "Sim" && <>
        <FI label="Descreva os bens" value={form.detalhes_bens} onChange={(v) => set("detalhes_bens", v)} textarea placeholder="Ex: BMW X5 2024, R$ 500.000" />
        <RG label="Podem ser liquidados?" value={form.bens_liquidaveis} onChange={(v) => set("bens_liquidaveis", v)} opts={["Sim", "Parcialmente", "Não"]} />
      </>}
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepImoveis({ form, set, step, setStep, onSubmit, saving }) {
  const setIm = (idx, key, val) => { const a = [...form.imoveis]; a[idx] = { ...a[idx], [key]: val }; set("imoveis", a); };
  const addIm = () => set("imoveis", [...form.imoveis, { descricao: "", valor: "", uso: "", pode_vender: "", estado: "" }]);
  const rmIm = (i) => set("imoveis", form.imoveis.filter((_, idx) => idx !== i));
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Imóveis</h2>
      <p className="sd">Detalhe cada imóvel para a análise patrimonial.</p>
      <FI label="Quantidade de imóveis" value={form.quantidade_imoveis} onChange={(v) => set("quantidade_imoveis", v)} type="number" placeholder="Ex: 3" />
      {form.imoveis.map((im, i) => (
        <div key={i} className="cc">
          <div className="cch"><span className="cct">Imóvel {i + 1}</span>{form.imoveis.length > 1 && <button className="brm" onClick={() => rmIm(i)}>✕</button>}</div>
          <FI label="Descrição" value={im.descricao} onChange={(v) => setIm(i, "descricao", v)} placeholder="Ex: Apto 3 quartos, Batel" />
          <div className="fr">
            <FI label="Valor (R$)" value={im.valor} onChange={(v) => setIm(i, "valor", v)} placeholder="Ex: 1.500.000" />
            <FI label="Estado" value={im.estado} onChange={(v) => setIm(i, "estado", v)} options={ESTADOS_BR} />
          </div>
          <div className="fr">
            <div className="fg"><label className="fl">Uso</label><div className="rg">
              {["Particular", "Comercial", "Aluguel"].map((o) => (<button key={o} type="button" className={`rb ${im.uso === o ? "sel" : ""}`} onClick={() => setIm(i, "uso", o)}>{o}</button>))}
            </div></div>
            <div className="fg"><label className="fl">Pode vender?</label><div className="rg">
              {["Sim", "Não"].map((o) => (<button key={o} type="button" className={`rb ${im.pode_vender === o ? "sel" : ""}`} onClick={() => setIm(i, "pode_vender", o)}>{o}</button>))}
            </div></div>
          </div>
        </div>
      ))}
      <button className="bad" onClick={addIm}>+ Adicionar imóvel</button>
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepOffshore({ form, set, step, setStep, onSubmit, saving }) {
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Patrimônio Offshore</h2>
      <p className="sd">Ativos e imóveis no exterior.</p>
      <RG label="Possui patrimônio financeiro fora do Brasil?" value={form.patrimonio_offshore} onChange={(v) => set("patrimonio_offshore", v)} opts={["Sim", "Não"]} />
      {form.patrimonio_offshore === "Sim" && <>
        <FI label="Tipos de ativos" value={form.tipos_ativos_offshore} onChange={(v) => set("tipos_ativos_offshore", v)} textarea placeholder="Ex: ETFs, conta Avenue, bonds..." />
        <FI label="Valor offshore (R$)" value={form.valor_offshore} onChange={(v) => set("valor_offshore", v)} placeholder="Ex: 500.000" />
      </>}
      <RG label="Possui imóveis fora do Brasil?" value={form.imoveis_exterior} onChange={(v) => set("imoveis_exterior", v)} opts={["Sim", "Não"]} />
      {form.imoveis_exterior === "Sim" && <>
        <FI label="Quantidade" value={form.quantidade_imoveis_exterior} onChange={(v) => set("quantidade_imoveis_exterior", v)} type="number" placeholder="Ex: 1" />
        <FI label="Valor total (R$)" value={form.valor_imoveis_exterior} onChange={(v) => set("valor_imoveis_exterior", v)} placeholder="Ex: 2.000.000" />
      </>}
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepPrevidencia({ form, set, step, setStep, onSubmit, saving }) {
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Previdência & Seguro</h2>
      <p className="sd">Previdência privada e seguros de vida.</p>
      <RG label="Possui previdência privada?" value={form.previdencia_privada} onChange={(v) => set("previdencia_privada", v)} opts={["Sim", "Não"]} />
      {form.previdencia_privada === "Sim" && <FI label="Valor acumulado (R$)" value={form.valor_previdencia} onChange={(v) => set("valor_previdencia", v)} placeholder="Ex: 800.000" />}
      <FI label="Aporte mensal disposto a investir em previdência (R$)" value={form.aporte_previdencia} onChange={(v) => set("aporte_previdencia", v)} placeholder="Ex: 5.000" />
      <RG label="Já possui apólice de seguro de vida?" value={form.seguro_vida} onChange={(v) => set("seguro_vida", v)} opts={["Sim", "Não"]} />
      {form.seguro_vida === "Sim" && <FI label="Valor da cobertura (R$)" value={form.valor_cobertura} onChange={(v) => set("valor_cobertura", v)} placeholder="Ex: 3.000.000" />}
      <FI label="Tempo de assistência aos dependentes na sua ausência" value={form.tempo_assistencia} onChange={(v) => set("tempo_assistencia", v)} placeholder="Ex: Até filhos completarem 25 anos" />
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepSocietario({ form, set, step, setStep, onSubmit, saving }) {
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Participação Societária</h2>
      <p className="sd">Empresas e financiamentos.</p>
      <RG label="Possui participação societária?" value={form.participacao_societaria} onChange={(v) => set("participacao_societaria", v)} opts={["Sim", "Não"]} />
      {form.participacao_societaria === "Sim" && <div className="fr">
        <FI label="Percentual (%)" value={form.percentual_participacao} onChange={(v) => set("percentual_participacao", v)} placeholder="Ex: 60" />
        <FI label="Valor da empresa (R$)" value={form.valor_empresa} onChange={(v) => set("valor_empresa", v)} placeholder="Ex: 5.000.000" />
      </div>}
      <RG label="Possui financiamento ou empréstimos?" value={form.financiamento} onChange={(v) => set("financiamento", v)} opts={["Sim", "Não"]} />
      {form.financiamento === "Sim" && <>
        <FI label="Valor total (R$)" value={form.valor_financiamento} onChange={(v) => set("valor_financiamento", v)} placeholder="Ex: 1.000.000" />
        <RG label="Tem seguro?" value={form.seguro_financiamento} onChange={(v) => set("seguro_financiamento", v)} opts={["Sim", "Não"]} />
      </>}
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

function StepReuniao({ form, set, step, setStep, onSubmit, saving }) {
  return (
    <div className="sc">
      <div className="ra" /><h2 className="st">Dados da Reunião</h2>
      <p className="sd">Registro da consultoria.</p>
      <div className="fr">
        <FI label="Data da reunião" value={form.data_reuniao} onChange={(v) => set("data_reuniao", v)} type="date" />
        <FI label="Consultor responsável" value={form.consultor} onChange={(v) => set("consultor", v)} placeholder="Nome do consultor" />
      </div>
      <NB step={step} setStep={setStep} total={STEPS.length} onSubmit={onSubmit} saving={saving} />
    </div>
  );
}

/* ───── Dashboard Detail ───── */
function ResponseDetail({ r }) {
  const d = r.dados || {};
  const S = ({ title, children }) => (<div className="ds"><div className="dst">{title}</div>{children}</div>);
  // Compatibilidade: se registro antigo tiver `casado` em vez de `estado_civil`
  const estadoCivil = d.estado_civil || (d.casado === "Sim" ? "Casado(a)" : d.casado === "Não" ? "Solteiro(a)" : "");
  return (
    <div className="dg">
      <S title="Dados Pessoais">
        <DR label="Nome" value={d.nome} /><DR label="Nascimento" value={d.data_nascimento} />
        <DR label="Cidade/Estado" value={`${d.cidade || "—"}/${d.estado || "—"}`} />
      </S>
      <S title="Estado Civil">
        <DR label="Estado civil" value={estadoCivil} />
        {COM_PARCEIRO.includes(estadoCivil) && <>
          <DR label="Cônjuge/Companheiro(a)" value={d.nome_conjuge} />
          {estadoCivil === "Casado(a)" && <DR label="Regime" value={d.regime_bens} />}
          <DR label="Nascimento" value={d.nascimento_conjuge} />
          <DR label="Dependente financeiro?" value={d.conjuge_dependente} />
        </>}
      </S>
      <S title="Filhos">
        <DR label="Tem filhos?" value={d.tem_filhos} />
        {d.tem_filhos === "Sim" && d.filhos?.map((f, i) => (
          <div key={i} style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #E5E5E5" }}>
            <DR label={`Filho ${i + 1}`} value={`${f.nome || "—"} (${f.idade || "?"} anos)`} />
            <DR label="Estudos" value={f.estudo} />
            <DR label="Faculdade" value={`${f.faculdade || "—"} (${f.tipo_faculdade || "—"})`} />
          </div>
        ))}
        <DR label="Outros dependentes?" value={d.outro_dependente} />
        {d.outro_dependente === "Sim" && <DR label="Detalhes" value={d.detalhes_dependente} />}
      </S>
      <S title="Profissional">
        <DR label="Atividade" value={d.atividade_profissional} />
        <DR label="Modelo" value={d.modelo_trabalho} />
        {d.modelo_trabalho === "PJ (Pró-labore)" && <DR label="Pró-labore" value={d.valor_pro_labore} isCurrency />}
        <DR label="Contribui INSS?" value={d.contribui_inss} />
        <DR label="Aposentadoria estimada" value={d.valor_aposentadoria} isCurrency />
        <DR label="FGTS" value={d.saldo_fgts === "Sim" ? currency(d.valor_fgts) : "Não"} />
      </S>
      <S title="Renda & Gastos">
        <DR label="Renda mensal" value={d.renda_mensal} isCurrency />
        <DR label="Gasto mensal" value={d.gasto_mensal} isCurrency />
        <DR label="Gasto pessoal" value={d.gasto_pessoal} isCurrency />
        <DR label="Aporte mensal" value={d.aporte_mensal} isCurrency />
        <DR label="Patrimônio investido" value={d.patrimonio_investido} isCurrency />
      </S>
      <S title="Patrimônio Imobilizado">
        <DR label="Possui?" value={d.patrimonio_imobilizado} />
        {d.patrimonio_imobilizado === "Sim" && <DR label="Valor" value={d.valor_imobilizado} isCurrency />}
        <DR label="Outros bens?" value={d.outros_bens} />
        {d.outros_bens === "Sim" && <>
          <DR label="Detalhes" value={d.detalhes_bens} />
          <DR label="Liquidáveis?" value={d.bens_liquidaveis} />
        </>}
      </S>
      <S title="Imóveis">
        <DR label="Quantidade" value={d.quantidade_imoveis} />
        {d.imoveis?.map((im, i) => im.descricao && (
          <div key={i} style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #E5E5E5" }}>
            <DR label={`Imóvel ${i + 1}`} value={im.descricao} />
            <DR label="Valor" value={im.valor} isCurrency />
            <DR label="Estado" value={im.estado} />
            <DR label="Uso" value={im.uso} />
            <DR label="Pode vender?" value={im.pode_vender} />
          </div>
        ))}
      </S>
      <S title="Offshore">
        <DR label="Patrimônio offshore?" value={d.patrimonio_offshore} />
        {d.patrimonio_offshore === "Sim" && <>
          <DR label="Tipos" value={d.tipos_ativos_offshore} />
          <DR label="Valor" value={d.valor_offshore} isCurrency />
        </>}
        <DR label="Imóveis exterior?" value={d.imoveis_exterior} />
        {d.imoveis_exterior === "Sim" && <>
          <DR label="Quantidade" value={d.quantidade_imoveis_exterior} />
          <DR label="Valor" value={d.valor_imoveis_exterior} isCurrency />
        </>}
      </S>
      <S title="Previdência & Seguro">
        <DR label="Previdência privada?" value={d.previdencia_privada} />
        {d.previdencia_privada === "Sim" && <DR label="Valor acumulado" value={d.valor_previdencia} isCurrency />}
        <DR label="Aporte previdência" value={d.aporte_previdencia} isCurrency />
        <DR label="Seguro de vida?" value={d.seguro_vida} />
        {d.seguro_vida === "Sim" && <DR label="Cobertura" value={d.valor_cobertura} isCurrency />}
        <DR label="Tempo assistência" value={d.tempo_assistencia} />
      </S>
      <S title="Societário & Financiamentos">
        <DR label="Participação societária?" value={d.participacao_societaria} />
        {d.participacao_societaria === "Sim" && <>
          <DR label="Percentual" value={d.percentual_participacao ? `${d.percentual_participacao}%` : "—"} />
          <DR label="Valor da empresa" value={d.valor_empresa} isCurrency />
        </>}
        <DR label="Financiamento?" value={d.financiamento} />
        {d.financiamento === "Sim" && <>
          <DR label="Valor" value={d.valor_financiamento} isCurrency />
          <DR label="Seguro?" value={d.seguro_financiamento} />
        </>}
      </S>
      <S title="Reunião">
        <DR label="Data" value={d.data_reuniao} />
        <DR label="Consultor" value={d.consultor} />
      </S>
    </div>
  );
}

/* ═══════════════════════════════════════
   Main App
   ═══════════════════════════════════════ */
export default function App() {
  const [mode, setMode] = useState("form");
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(emptyForm());
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [responses, setResponses] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(false);

  // Auth state
  const [showAuth, setShowAuth] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [session, setSession] = useState(null);

  // Check existing session on mount
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => subscription.unsubscribe();
  }, []);

  /* ── Supabase: load responses (requires auth) ── */
  const loadResponses = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("questionarios")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) { console.error("Select error:", error.message); }
      else if (data) setResponses(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  /* ── Supabase: submit form (public, no auth needed) ── */
  const handleSubmit = async () => {
    setSaving(true);
    try {
      const payload = {
        nome: form.nome || "Sem nome",
        cidade: form.cidade || null,
        estado: form.estado || null,
        consultor: form.consultor || null,
        patrimonio_investido: form.patrimonio_investido || null,
        dados: form,
      };

      // Insert SEM .select() — anon não precisa ler de volta a linha,
      // apenas confirmar que salvou. Isso evita conflito com RLS de SELECT.
      let { data, error } = await supabase
        .from("questionarios")
        .insert(payload);

      // Se falhou por RLS e há sessão ativa, tenta deslogar e reenviar como anon
      if (error && error.message?.includes("row-level security")) {
        console.warn("RLS error detected, retrying as anon...");
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        if (currentSession) {
          await supabase.auth.signOut();
          const retry = await supabase
            .from("questionarios")
            .insert(payload);
          data = retry.data;
          error = retry.error;
        }
      }

      if (error) {
        console.error("=== ERRO DETALHADO DO SUPABASE ===");
        console.error("Message:", error.message);
        console.error("Code:", error.code);
        console.error("Details:", error.details);
        console.error("Hint:", error.hint);
        console.error("Full error:", JSON.stringify(error, null, 2));

        // Mensagem amigável para o usuário baseada no tipo de erro
        let userMsg = "Não foi possível enviar o questionário.";
        if (error.message?.includes("row-level security")) {
          userMsg += "\n\nO servidor está temporariamente indisponível. Por favor, tente novamente em alguns minutos ou entre em contato com seu consultor.";
        } else if (error.message?.includes("fetch") || error.message?.includes("network")) {
          userMsg += "\n\nProblema de conexão. Verifique sua internet e tente novamente.";
        } else {
          userMsg += "\n\nDetalhe técnico: " + error.message;
        }

        alert(userMsg);
        setSaving(false);
        return;
      }
      console.log("Inserido com sucesso:", data);
      setSubmitted(true);
    } catch (e) {
      console.error("Exception:", e);
      alert("Erro de conexão. Verifique sua internet e tente novamente.");
    }
    setSaving(false);
  };

  /* ── Supabase: delete (requires auth) ── */
  const handleDelete = async (id) => {
    try {
      const { error } = await supabase.from("questionarios").delete().eq("id", id);
      if (error) { alert("Erro ao excluir: " + error.message); return; }
      setResponses((prev) => prev.filter((r) => r.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (e) { console.error(e); }
  };

  /* ── Auth: login with Supabase Auth ── */
  const handleLogin = async () => {
    setAuthLoading(true);
    setAuthError("");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: authEmail,
        password: authPass,
      });
      if (error) {
        setAuthError("Email ou senha incorretos.");
        setAuthLoading(false);
        return;
      }
      setSession(data.session);
      setShowAuth(false);
      setAuthEmail("");
      setAuthPass("");
      setMode("dashboard");
      setTimeout(() => loadResponses(), 100);
    } catch (e) {
      setAuthError("Erro de conexão.");
      console.error(e);
    }
    setAuthLoading(false);
  };

  /* ── Auth: logout ── */
  const handleLogout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setMode("form");
    setResponses([]);
  };

  const set = (key, val) => setForm((p) => ({ ...p, [key]: val }));

  const handleDash = () => {
    if (session) { setMode("dashboard"); loadResponses(); return; }
    setShowAuth(true);
  };

  const reset = () => { setForm(emptyForm()); setStep(0); setSubmitted(false); };

  const sp = { form, set, step, setStep, onSubmit: handleSubmit, saving };
  const stepMap = [StepPessoal, StepConjuge, StepFilhos, StepProfissional, StepFinanceiro, StepPatrimonio, StepImoveis, StepOffshore, StepPrevidencia, StepSocietario, StepReuniao];
  const StepComp = stepMap[step];

  return (
    <div className="aw">
      {/* Header */}
      <div className="hd">
        <div className="hl">
          <div className="lm">S</div>
          <div><div className="ht">Suno Consultoria</div><div className="hs">Planejamento Patrimonial</div></div>
        </div>
        <div className="hr">
          <button className={`bm ${mode === "form" ? "act" : ""}`} onClick={() => setMode("form")}>Questionário</button>
          <button className={`bm ${mode === "dashboard" ? "act" : ""}`} onClick={handleDash}>
            {session ? "Consultor" : "Login Consultor"}
          </button>
          {session && (
            <button className="bm" onClick={handleLogout} title="Sair">Sair</button>
          )}
        </div>
      </div>

      {/* Auth Modal */}
      {showAuth && (
        <div className="mo" onClick={() => { setShowAuth(false); setAuthError(""); }}>
          <div className="mb" onClick={(e) => e.stopPropagation()}>
            <div className="lm" style={{ margin: "0 auto 16px", width: 48, height: 48, fontSize: 20 }}>S</div>
            <div className="mt">Área do Consultor</div>
            <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>Faça login para acessar as respostas dos clientes.</p>
            <div className="fg">
              <label className="fl">Email</label>
              <input className="fi" type="email" placeholder="seu@email.com" value={authEmail}
                onChange={(e) => { setAuthEmail(e.target.value); setAuthError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
            </div>
            <div className="fg">
              <label className="fl">Senha</label>
              <input className="fi" type="password" placeholder="Sua senha" value={authPass}
                onChange={(e) => { setAuthPass(e.target.value); setAuthError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
            </div>
            {authError && <div className="me">{authError}</div>}
            <button className="bt bp" style={{ width: "100%", marginTop: 16 }} onClick={handleLogin} disabled={authLoading}>
              {authLoading ? "Entrando..." : "Entrar"}
            </button>
          </div>
        </div>
      )}

      {/* ─── FORM MODE ─── */}
      {mode === "form" ? (
        !submitted ? (
          <>
            <div className="pbc">
              <div className="pt"><div className="pf" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
              <div className="ps">{STEPS.map((s, i) => (
                <button key={s.id} className={`sp ${i === step ? "act" : i < step ? "done" : ""}`}
                  onClick={() => i <= step && setStep(i)}>{s.label}</button>
              ))}</div>
            </div>
            <div className="mc"><StepComp {...sp} /></div>
          </>
        ) : (
          <div className="mc">
            <div className="sc" style={{ textAlign: "center", padding: "80px 24px" }}>
              <div className="si">✓</div>
              <h2 className="sut">Questionário Enviado!</h2>
              <p className="sud">Obrigado! Seu consultor Suno irá analisar as informações e entrar em contato em breve.</p>
              <button className="bt bp" style={{ marginTop: 24 }} onClick={reset}>Preencher Novo</button>
            </div>
          </div>
        )
      ) : (
        /* ─── DASHBOARD MODE ─── */
        <div className="dc">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
            <div>
              <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 24 }}>Respostas dos Clientes</h2>
              <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                {responses.length} questionário{responses.length !== 1 ? "s" : ""} recebido{responses.length !== 1 ? "s" : ""}
                {session?.user?.email && <span> · Logado como {session.user.email}</span>}
              </p>
            </div>
            <button className="bt bs" onClick={loadResponses} style={{ fontSize: 13, padding: "8px 16px" }}>
              {loading ? "Atualizando..." : "↻ Atualizar"}
            </button>
          </div>

          {loading && responses.length === 0 ? (
            <div className="sc" style={{ textAlign: "center", padding: "60px 24px" }}>
              <div className="spinner" />
              <p style={{ color: "#888" }}>Carregando respostas...</p>
            </div>
          ) : responses.length === 0 ? (
            <div className="sc" style={{ textAlign: "center", padding: "80px 24px" }}>
              <div className="ei">📋</div><h3 className="et">Nenhuma resposta ainda</h3>
              <p className="ed">Quando clientes preencherem, as respostas aparecerão aqui.</p>
            </div>
          ) : responses.map((r) => (
            <div key={r.id} className="rc">
              <div onClick={() => setExpandedId(expandedId === r.id ? null : r.id)} style={{ cursor: "pointer" }}>
                <div className="rh">
                  <div>
                    <div className="rn">{r.nome || "Sem nome"}</div>
                    <div className="rm">
                      <span>{r.cidade}/{r.estado}</span>
                      {r.consultor && <span>Consultor: {r.consultor}</span>}
                      {r.patrimonio_investido && <span>Patrimônio: {currency(r.patrimonio_investido)}</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="rd">{r.created_at ? new Date(r.created_at).toLocaleDateString("pt-BR") : "—"}</span>
                    <span style={{ fontSize: 18, color: "#888" }}>{expandedId === r.id ? "▲" : "▼"}</span>
                  </div>
                </div>
              </div>
              {expandedId === r.id && <>
                <ResponseDetail r={r} />
                <div style={{ marginTop: 16, textAlign: "right" }}>
                  <button className="bt bs" style={{ fontSize: 12, padding: "6px 16px", color: "#E8001C", borderColor: "#E8001C" }}
                    onClick={() => { if (confirm("Excluir esta resposta?")) handleDelete(r.id); }}>Excluir</button>
                </div>
              </>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
